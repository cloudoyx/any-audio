#!/usr/bin/env node
/**
 * Build one installable sound pack from a folder of audio.
 *
 * This is a one-off tool, not a pack editor: it transcodes, measures and writes
 * a manifest, then stops. There is no wizard, no GUI and no incremental update —
 * those would be a different product.
 *
 * Two inputs are accepted, because the two packs this version ships have
 * different shapes:
 *
 *   --src <folder>   scan FOL/ AMB/ DSN/ and take the file name as the sound name
 *   --src <list.json> read a list of { name, type, source } entries
 *
 * The folder mode is what a person with their own recordings uses: the name is
 * already in the file name, and asking them to write a JSON list first would be
 * a second job. The list mode is for a curated pack where the name differs from
 * the source file.
 *
 * Usage:
 *   node scripts/build-sfx-pack.mjs --src D:\AnyAudioSFX --out D:\build --id BaseSFX --name 基础音效包 --license CC0-1.0
 *   node scripts/build-sfx-pack.mjs --src list.json --out D:\build --id MyPack
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeChannels } from '../src/audio/peaks.js'
import { findFfmpeg } from '../src/tools/shared.js'

const TYPES = ['foley', 'ambience', 'dsn']
const TYPE_DIRS = { foley: 'FOL', ambience: 'AMB', dsn: 'DSN' }
const DIR_TYPES = { FOL: 'foley', AMB: 'ambience', DSN: 'dsn' }
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aif', '.aiff'])
const SAMPLE_RATE = 48000
const CHANNELS = 2
const BITRATE = '128k'
const FRAME_SEC = 0.02

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      index++
    }
  }
  return args
}

function run(command, argv) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
}

/** Decode one file to mono float samples at the waveform rate. */
function decodeMono(command, file, sampleRate = 32000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ac', '1', '-ar', String(sampleRate),
      '-',
    ], { windowsHide: true })
    const chunks = []
    let stderr = ''
    child.stdout?.on('data', (chunk) => chunks.push(chunk))
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`could not decode ${file}: ${stderr.trim().split('\n').slice(-2).join(' | ')}`))
        return
      }
      const buffer = Buffer.concat(chunks)
      const count = Math.floor(buffer.length / 2)
      const samples = new Float32Array(count)
      for (let index = 0; index < count; index++) samples[index] = buffer.readInt16LE(index * 2) / 32768
      resolvePromise({ samples, sampleRate })
    })
  })
}

/**
 * The main peak position: the centre of the 20 ms frame with the highest RMS.
 *
 * A single loudest sample would land on one click inside a hit; the frame
 * envelope puts the mark where the energy is, which is what a person means by
 * "the peak of this sound".
 */
function peakPositionSec(samples, sampleRate) {
  const frame = Math.max(1, Math.round(FRAME_SEC * sampleRate))
  let best = -1
  let bestAt = 0
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(samples.length, start + frame)
    let sum = 0
    for (let index = start; index < end; index++) sum += samples[index] * samples[index]
    const rms = Math.sqrt(sum / Math.max(1, end - start))
    if (rms > best) {
      best = rms
      bestAt = start + (end - start) / 2
    }
  }
  return bestAt / sampleRate
}

