#!/usr/bin/env node
/**
 * VST3 运行时安装流程测试。
 * Run: node test/vst3-install.mjs
 *
 * 全部离线：下载、解压、pip、探测都是注入的假实现，root 指向临时目录，
 * 不写真实 ~/.dsh。覆盖：
 *  1. vst3Status：空 root 不抛、installed/ready 为 false；未安装不探测；
 *     已安装按 probe 结果算 ready，probe 抛错按未就绪处理；
 *  2. runVst3Install 全流程：假 fetch（假 tar.gz 字节 + 真 SHA-256）→ 假 extract
 *     （写 runtime/python.exe）→ 假 pip（记录调用）→ 假 probe（ready）→ ready:true；
 *     一次安装只跑一次 pip；二次运行跳过下载与解压（fetch/extract 不再被调）；
 *  3. 失败路径：下载失败抛 DOWNLOAD_FAILED（每个镜像都试过）；验证未就绪抛
 *     INSTALL_INCOMPLETE（带 status 与缺失依赖名）；
 *  4. python 解析优先级：options.python > ANYAUDIO_VST3_PYTHON > 用户级 runtime >
 *     仓库 .venv（临时目录 + 假文件断言，不碰真实 ~/.dsh）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runVst3Install, vst3Root, vst3RuntimeExe, vst3Status } from '../src/audio/vst3-install.js'
import { resolveVst3Python } from '../src/audio/vst3-process.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(here, '..')
const WORK = mkdtempSync(join(tmpdir(), 'anyaudio-vst3-install-'))
const EXE = process.platform === 'win32' ? 'python.exe' : 'python'
const REPO_VENV_PYTHON = join(
  REPO_ROOT, '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  EXE,
)

const tests = []
function test(name, fn) { tests.push([name, fn]) }

const previousDir = process.env.ANYAUDIO_VST3_DIR
const previousPython = process.env.ANYAUDIO_VST3_PYTHON
function clearEnv() {
  delete process.env.ANYAUDIO_VST3_DIR
  delete process.env.ANYAUDIO_VST3_PYTHON
}
function restoreEnv() {
  if (previousDir === undefined) delete process.env.ANYAUDIO_VST3_DIR
  else process.env.ANYAUDIO_VST3_DIR = previousDir
  if (previousPython === undefined) delete process.env.ANYAUDIO_VST3_PYTHON
  else process.env.ANYAUDIO_VST3_PYTHON = previousPython
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** A manifest with one fake runtime artifact; the checksum is real so the
 *  download path verifies it instead of skipping the check. */
function fakeManifest(bytes, urls = ['https://example.invalid/fake-python.tar.gz']) {
  return { runtime: { file: 'fake-python.tar.gz', sha256: sha256(bytes), urls } }
}

/** fetchImpl that serves `bytes` as a 200 response with a readable body. */
function fakeFetch(bytes, { fail = false } = {}) {
  const calls = []
  const impl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers ?? {} })
    if (fail) throw new Error('network down')
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          let sent = false
          return {
            async read() {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: bytes }
            },
          }
        },
        cancel: async () => {},
      },
    }
  }
  impl.calls = calls
  return impl
}

/** extractImpl that mimics the real archive: one top-level folder with the exe. */
function fakeExtract() {
  const calls = []
  const impl = async (archive, destDir, ctx = {}) => {
    calls.push({ archive, destDir, phase: ctx.phase })
    const inner = join(destDir, 'python')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(inner, EXE), 'fake python')
  }
  impl.calls = calls
  return impl
}

function fakePip() {
  const calls = []
  const impl = async (python, group, ctx = {}) => {
    calls.push({ python, group, phase: ctx.phase })
  }
  impl.calls = calls
  return impl
}

function fakeProbe(deps = { pedalboard: true, numpy: true, mido: true }, version = 'Python 3.12.16') {
  const calls = []
  const impl = async (python) => {
    calls.push({ python })
    return { version, deps }
  }
  impl.calls = calls
  return impl
}

// ---------------------------------------------------------------------------
test('vst3Status：空 root 不抛，installed/ready 为 false，未安装不探测', async () => {
  clearEnv()
  const root = join(WORK, 'empty-root')
  mkdirSync(root, { recursive: true })
  const probe = fakeProbe()
  const status = await vst3Status({ root, probeImpl: probe })
  assert.equal(status.ok, true)
  assert.equal(status.root, resolve(root))
  assert.equal(status.runtime.installed, false)
  assert.equal(status.runtime.python, vst3RuntimeExe(root))
  assert.equal(status.runtime.version, null)
  assert.deepEqual(status.deps, { pedalboard: false, numpy: false, mido: false })
  assert.equal(status.ready, false)
  assert.equal(probe.calls.length, 0, '未安装时不应探测')
})

