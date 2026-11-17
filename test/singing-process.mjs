#!/usr/bin/env node
/**
 * Singing process lifecycle tests (plan M1 acceptance).
 * Run: node test/singing-process.mjs
 *
 * Uses an injected fake worker (test/fixtures/fake-singing-worker.mjs) speaking
 * the same line protocol, so lifecycle/pipe/encoding/error behaviour is tested
 * without a 1 GB runtime. A separate optional block exercises the real venv
 * worker when ANYAUDIO_SINGING_TEST_VENV is set.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createSingingProcess, resolveSingingConfig, DEFAULT_IDLE_SEC,
} from '../src/audio/singing-process.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const FAKE_WORKER = join(here, 'fixtures', 'fake-singing-worker.mjs')
const NODE = process.execPath
const TEMP_TASK = { notes: [[0, 0.5, 60, '长']], out: join(here, '.singing-test-out.wav'), maxSeconds: 5 }

function fakeOptions(extra = {}) {
  return {
    command: NODE,
    args: [FAKE_WORKER, 'fake-bank', 'cpu'],
    voicebank: 'fake-bank',
    device: 'cpu',
    ...extra,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tests = []
function test(name, fn) { tests.push([name, fn]) }

// ---------------------------------------------------------------------------
test('config defaults: 60s idle, inherited stderr, UTF-8 pipe protocol constants', () => {
  assert.equal(DEFAULT_IDLE_SEC, 60)
  const state = createSingingProcess(fakeOptions()).getState()
  assert.deepEqual(state.stdio, ['pipe', 'pipe', 'inherit'], 'stderr must be inherited, never piped')
  assert.equal(state.running, false)
  const cfg = resolveSingingConfig(fakeOptions({ idleMs: 250, device: 'cuda' }))
  assert.equal(cfg.device, 'cuda')
  assert.equal(cfg.idleMs, 250)
  assert.equal(cfg.injected, true)
})

test('on-demand start + reuse: two sings share one process', async () => {
  const mgr = createSingingProcess(fakeOptions())
  try {
    const a = await mgr.sing({ ...TEMP_TASK, out: TEMP_TASK.out + '.a' })
    assert.equal(a.ok !== false, true)
    assert.equal(a.notes, 1)
    assert.equal(mgr.getState().starts, 1)
    assert.equal(mgr.getState().running, true)
    const b = await mgr.sing({ ...TEMP_TASK, out: TEMP_TASK.out + '.b' })
    assert.equal(b.seconds, 1.23)
    assert.equal(mgr.getState().starts, 1, 'second sing must reuse the process')
  } finally {
    await mgr.stop()
  }
})

test('Chinese lyrics survive the pipe as UTF-8 bytes (no BOM, no mojibake)', async () => {
  const mgr = createSingingProcess(fakeOptions())
  try {
    const lyric = '长亭外，银行'
    const res = await mgr.sing({
      notes: [[0, 0.5, 60, '长'], [0.5, 0.5, 62, '亭'], [1, 0.5, 64, '外'], [1.5, 0.5, 65, '银行']],
      out: TEMP_TASK.out + '.cn',
    })
    assert.equal(res.lyric, '长|亭|外|银行', 'echoed lyric must be byte-identical to the input')
    assert.ok(!res.lyric.includes('\uFFFD'), 'no replacement characters')
    assert.ok(!res.lyric.startsWith('\uFEFF'), 'no BOM')
  } finally {
    await mgr.stop()
  }
})

test('stderr is inherited and noisy stderr does not deadlock the worker', async () => {
  const mgr = createSingingProcess(fakeOptions())
  try {
    // The fake worker writes to stderr before ready. With stderr inherited
    // (stdio[2]='inherit') it cannot fill a pipe buffer and block the worker.
    const res = await Promise.race([
      mgr.sing(TEMP_TASK),
      sleep(2000).then(() => { throw new Error('worker deadlocked on stderr') }),
    ])
    assert.equal(res.seconds, 1.23)
  } finally {
    await mgr.stop()
  }
})

test('idle exit after idleSec, then restart on next sing', async () => {
  const mgr = createSingingProcess(fakeOptions({ idleMs: 200 }))
  try {
    await mgr.sing(TEMP_TASK)
    assert.equal(mgr.getState().running, true)
    assert.equal(mgr.getState().idleArmed, true)
    await sleep(600) // > idleMs
    assert.equal(mgr.getState().running, false, 'worker must exit when idle')
    await mgr.sing(TEMP_TASK)
    assert.equal(mgr.getState().starts, 2, 'next sing must start a fresh process')
    assert.equal(mgr.getState().running, true)
  } finally {
    await mgr.stop()
  }
})

test('device change recycles the process (never GPU then CPU in one process)', async () => {
  const mgr = createSingingProcess(fakeOptions({ idleMs: 5000 }))
  try {
    await mgr.sing(TEMP_TASK, { device: 'cuda' })
    assert.equal(mgr.getState().running, true)
    assert.equal(mgr.getState().starts, 1)
    await mgr.sing(TEMP_TASK, { device: 'cpu' })
    assert.equal(mgr.getState().recycles, 1, 'device switch must recycle')
    assert.equal(mgr.getState().starts, 2, 'a new process is started after recycle')
  } finally {
    await mgr.stop()
  }
})

test('param error from worker maps to kind=param / code BAD_REQUEST', async () => {
  const mgr = createSingingProcess(fakeOptions())
  try {
    await assert.rejects(
      mgr.sing({ ...TEMP_TASK, fail: 'bad lyric', failKind: 'param' }),
      (err) => err.code === 'BAD_REQUEST' && err.kind === 'param' && /bad lyric/.test(err.message),
    )
  } finally {
    await mgr.stop()
  }
})

test('infer error from worker maps to kind=infer / code INFER_FAILED', async () => {
  const mgr = createSingingProcess(fakeOptions())
  try {
    await assert.rejects(
      mgr.sing({ ...TEMP_TASK, fail: 'vocoder crashed' }),
      (err) => err.code === 'INFER_FAILED' && err.kind === 'infer' && /vocoder/.test(err.message),
    )
  } finally {
    await mgr.stop()
  }
})

test('bad notes are rejected before any process is spawned', async () => {
  const mgr = createSingingProcess(fakeOptions())
  try {
    await assert.rejects(mgr.sing({ notes: [], out: TEMP_TASK.out }), (err) => err.code === 'BAD_NOTES' && err.kind === 'param')
    await assert.rejects(mgr.sing({ notes: TEMP_TASK.notes }), (err) => err.code === 'BAD_OUTPUT')
    assert.equal(mgr.getState().starts, 0, 'validation must not spawn a worker')
  } finally {
    await mgr.stop()
  }
})

test('missing runtime / voicebank surfaces explicit, actionable errors', async () => {
  const missingPython = join(here, 'definitely-not-a-runtime', 'python.exe')
  const m1 = createSingingProcess({ python: missingPython, voicebank: join(here, 'no-bank') })
  await assert.rejects(m1.ensureReady(), (err) => err.code === 'ENV_MISSING' && /Settings/.test(err.message))

  const m2 = createSingingProcess({ python: NODE, voicebank: join(here, 'definitely-no-voicebank') })
  await assert.rejects(m2.ensureReady(), (err) => err.code === 'VOICEBANK_MISSING' && /voicebank/i.test(err.message))
})

// Optional: real venv end-to-end, enabled by the test operator.
const REAL_VENV = process.env.ANYAUDIO_SINGING_TEST_VENV
if (REAL_VENV && existsSync(REAL_VENV)) {
  test('REAL worker end-to-end via venv (start → sing → result → stop)', async () => {
    const python = join(REAL_VENV, process.platform === 'win32' ? 'Scripts' : 'bin', 'python.exe')
    const bank = process.env.ANYAUDIO_SINGING_TEST_BANK
    if (!bank || !existsSync(bank)) {
      throw new Error('set ANYAUDIO_SINGING_TEST_BANK to a real voicebank directory')
    }
    const mgr = createSingingProcess({ python, voicebank: bank, device: 'cpu', readyTimeoutMs: 120000 })
    try {
      const ready = await mgr.ensureReady()
      assert.ok(ready.sampleRate > 0)
      const res = await mgr.sing({
        notes: [[0, 0.5, 60, '银'], [0.5, 0.5, 62, '行']],
        out: TEMP_TASK.out + '.real', maxSeconds: 10,
      })
      assert.equal(res.ok !== false, true)
      assert.ok(res.seconds > 0)
      assert.equal(res.text, '银行')
    } finally {
      await mgr.stop()
    }
  })
}

// ---------------------------------------------------------------------------
let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log('PASS', name)
  } catch (err) {
    failed += 1
    console.error('FAIL', name, '\n  ', err?.stack || err)
  }
}
// Clean up every scratch output this test created (never touch user data).
for (const name of readdirSync(here)) {
  if (name.startsWith('.singing-test-out')) {
    try { rmSync(join(here, name), { recursive: true, force: true }) } catch {}
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed) process.exitCode = 1
