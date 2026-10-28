// Runs the unofficial Edge TTS WebSocket in a plain Node process.
// Electron's BoringSSL handshake is rejected by the Edge CDN with HTTP 200,
// while the same headers succeed from Node's OpenSSL stack.
import { EdgeTTS } from 'node-edge-tts'

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk

let args
try {
  args = JSON.parse(input)
} catch {
  console.error('edge-worker: invalid JSON payload')
  process.exit(2)
}

const engine = new EdgeTTS({
  voice: args.voice,
  rate: args.rate,
  pitch: args.pitch,
  volume: args.volume,
  proxy: args.proxy || undefined,
  timeout: args.timeout ?? 120000,
})

try {
  await engine.ttsPromise(String(args.text ?? ''), String(args.output))
  process.stdout.write('ok')
} catch (error) {
  console.error(String(error?.message ?? error))
  process.exit(1)
}