test('vst3Status：已安装按 probe 结果算 ready，probe 抛错按未就绪处理', async () => {
  clearEnv()
  const root = join(WORK, 'installed-root')
  mkdirSync(join(root, 'runtime'), { recursive: true })
  writeFileSync(vst3RuntimeExe(root), 'fake python')

  const probe = fakeProbe()
  const ready = await vst3Status({ root, probeImpl: probe })
  assert.equal(ready.runtime.installed, true)
  assert.equal(ready.runtime.version, 'Python 3.12.16')
  assert.equal(ready.ready, true)
  assert.equal(probe.calls.length, 1)
  assert.equal(probe.calls[0].python, vst3RuntimeExe(root))

  const partial = await vst3Status({ root, probeImpl: fakeProbe({ pedalboard: true, numpy: false, mido: true }) })
  assert.equal(partial.ready, false)
  assert.deepEqual(partial.deps, { pedalboard: true, numpy: false, mido: true })

  const broken = await vst3Status({ root, probeImpl: async () => { throw new Error('probe boom') } })
  assert.equal(broken.ready, false, 'probe 抛错不能向上抛')
  assert.deepEqual(broken.deps, { pedalboard: false, numpy: false, mido: false })
})

test('runVst3Install 全流程：下载→解压→pip→验证，二次运行跳过下载', async () => {
  clearEnv()
  const root = join(WORK, 'install-root')
  const bytes = Buffer.from('fake tar.gz payload — not a real archive')
  const manifest = fakeManifest(bytes)
  const fetchImpl = fakeFetch(bytes)
  const extractImpl = fakeExtract()
  const pipImpl = fakePip()
  const probeImpl = fakeProbe()
  const progress = []

  const status = await runVst3Install({
    root, manifest, fetchImpl, extractImpl, pipImpl, probeImpl,
    onProgress: (entry) => progress.push(entry),
  })

  assert.equal(status.ok, true)
  assert.equal(status.ready, true)
  assert.equal(status.runtime.installed, true)
  assert.equal(status.runtime.python, vst3RuntimeExe(root))
  assert.ok(existsSync(vst3RuntimeExe(root)), '解压后 runtime/python.exe 必须存在')
  assert.ok(existsSync(join(root, 'downloads', manifest.runtime.file)), '下载的归档必须落在 downloads/')
  assert.equal(
    existsSync(`${join(root, 'downloads', manifest.runtime.file)}.part`),
    false,
    '下载完成后不能留下 .part',
  )

  assert.equal(fetchImpl.calls.length, 1, '一次安装只下载一次')
  assert.equal(extractImpl.calls.length, 1, '一次安装只解压一次')
  assert.equal(pipImpl.calls.length, 1, '一次安装只跑一次 pip（三个依赖一组）')
  assert.equal(pipImpl.calls[0].python, vst3RuntimeExe(root), 'pip 必须装进侧车要启动的那个解释器')
  assert.deepEqual(pipImpl.calls[0].group.specs, ['pedalboard', 'numpy', 'mido'])
  assert.equal(probeImpl.calls.length, 1, '验证阶段探测一次')
  assert.ok(progress.some((entry) => entry.phase === 'runtime-download'), '进度里应有下载阶段')
  assert.ok(progress.some((entry) => entry.phase === 'pip'), '进度里应有 pip 阶段')

  // Second run: the runtime is already there, so nothing is downloaded or
  // extracted again. pip still runs (the install is idempotent, not skipped).
  const second = await runVst3Install({ root, manifest, fetchImpl, extractImpl, pipImpl, probeImpl })
  assert.equal(second.ready, true)
  assert.equal(fetchImpl.calls.length, 1, '二次运行必须跳过下载')
  assert.equal(extractImpl.calls.length, 1, '二次运行必须跳过解压')
  assert.equal(pipImpl.calls.length, 2, 'pip 每次安装都会重跑（幂等），只有下载/解压被跳过')
})

