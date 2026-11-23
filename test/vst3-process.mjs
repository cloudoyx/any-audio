#!/usr/bin/env node
/**
 * VST3 进程生命周期测试。
 * Run: node test/vst3-process.mjs
 *
 * 用注入的 fake worker（test/fixtures/fake-vst3-worker.mjs）走同一套 JSON 行协议，
 * 不需要真实插件。真实插件冒烟测试只在 ABPL.vst3 与项目 venv 都存在时运行，
 * 缺任何一样都跳过——测试不能因机器差异失败。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_IDLE_SEC, DEFAULT_RENDER_TIMEOUT_MS, createVst3Process, resolveVst3Config,
} from '../src/audio/vst3-process.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(here, '..')
const FAKE_WORKER = join(here, 'fixtures', 'fake-vst3-worker.mjs')
const NODE = process.execPath
const WORK = mkdtempSync(join(tmpdir(), 'anyaudio-vst3-process-'))
const REAL_PLUGIN = 'C:\\Program Files\\Common Files\\VST3\\ABPL.vst3'
const REAL_PYTHON = join(
  REPO_ROOT, '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tests = []
function test(name, fn) { tests.push([name, fn]) }

function fakeOptions(extra = {}) {
  return { command: NODE, args: [FAKE_WORKER], ...extra }
}

function task(extra = {}) {
  return {
    plugin: 'C:\\Program Files\\Common Files\\VST3\\ABPL.vst3',
    notes: [{ pitch: 40, start: 0, dur: 0.5, vel: 100 }],
    duration: 1.5,
    out: join(WORK, 'out.wav'),
    ...extra,
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error(`等待超时：${label}`)
}

// ---------------------------------------------------------------------------
test('配置默认值：60s 空闲、120s 渲染超时、stderr 继承', () => {
  assert.equal(DEFAULT_IDLE_SEC, 60)
  assert.equal(DEFAULT_RENDER_TIMEOUT_MS, 120000)
  const state = createVst3Process(fakeOptions()).getState()
  assert.deepEqual(state.stdio, ['pipe', 'pipe', 'inherit'], 'stderr 必须继承，不能走管道')
  assert.equal(state.running, false)
  assert.equal(state.starts, 0)
  assert.equal(state.pid, null)

  const injected = resolveVst3Config(fakeOptions())
  assert.equal(injected.injected, true)
  assert.equal(injected.idleMs, 60000)
  assert.equal(injected.renderTimeoutMs, 120000)
  assert.equal(injected.readyTimeoutMs, 60000)

  const clamped = resolveVst3Config(fakeOptions({ idleMs: 10, renderTimeoutMs: 0 }))
  assert.equal(clamped.idleMs, 100, 'idleMs 下限 100')
  assert.equal(clamped.renderTimeoutMs, 1, 'renderTimeoutMs 下限 1')
  assert.equal(resolveVst3Config({}).injected, false)
})

test('按需启动：render 之前不启动，两次 render 共用一个进程', async () => {
  const mgr = createVst3Process(fakeOptions())
  try {
    assert.equal(mgr.getState().starts, 0)
    assert.equal(mgr.getState().running, false)
    const first = await mgr.render(task())
    assert.equal(first.peak, 0.79)
    assert.equal(first.seconds, 1.5)
    assert.equal(mgr.getState().starts, 1)
    assert.equal(mgr.getState().running, true)
    assert.ok(mgr.getState().pid > 0)
    const second = await mgr.render(task({ out: join(WORK, 'out2.wav') }))
    assert.equal(second.peak, 0.79)
    assert.equal(mgr.getState().starts, 1, '第二次 render 必须复用进程')
  } finally {
    await mgr.shutdown()
  }
})

test('ensureReady 启动进程并返回 ready 信息', async () => {
  const mgr = createVst3Process(fakeOptions())
  try {
    const ready = await mgr.ensureReady()
    assert.equal(ready.sampleRate, 48000)
    assert.equal(mgr.getState().starts, 1)
    assert.equal(mgr.getState().running, true)
  } finally {
    await mgr.shutdown()
  }
})

test('空闲退出后再 render 自动重启', async () => {
  const mgr = createVst3Process(fakeOptions({ idleMs: 200 }))
  try {
    await mgr.render(task())
    assert.equal(mgr.getState().running, true)
    assert.equal(mgr.getState().idleArmed, true)
    await waitFor(() => !mgr.getState().running, 3000, '空闲退出')
    await mgr.render(task())
    assert.equal(mgr.getState().starts, 2, '空闲退出后必须重新启动')
    assert.equal(mgr.getState().running, true)
  } finally {
    await mgr.shutdown()
  }
})

test('进程被外部杀掉后，下一次 render 自动恢复', async () => {
  const mgr = createVst3Process(fakeOptions())
  try {
    await mgr.render(task())
    const pid = mgr.getState().pid
    assert.ok(pid > 0)
    process.kill(pid, 'SIGKILL')
    await waitFor(() => !mgr.getState().running, 5000, '进程退出')
    const res = await mgr.render(task())
    assert.equal(res.peak, 0.79)
    assert.equal(mgr.getState().starts, 2, '被杀后必须启动新进程')
  } finally {
    await mgr.shutdown()
  }
})

test('渲染超时报错并杀掉进程，下一次 render 重新启动', async () => {
  const mgr = createVst3Process(fakeOptions({ renderTimeoutMs: 300 }))
  try {
    await assert.rejects(
      mgr.render(task({ plugin: 'C:\\hang-plugin\\ABPL.vst3' })),
      (err) => err.code === 'RENDER_TIMEOUT' && err.kind === 'render' && /timed out/.test(err.message),
    )
    assert.equal(mgr.getState().running, false, '超时后必须杀掉进程')
    assert.equal(mgr.getState().pending, 0)
    const res = await mgr.render(task())
    assert.equal(res.peak, 0.79)
    assert.equal(mgr.getState().starts, 2)
  } finally {
    await mgr.shutdown()
  }
})

test('worker 渲染中崩溃：报 WORKER_EXITED，下一次 render 重启', async () => {
  const mgr = createVst3Process(fakeOptions())
  try {
    await assert.rejects(
      mgr.render(task({ plugin: 'C:\\crash-plugin\\ABPL.vst3' })),
      (err) => err.code === 'WORKER_EXITED' && err.kind === 'render',
    )
    await waitFor(() => !mgr.getState().running, 3000, '崩溃后清理')
    const res = await mgr.render(task())
    assert.equal(res.peak, 0.79)
    assert.equal(mgr.getState().starts, 2)
  } finally {
    await mgr.shutdown()
  }
})

test('坏插件路径报 kind=load，进程存活且可继续渲染', async () => {
  const mgr = createVst3Process(fakeOptions())
  try {
    await assert.rejects(
      mgr.render(task({ plugin: 'C:\\missing-plugin\\ABPL.vst3' })),
      (err) => err.kind === 'load' && err.code === 'LOAD_FAILED' && /加载失败/.test(err.message),
    )
    assert.equal(mgr.getState().running, true, '加载失败不能杀掉进程')
    assert.equal(mgr.getState().starts, 1)
    const res = await mgr.render(task())
    assert.equal(res.peak, 0.79)
    assert.equal(mgr.getState().starts, 1, '同一个进程继续服务')
  } finally {
    await mgr.shutdown()
  }
})

test('shutdown 幂等：重复调用不报错，未启动时也能调用', async () => {
  const idle = createVst3Process(fakeOptions())
  await idle.shutdown()
  await idle.shutdown()
  assert.equal(idle.getState().running, false)
  assert.equal(idle.getState().starts, 0)

  const mgr = createVst3Process(fakeOptions())
  await mgr.render(task())
  assert.equal(mgr.getState().starts, 1)
  await mgr.shutdown()
  assert.equal(mgr.getState().running, false)
  await mgr.shutdown()
  assert.equal(mgr.getState().running, false)
  assert.equal(mgr.getState().starts, 1, 'shutdown 不能改变启动计数')
})

test('参数错误在启动进程前拦下（kind=param）', async () => {
  const mgr = createVst3Process(fakeOptions())
  try {
    const cases = [
      [null, 'BAD_TASK'],
      [{ ...task(), plugin: '' }, 'BAD_PLUGIN'],
      [{ ...task(), out: '' }, 'BAD_OUTPUT'],
      [{ ...task(), duration: 0 }, 'BAD_DURATION'],
      [{ ...task(), notes: [] }, 'BAD_NOTES'],
      [{ ...task(), notes: [{ pitch: 200, start: 0, dur: 0.5 }] }, 'BAD_NOTES'],
      [{ ...task(), notes: [{ pitch: 40, start: -1, dur: 0.5 }] }, 'BAD_NOTES'],
      [{ ...task(), notes: [{ pitch: 40, start: 0, dur: 0 }] }, 'BAD_NOTES'],
      [{ ...task(), notes: [{ pitch: 40, start: 0, dur: 0.5, vel: 200 }] }, 'BAD_NOTES'],
    ]
    for (const [input, code] of cases) {
      await assert.rejects(mgr.render(input), (err) => err.code === code && err.kind === 'param', code)
    }
    assert.equal(mgr.getState().starts, 0, '参数校验不能启动进程')
  } finally {
    await mgr.shutdown()
  }
})

test('preset 透传：给了就原样送到 worker，不给就不带这个字段', async () => {
  const mgr = createVst3Process(fakeOptions())
  try {
    const preset = join(WORK, '音色.state')
    const withPreset = await mgr.render(task({ preset }))
    assert.equal(withPreset.preset, preset, 'worker 收到的 preset 必须与输入逐字节一致')
    const without = await mgr.render(task())
    assert.equal(without.preset, undefined, '没给 preset 时不能凭空带上这个字段')
  } finally {
    await mgr.shutdown()
  }
})

test('preset 不是字符串按 kind=param 拦下', async () => {
  const mgr = createVst3Process(fakeOptions())
  try {
    await assert.rejects(
      mgr.render(task({ preset: 42 })),
      (err) => err.code === 'BAD_PRESET' && err.kind === 'param',
    )
    assert.equal(mgr.getState().starts, 0, '参数校验不能启动进程')
  } finally {
    await mgr.shutdown()
  }
})

test('中文输出路径经管道往返不乱码（UTF-8 字节，无 BOM）', async () => {
  const mgr = createVst3Process(fakeOptions())
  try {
    const out = join(WORK, '中文输出.wav')
    const res = await mgr.render(task({ out }))
    assert.equal(res.out, out, 'worker 回显的路径必须与输入逐字节一致')
    assert.ok(!res.out.includes('\uFFFD'), '不能出现替换字符')
    assert.ok(!res.out.startsWith('\uFEFF'), '不能带 BOM')
  } finally {
    await mgr.shutdown()
  }
})

// 真实插件冒烟：只有 ABPL.vst3 与项目 venv 都在才跑，缺一样就跳过。
if (!existsSync(REAL_PLUGIN)) {
  console.log('SKIP 真实插件冒烟：未安装', REAL_PLUGIN)
} else if (!existsSync(REAL_PYTHON)) {
  console.log('SKIP 真实插件冒烟：项目 venv 不存在', REAL_PYTHON)
} else {
  test('真实插件冒烟：ABPL 渲染峰值 > 0.01', async () => {
    const mgr = createVst3Process({ renderTimeoutMs: 180000, readyTimeoutMs: 120000, idleSec: 300 })
    try {
      const out = join(WORK, 'vst3-smoke.wav')
      let res
      try {
        res = await mgr.render({
          plugin: REAL_PLUGIN,
          notes: [
            { pitch: 40, start: 0, dur: 0.45, vel: 100 },
            { pitch: 43, start: 0.5, dur: 0.45, vel: 100 },
            { pitch: 45, start: 1.0, dur: 0.45, vel: 100 },
            { pitch: 47, start: 1.5, dur: 0.45, vel: 100 },
          ],
          duration: 2.5,
          out,
        })
      } catch (err) {
        // 依赖没装是机器差异，不是插件问题：跳过而不是失败。
        if (err.kind === 'load' && /未安装|No module|not found/i.test(err.message)) {
          console.log('SKIP 真实插件冒烟：worker 依赖缺失 —', err.message)
          return
        }
        throw err
      }
      assert.ok(res.peak > 0.01, `峰值应大于 0.01，实际 ${res.peak}`)
      assert.ok(res.seconds > 0)
      assert.ok(existsSync(out), '应写出 WAV 文件')
      assert.ok(statSync(out).size > 44, 'WAV 不能只有文件头')
      assert.equal(mgr.getState().starts, 1)
    } finally {
      await mgr.shutdown()
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
rmSync(WORK, { recursive: true, force: true })
console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed) process.exitCode = 1
