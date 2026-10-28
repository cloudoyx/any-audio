import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EdgeTTS } from 'node-edge-tts'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { parseWav, resample } from './wav.js'
import { findFfmpeg, runFfmpeg } from '../tools/shared.js'

export const EDGE_VOICES = [
  'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunyangNeural',
  'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-GuyNeural',
  'ja-JP-NanamiNeural',
]

/** Built-in MiMo voices; the service also accepts custom/cloned voice ids. */
export const MIMO_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe']

export const TTS_PROVIDERS = {
  edge: {
    id: 'edge',
    label: 'Edge TTS',
    requiresKey: false,
    default: true,
    voiceLabel: 'Edge 语音',
    note: '非官方接口，需要网络；中文旁白推荐。MP3 需 ffmpeg 转 WAV。',
    voices: EDGE_VOICES,
  },
  mimo: {
    id: 'mimo',
    label: 'MiMo-V2.5-TTS',
    requiresKey: true,
    credentialRef: 'MIMO_API_KEY',
    voiceLabel: 'MiMo 音色',
    note: '小米开放平台普通 API Key（Open Platform Key），不是 Token Plan。默认音色 mimo_default 由服务端集群决定，不同集群可能不同。限时免费，随时可能调整。',
    voices: MIMO_VOICES,
  },
}

export function providerInfo(id) {
  return TTS_PROVIDERS[id] ?? null
}

function percent(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value >= 0 ? '+' : ''}${value}%`
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return fallback
  return /^[+-]/.test(raw) ? raw : `+${raw}`
}

function hertz(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value >= 0 ? '+' : ''}${value}Hz`
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return fallback
  if (/[a-z]/i.test(raw)) return raw
  return `${Number(raw) >= 0 ? '+' : ''}${raw}Hz`
}

const EDGE_TIMEOUT_MS = 45000

function withTimeout(promise, ms, message) {
  let timer
  return new Promise((resolvePromise, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

const EDGE_WORKER = fileURLToPath(new URL('./edge-worker.mjs', import.meta.url))
const WORKER_TIMEOUT_MS = 150000
let nodeRuntime

function probeNode(command) {
  const result = spawnSync(command, ['-e', 'process.stdout.write(process.version)'], {
    timeout: 8000,
    windowsHide: true,
    encoding: 'utf8',
  })
  return result.status === 0 && /^v\d+/.test(result.stdout ?? '')
}

/**
 * Edge TTS must run on Node's OpenSSL stack: the Edge CDN answers Electron's
 * BoringSSL handshake with an empty HTTP 200. This finds a plain node binary.
 */
export function findNodeRuntime() {
  if (nodeRuntime !== undefined) return nodeRuntime
  const candidates = []
  if (process.env.ANYAUDIO_NODE) candidates.push(process.env.ANYAUDIO_NODE)
  if (process.env.DSH_DESKTOP_NODE_EXECUTABLE) candidates.push(process.env.DSH_DESKTOP_NODE_EXECUTABLE)
  if (process.execPath) {
    candidates.push(join(
      dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    ))
  }
  candidates.push(process.platform === 'win32' ? 'node.exe' : 'node')
  nodeRuntime = candidates.find(probeNode) ?? null
  return nodeRuntime
}

function runEdgeWorker(payload, output) {
  const runtime = findNodeRuntime()
  if (!runtime) {
    return Promise.reject(new Error('Edge TTS inside the desktop app needs a plain Node runtime. Set ANYAUDIO_NODE to a node executable and retry, or switch the narration engine to MiMo in Settings -> AnyAudio.'))
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(runtime, [EDGE_WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`Edge TTS stopped answering (the worker returned nothing within ${Math.round(WORKER_TIMEOUT_MS / 1000)}s).`))
    }, WORKER_TIMEOUT_MS)
    timer.unref?.()
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolvePromise()
    }
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += String(chunk)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code === 0) finish()
      else finish(new Error(stderr.trim() || `Edge TTS worker exited with code ${code}`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ ...payload, output }))
  })
}