test('失败路径：下载失败抛 DOWNLOAD_FAILED，验证未就绪抛 INSTALL_INCOMPLETE', async () => {
  clearEnv()
  // Download failure: every mirror is tried, then the error carries the code.
  const root = join(WORK, 'fail-download')
  const manifest = fakeManifest(
    Buffer.from('x'),
    ['https://example.invalid/a.tar.gz', 'https://example.invalid/b.tar.gz'],
  )
  const fetchImpl = fakeFetch(Buffer.from('x'), { fail: true })
  await assert.rejects(
    runVst3Install({ root, manifest, fetchImpl, extractImpl: fakeExtract(), pipImpl: fakePip(), probeImpl: fakeProbe() }),
    (err) => {
      assert.equal(err.code, 'DOWNLOAD_FAILED')
      assert.match(err.message, /all sources failed/)
      return true
    },
  )
  assert.equal(fetchImpl.calls.length, 2, '每个镜像都要试一次')
  assert.equal(existsSync(vst3RuntimeExe(root)), false, '下载失败不能留下 runtime')

  // Verification failure: the runtime installs, pip runs, but a dependency is missing.
  const root2 = join(WORK, 'fail-probe')
  const bytes = Buffer.from('fake tar.gz payload')
  const manifest2 = fakeManifest(bytes)
  const pipImpl = fakePip()
  await assert.rejects(
    runVst3Install({
      root: root2,
      manifest: manifest2,
      fetchImpl: fakeFetch(bytes),
      extractImpl: fakeExtract(),
      pipImpl,
      probeImpl: fakeProbe({ pedalboard: true, numpy: false, mido: true }),
    }),
    (err) => {
      assert.equal(err.code, 'INSTALL_INCOMPLETE')
      assert.match(err.message, /numpy/)
      assert.equal(err.status.ready, false)
      assert.equal(err.status.deps.numpy, false)
      return true
    },
  )
  assert.equal(pipImpl.calls.length, 1, '验证失败前 pip 已经跑过')
})

test('python 解析优先级：options.python > ANYAUDIO_VST3_PYTHON > 用户级 runtime > 仓库 .venv', () => {
  const root = join(WORK, 'priority-root')
  mkdirSync(join(root, 'runtime'), { recursive: true })
  writeFileSync(vst3RuntimeExe(root), 'fake python')
  const installed = vst3RuntimeExe(root)
  const envPython = join(WORK, 'env-python', EXE)
  const explicit = join(WORK, 'explicit-python', EXE)

  try {
    // 4. No user-level runtime → the repo's own .venv (existence not required).
    clearEnv()
    process.env.ANYAUDIO_VST3_DIR = join(WORK, 'empty-root')
    assert.equal(resolveVst3Python(), REPO_VENV_PYTHON, '没有用户级 runtime 时回退仓库 .venv')

    // 3. User-level runtime present → it wins over the repo venv.
    process.env.ANYAUDIO_VST3_DIR = root
    assert.equal(resolveVst3Python(), installed, '用户级 runtime 优先于仓库 .venv')

    // 2. ANYAUDIO_VST3_PYTHON overrides the installed runtime.
    process.env.ANYAUDIO_VST3_PYTHON = envPython
    assert.equal(resolveVst3Python(), resolve(envPython), '环境变量优先于用户级 runtime')

    // 1. options.python overrides everything.
    assert.equal(resolveVst3Python({ python: explicit }), explicit, '显式 options.python 优先级最高')
  } finally {
    clearEnv()
  }
})

test('vst3Root：options.root > ANYAUDIO_VST3_DIR > ~/.dsh/anyaudio/vst3', () => {
  try {
    clearEnv()
    const envRoot = join(WORK, 'env-root')
    process.env.ANYAUDIO_VST3_DIR = envRoot
    assert.equal(vst3Root(), resolve(envRoot))
    assert.equal(vst3Root({ root: join(WORK, 'opt-root') }), resolve(join(WORK, 'opt-root')))
    assert.equal(vst3RuntimeExe(envRoot), join(resolve(envRoot), 'runtime', EXE))
  } finally {
    clearEnv()
  }
  const fallback = vst3Root()
  assert.ok(
    fallback.endsWith(join('.dsh', 'anyaudio', 'vst3')),
    `默认 root 应在 ~/.dsh/anyaudio/vst3 下，实际 ${fallback}`,
  )
})

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
restoreEnv()
rmSync(WORK, { recursive: true, force: true })
console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed) process.exitCode = 1