/** Loudness and true peak, for the report only. */
async function measureLoudness(command, file) {
  let stderr = ''
  try {
    const result = await run(command, [
      '-hide_banner', '-nostats',
      '-i', file,
      '-map', '0:a:0',
      '-af', 'ebur128=peak=true:framelog=quiet',
      '-f', 'null', '-',
    ])
    stderr = result.stderr
  } catch (error) {
    stderr = String(error.message)
  }
  // The stream log also prints a `TPK:` line; anchoring on the summary block's
  // `Peak:` is what keeps the true peak from being read off the wrong line.
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  const lufs = /I:\s*(-?[\d.]+)\s*LUFS/.exec(summary)
  const peak = /Peak:\s*(-?[\d.]+)\s*dBFS/.exec(summary)
  return {
    lufs: lufs ? Number(lufs[1]) : null,
    truePeakDb: peak ? Number(peak[1]) : null,
  }
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Read the source list, or scan a folder. */
async function collectSources(src) {
  const info = await stat(src)
  if (info.isDirectory()) {
    const entries = []
    for (const [dirName, type] of Object.entries(DIR_TYPES)) {
      const dir = join(src, dirName)
      let files
      try {
        files = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile()) continue
        if (!AUDIO_EXTENSIONS.has(extname(file.name).toLowerCase())) continue
        entries.push({
          name: basename(file.name, extname(file.name)),
          type,
          source: join(dir, file.name),
        })
      }
    }
    return { mode: 'directory', entries }
  }
  const parsed = JSON.parse(await readFile(src, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('the source list must be a JSON array')
  return {
    mode: 'list',
    entries: parsed.map((entry) => ({
      name: String(entry.name ?? ''),
      type: String(entry.type ?? ''),
      source: String(entry.source ?? ''),
    })),
  }
}

function validateName(name) {
  if (!name) return 'the name is empty'
  if (name.includes('/')) return 'the name must not contain "/"'
  if (name !== name.trim()) return 'the name must not start or end with whitespace'
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.src) throw new Error('--src is required (a folder, or a JSON source list)')
  if (!args.out) throw new Error('--out is required (where the pack directory is written)')

  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new Error('ffmpeg not found; set ANYAUDIO_FFMPEG or add ffmpeg to PATH')

  const src = resolve(String(args.src))
  const outRoot = resolve(String(args.out))
  const { mode, entries } = await collectSources(src)
  const packId = String(args.id ?? (mode === 'directory' ? basename(src) : '')).trim()
  if (!packId) throw new Error('--id is required when the source is a list')
  if (packId.includes('/')) throw new Error('--id must not contain "/"')

  const packDir = join(outRoot, packId)
  await rm(packDir, { recursive: true, force: true })
  await mkdir(packDir, { recursive: true })

  const report = []
  const errors = []
  const warnings = []
  const sounds = []
  const seen = new Set()
  const loudnessByType = new Map()

  report.push(`pack: ${packId}`)
  report.push(`source: ${src} (${mode} mode)`)
  report.push(`entries: ${entries.length}`)
  report.push('')

  for (const [index, entry] of entries.entries()) {
    const label = `[${index + 1}/${entries.length}] ${entry.name || '(no name)'}`
    const nameProblem = validateName(entry.name)
    if (nameProblem) {
      errors.push(`${label}: ${nameProblem}`)
      continue
    }
    if (seen.has(entry.name)) {
      errors.push(`${label}: duplicate name`)
      continue
    }
    if (!TYPES.includes(entry.type)) {
      errors.push(`${label}: unknown type "${entry.type}" (expected ${TYPES.join(' / ')})`)
      continue
    }
    if (!existsSync(entry.source)) {
      errors.push(`${label}: source file not found: ${entry.source}`)
      continue
    }
    if (!entry.name.includes('-')) {
      warnings.push(`${label}: the name has no "-" segment; it still works, it just reads worse`)
    }

    const typeDir = TYPE_DIRS[entry.type]
    const targetDir = join(packDir, typeDir)
    await mkdir(targetDir, { recursive: true })
    const target = join(targetDir, `${entry.name}.mp3`)

    try {
      await run(ffmpeg.command, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', entry.source,
        '-vn',
        '-ac', String(CHANNELS),
        '-ar', String(SAMPLE_RATE),
        '-b:a', BITRATE,
        '-c:a', 'libmp3lame',
        target,
      ])
    } catch (error) {
      errors.push(`${label}: transcode failed: ${error.message}`)
      continue
    }

    // Measure the file that will actually ship, not the source: MP3 encoding
    // adds a pre-echo and a delay, so the two disagree by a few milliseconds.
    const decoded = await decodeMono(ffmpeg.command, target)
    const durationSec = decoded.samples.length / decoded.sampleRate
    const peakPosSec = peakPositionSec(decoded.samples, decoded.sampleRate)
    const analysis = analyzeChannels([decoded.samples], durationSec)

    const loudness = durationSec < 0.4
      // ebur128 needs a 400 ms integration block; below that it reports −70,
      // which is a measurement failure, not a quiet sound.
      ? { lufs: null, truePeakDb: null, skipped: true }
      : await measureLoudness(ffmpeg.command, target)

    if (!loudnessByType.has(entry.type)) loudnessByType.set(entry.type, [])
    if (Number.isFinite(loudness.lufs)) loudnessByType.get(entry.type).push(loudness.lufs)

    seen.add(entry.name)
    sounds.push({
      name: entry.name,
      type: entry.type,
      durationSec: Number(durationSec.toFixed(3)),
      ...(entry.type === 'ambience' ? {} : { peakPosSec: Number(peakPosSec.toFixed(3)) }),
      file: `${typeDir}/${entry.name}.mp3`,
    })

    report.push(`${label}`)
    report.push(`  file: ${typeDir}/${entry.name}.mp3`)
    report.push(`  duration: ${durationSec.toFixed(3)}s  peakPos: ${peakPosSec.toFixed(3)}s  peak: ${analysis.peakDb?.toFixed(1) ?? 'n/a'} dBFS`)
    report.push(`  lufs: ${loudness.skipped ? 'skipped (<0.4s)' : loudness.lufs ?? 'n/a'}  truePeak: ${loudness.truePeakDb ?? 'n/a'} dBFS`)
  }

  // Loudness outliers, per type: a sound 20 dB below its family is usually a
  // bad recording rather than a quiet one, and the report is where a person
  // finds that out.
  report.push('')
  report.push('loudness outliers (20 dB below the family median):')
  let outliers = 0
  for (const [type, values] of loudnessByType) {
    const middle = median(values)
    if (middle === null) continue
    for (const sound of sounds.filter((entry) => entry.type === type)) {
      const row = report.find((line) => line.includes(`file: ${sound.file}`))
      if (!row) continue
      const match = /lufs: (-?[\d.]+)/.exec(report[report.indexOf(row) + 2] ?? '')
      if (!match) continue
      const lufs = Number(match[1])
      if (Number.isFinite(lufs) && lufs < middle - 20) {
        report.push(`  ${sound.name}: ${lufs} LUFS (family median ${middle.toFixed(1)})`)
        outliers++
      }
    }
  }
  if (outliers === 0) report.push('  none')

  report.push('')
  report.push('clipping (true peak above -0.1 dBFS):')
  const clipping = sounds.filter((sound) => {
    const row = report.find((line) => line.includes(`file: ${sound.file}`))
    if (!row) return false
    const match = /truePeak: (-?[\d.]+)/.exec(report[report.indexOf(row) + 2] ?? '')
    return match && Number(match[1]) > -0.1
  })
  for (const sound of clipping) report.push(`  ${sound.name}`)
  if (clipping.length === 0) report.push('  none')

  if (errors.length > 0) {
    report.push('')
    report.push(`errors (${errors.length}):`)
    for (const error of errors) report.push(`  ${error}`)
  }
  if (warnings.length > 0) {
    report.push('')
    report.push(`warnings (${warnings.length}):`)
    for (const warning of warnings) report.push(`  ${warning}`)
  }

  if (errors.length > 0) {
    await writeFile(join(outRoot, 'build-report.txt'), `${report.join('\n')}\n`, 'utf8')
    console.error(report.join('\n'))
    throw new Error(`${errors.length} entr${errors.length === 1 ? 'y' : 'ies'} could not be packed; see build-report.txt`)
  }

  sounds.sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.name.localeCompare(b.name))
  const manifest = {
    schemaVersion: 1,
    id: packId,
    name: String(args.name ?? packId),
    version: String(args.version ?? '1.0.0'),
    license: String(args.license ?? ''),
    format: 'mp3',
    sounds,
  }
  await writeFile(join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(join(outRoot, 'build-report.txt'), `${report.join('\n')}\n`, 'utf8')

  console.log(`packed ${sounds.length} sound(s) into ${packDir}`)
  console.log(`report: ${join(outRoot, 'build-report.txt')}`)
  if (warnings.length > 0) console.log(`${warnings.length} warning(s) — see the report`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