function describeEdgeError(error) {
  const message = String(error?.message ?? error)
  if (/429|too many requests|rate limit/i.test(message)) {
    return new Error('Edge TTS is rate limiting this machine right now (HTTP 429). Wait a minute and retry, or switch the narration engine to MiMo in Settings -> AnyAudio.')
  }
  if (/unexpected server response:?\s*200|http\s*200/i.test(message)) {
    return new Error('Edge TTS was refused by the service (its WebSocket handshake returned HTTP 200, usually a network filter or throttling). Retry later, set a proxy in Settings -> AnyAudio, or switch the narration engine to MiMo.')
  }
  if (/did not answer within|stopped answering/i.test(message)) {
    return new Error('Edge TTS stopped answering in time. The unofficial endpoint may be throttling this network; retry later, set a proxy, or switch the narration engine to MiMo in Settings -> AnyAudio.')
  }
  return error instanceof Error ? error : new Error(message)
}

async function edgeInProcess(payload, output, signal) {
  const tts = new EdgeTTS({
    voice: payload.voice,
    rate: payload.rate,
    pitch: payload.pitch,
    volume: payload.volume,
    proxy: payload.proxy,
    timeout: 60000,
  })
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await withTimeout(
        tts.ttsPromise(payload.text, output),
        EDGE_TIMEOUT_MS,
        `Edge TTS did not answer within ${Math.round(EDGE_TIMEOUT_MS / 1000)}s`,
      )
      return
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw error
      const message = String(error?.message ?? error)
      const retryable = /429|too many requests|rate limit|unexpected server response|econnreset|econnrefused|etimedout|timed? ?out|network|socket/i.test(message)
      if (!retryable) break
      if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200 * (attempt + 1)))
    }
  }
  throw lastError
}

async function synthesizeEdge({ text, voice, rate, pitch, volume, proxy, sampleRate, signal }) {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) {
    throw new Error('Edge TTS produces MP3 and needs ffmpeg to convert it to WAV. Install ffmpeg or set ANYAUDIO_FFMPEG / FFMPEG_PATH.')
  }
  const targetRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
  const temporaryDir = join(process.env.TEMP ?? process.env.TMP ?? '.', 'anyaudio-tts')
  await mkdir(temporaryDir, { recursive: true })
  const stamp = `${process.pid}-${Date.now()}`
  const mp3 = join(temporaryDir, `edge-${stamp}.mp3`)
  const wav = join(temporaryDir, `edge-${stamp}.wav`)
  const spokenVoice = voice ?? 'zh-CN-YunjianNeural'
  const payload = {
    text,
    voice: spokenVoice,
    rate: percent(rate, '+0%'),
    pitch: hertz(pitch, '+0Hz'),
    volume: percent(volume, '+0%'),
    proxy: proxy || undefined,
    timeout: 120000,
  }
  let usedWorker = false
  try {
    if (process.versions.electron) {
      await runEdgeWorker(payload, mp3).catch((error) => {
        throw describeEdgeError(error)
      })
      usedWorker = true
    } else {
      try {
        await edgeInProcess(payload, mp3, signal)
      } catch (error) {
        if (/unexpected server response:?\s*200/i.test(String(error?.message ?? error)) && findNodeRuntime()) {
          await runEdgeWorker(payload, mp3).catch((workerError) => {
            throw describeEdgeError(workerError)
          })
          usedWorker = true
        } else {
          throw describeEdgeError(error)
        }
      }
    }
    if (signal?.aborted) throw new Error('aborted')
    await runFfmpeg(ffmpeg.command, ['-y', '-hide_banner', '-loglevel', 'error', '-i', mp3, '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeoutMs: 180000 })
    const parsed = parseWav(await readFile(wav))
    if (!parsed.channels[0]?.length || parsed.frames < parsed.sampleRate * 0.05) {
      throw new Error('Edge TTS returned an empty audio stream. Retry, or switch the narration engine to MiMo in Settings -> AnyAudio.')
    }
    const mono = resample([parsed.channels[0]], parsed.sampleRate, targetRate)[0]
    if (!mono?.length) throw new Error('Edge TTS returned silence after resampling. Retry, or switch the narration engine to MiMo in Settings -> AnyAudio.')
    return { channels: [mono], sampleRate: targetRate, producedAt: parsed.sampleRate, provider: 'edge', voice: spokenVoice, usedWorker }
  } finally {
    await unlink(mp3).catch(() => {})
    await unlink(wav).catch(() => {})
  }
}

export function buildMimoRequest({ text, voice, model, style, format = 'wav' }) {
  const messages = []
  if (style && style.trim()) messages.push({ role: 'user', content: style.trim() })
  messages.push({ role: 'assistant', content: text })
  return {
    model: model ?? 'mimo-v2.5-tts',
    messages,
    audio: { format, voice: voice ?? 'mimo_default' },
    stream: false,
  }
}

/**
 * Speak HTTP directly instead of going through the process-wide fetch.
 * DSH installs undici's global dispatcher from the launch environment, so a
 * desktop proxy (or a network middlebox) can rewrite an otherwise valid MiMo
 * request. node:https bypasses that dispatcher; when the user names a proxy we
 * use it explicitly for this request only.
 */
function requestMimoJson({ url, body, apiKey, timeoutMs, signal, proxy }) {
  const target = new URL(url)
  const secure = target.protocol === 'https:'
  const transport = secure ? https : http
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          'api-key': apiKey,
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', reject)
      },
    )
    request.on('timeout', () => request.destroy(new Error(`MiMo TTS timed out after ${Math.round(timeoutMs / 1000)}s`)))
    request.on('error', reject)
    if (signal) {
      if (signal.aborted) {
        request.destroy(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true })
    }
    request.end(payload)
  })
}

