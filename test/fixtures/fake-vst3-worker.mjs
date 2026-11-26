#!/usr/bin/env node
// Fake VST3 worker for test/vst3-process.mjs. Speaks the same JSON-line
// protocol as engine/vst3_worker.py but renders nothing.
//
// The manager only forwards { plugin, notes, duration, out } to the worker, so
// the test drives failure modes through the plugin path:
//   ...\missing-plugin\...  -> result ok:false kind:load (bad plugin path)
//   ...\hang-plugin\...     -> never answers (manager must time out and kill)
//   ...\crash-plugin\...    -> exits mid-render (manager must recover)
import { writeFileSync } from 'node:fs'

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

// Noisy stderr before ready: with stderr inherited this must not pollute
// stdout and must not deadlock when the manager never reads it.
process.stderr.write('fake-vst3-worker: noisy stderr is fine\n')
write({ type: 'ready', sampleRate: 48000 })

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
    if (msg.op === 'shutdown') process.exit(0)
    if (msg.op !== 'render') {
      write({ type: 'result', id: msg.id, ok: false, kind: 'param', error: `未知 op：${msg.op}` })
      continue
    }
    const plugin = String(msg.plugin || '')
    if (plugin.includes('crash-plugin')) process.exit(1)
    if (plugin.includes('hang-plugin')) continue
    if (plugin.includes('missing-plugin')) {
      write({ type: 'result', id: msg.id, ok: false, kind: 'load', error: `VST3 加载失败：${plugin}` })
      continue
    }
    // Echo `out` back so the test proves UTF-8 bytes survived the pipe.
    if (msg.out) writeFileSync(msg.out, 'FAKEWAV', 'utf8')
    write({
      type: 'result', id: msg.id, ok: true, peak: 0.79, seconds: msg.duration, out: msg.out,
      // Echo `preset` too: the manager must forward it verbatim and must not
      // invent the field when the caller did not pass one.
      ...(msg.preset === undefined ? {} : { preset: msg.preset }),
      // Same for the expression curve.
      ...(msg.ccs === undefined ? {} : { ccs: msg.ccs }),
    })
  }
})
