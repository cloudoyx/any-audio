#!/usr/bin/env node
// Fake singing worker for test/singing-process.mjs. Speaks the same line
// protocol as engine/worker.py but does no inference. Arguments after the
// script are passed verbatim so the test can assert device switching.
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const device = args[args.length - 1] || 'cpu'
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

// Emit one noisy stderr line: with stderr inherited it must not pollute stdout
// and must not deadlock even when the manager never reads it.
process.stderr.write('fake-worker: noisy stderr is fine\n')
write({ type: 'ready', voicebank: 'fake', sampleRate: 44100, device })

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.op === 'shutdown') { process.exit(0) }
    if (msg.op === 'sing') {
      if (msg.fail) {
        write({ type: 'result', id: msg.id, ok: false, kind: msg.failKind || 'infer', error: msg.fail })
      } else {
        // Echo the lyric back so the test proves UTF-8 bytes survived the pipe.
        if (msg.out) writeFileSync(msg.out, 'FAKEWAV', 'utf8')
        write({
          type: 'result', id: msg.id, ok: true,
          seconds: 1.23, notes: (msg.notes || []).length,
          lyric: (msg.notes || []).map((n) => n[3]).join('|'),
          device,
        })
      }
    }
  }
})