export function parseMimoResponse(json) {
  const data = json?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || !data) {
    const reason = json?.error?.message ?? json?.message ?? 'response has no audio data'
    throw new Error(`MiMo TTS returned no audio: ${reason}`)
  }
  return Buffer.from(data, 'base64')
}

async function synthesizeMimo({ text, voice, model, style, baseUrl, apiKey, proxy, timeoutSec, sampleRate, signal, fetchImpl }) {
  if (!apiKey) {
    throw new Error('MiMo TTS needs an API key. Save one in Settings → AnyAudio (stored in the DSH credential store) or set MIMO_API_KEY.')
  }
  const url = `${(baseUrl ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')}/chat/completions`
  const timeoutMs = Math.max(10, timeoutSec ?? 120) * 1000
  const body = buildMimoRequest({ text, voice, model, style })
  let status = 0
  let raw = ''
  try {
    if (fetchImpl) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('MiMo TTS timed out')), timeoutMs)
      const onAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        status = response.status
        raw = await response.text()
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    } else {
      const response = await requestMimoJson({ url, body, apiKey, timeoutMs, signal, proxy: proxy || undefined })
      status = response.status
      raw = response.text
    }
  } catch (error) {
    throw new Error(`MiMo TTS request failed: ${error instanceof Error ? error.message : String(error)}. Check the network and the API base URL.`)
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    json = null
  }
  if (status < 200 || status >= 300) {
    const message = json?.error?.message ?? json?.message ?? raw.slice(0, 300)
    if (status === 401 || status === 403) {
      throw new Error(`MiMo rejected the API key (HTTP ${status}). Use a normal Open Platform API key; Token Plan keys are not supported. ${message}`)
    }
    if (status === 429) throw new Error(`MiMo rate limit reached (HTTP 429). Wait a moment and retry. ${message}`)
    if (status === 400 && /param/i.test(message)) {
      throw new Error(
        `MiMo TTS failed with HTTP 400: ${message}. The request body and key are known-good; a 400 like this usually means the network path rewrote the request (a proxy, DNS hijack or TLS interception). Check the proxy/VPN in use, or set a proxy for MiMo in Settings -> AnyAudio.`,
      )
    }
    throw new Error(`MiMo TTS failed with HTTP ${status}: ${message}`)
  }
  const audio = parseMimoResponse(json)
  const parsed = parseWav(audio)
  if (!parsed.channels[0]?.length || parsed.frames < parsed.sampleRate * 0.05) {
    throw new Error('MiMo TTS returned an empty audio stream. Retry, or switch the narration engine to Edge in Settings -> AnyAudio.')
  }
  const mono = resample([parsed.channels[0]], parsed.sampleRate, Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000)[0]
  if (!mono?.length) throw new Error('MiMo TTS returned silence after resampling. Retry, or switch the narration engine to Edge in Settings -> AnyAudio.')
  return { channels: [mono], sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000, producedAt: parsed.sampleRate, provider: 'mimo', voice: voice ?? 'mimo_default' }
}

/**
 * Synthesize narration with the selected provider. Returns mono Float32 audio
 * at the requested sample rate; callers write it into a WAV.
 */
export async function synthesizeSpeech(options) {
  const provider = options.provider ?? 'edge'
  if (provider === 'edge') return synthesizeEdge(options)
  if (provider === 'mimo') return synthesizeMimo(options)
  throw new Error(`unknown TTS provider "${provider}"; use ${Object.keys(TTS_PROVIDERS).join(' or ')}`)
}
