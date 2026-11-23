#!/usr/bin/env node
/**
 * VST3 扫描双形态与试听旋律回归测试。
 * Run: node test/vst3-scan.mjs
 *
 * 覆盖 t11/t12/t14/t15 的修复：
 *  1. scanVst3Packages 真实扫描本机 VST3 目录：目录包 form='bundle' 且
 *     declaredInstrument=true（ABPL/AGML），单文件 form='single' 且
 *     declaredInstrument=null，FabFilter 与 WaveShell 都在候选里；
 *     候选的 recognized 建议标签与 vst3-known 规则一致；
 *  2. 单文件加载冒烟：FabFilter Twin 3 经侧车渲染单音。侧车只接受
 *     is_instrument 的插件（非乐器以 kind=load 拒绝），渲染成功即证明；
 *     再用 FabFilter Pro-Q 3 反向验证这道门禁；
 *  3. 试听旋律冒烟：ABPL 按 /vst3/test 同款 8 音琶音渲染，峰值>0.01、时长≈2.8s；
 *  4. 吉他扫弦冒烟：AGML 按 /vst3/test 同款 D/D/G/A 扫弦渲染 20 音，时长≈5.2s。
 *
 * 跳过保护：目录不存在 / 候选为空 / venv 或 Python 依赖缺失 / 插件缺失都 SKIP，
 * 不因机器差异失败。本测试只读机器配置，绝不写 vst3 区块。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { builtInCatalog } from '../src/audio/vst3-catalog.js'
import { recognizeVst3 } from '../src/audio/vst3-known.js'
import { scanVst3Packages } from '../src/host/routes.js'
import { renderVst3Stem } from '../src/tools/instrument.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(here, '..')
const WORK = mkdtempSync(join(tmpdir(), 'anyaudio-vst3-scan-'))
const VST3_DIR = 'C:/Program Files/Common Files/VST3'
const REAL_PYTHON = join(
  REPO_ROOT, '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
)

// 只读机器配置：指向临时文件，扫描/选源看不到用户自己加的插件，也不会写回。
const previousConfig = process.env.ANYAUDIO_CONFIG
const previousState = process.env.ANYAUDIO_STATE
process.env.ANYAUDIO_CONFIG = join(WORK, 'config.json')
process.env.ANYAUDIO_STATE = join(WORK, 'state.json')

const tests = []
function test(name, fn) { tests.push([name, fn]) }

function pythonDepsReady() {
  if (!existsSync(REAL_PYTHON)) return false
  const probe = spawnSync(REAL_PYTHON, ['-c', 'import pedalboard, numpy, mido'], { encoding: 'utf8', timeout: 60000 })
  return probe.status === 0
}

const scanDirExists = existsSync(VST3_DIR)
const candidates = scanDirExists ? await scanVst3Packages(VST3_DIR) : []
const depsReady = pythonDepsReady()
const byNameOrPath = (pattern) => candidates.filter((candidate) => pattern.test(candidate.name) || pattern.test(candidate.path))
const abplCandidate = candidates.find((candidate) => candidate.form === 'bundle' && /ABPL/i.test(candidate.name))
const agmlCandidate = candidates.find((candidate) => candidate.form === 'bundle' && /AGML/i.test(candidate.name))
const twinCandidate = candidates.find((candidate) => candidate.form === 'single' && /FabFilter Twin 3/i.test(candidate.name))
const proqCandidate = candidates.find((candidate) => candidate.form === 'single' && /FabFilter Pro-Q 3/i.test(candidate.name))
const waveCandidate = byNameOrPath(/waveshell/i)[0] ?? null

// ---------------------------------------------------------------------------
if (!scanDirExists) {
  console.log(`SKIP 扫描双形态：VST3 目录不存在（${VST3_DIR}）`)
} else if (candidates.length === 0) {
  console.log(`SKIP 扫描双形态：目录里没有候选（${VST3_DIR}）`)
} else {
  test('扫描双形态：目录包 form=bundle 且声明 Instrument，单文件 form=single 且未声明', () => {
    for (const candidate of candidates) {
      assert.ok(
        typeof candidate.path === 'string' && candidate.path.toLowerCase().endsWith('.vst3'),
        `候选路径不对：${candidate.path}`,
      )
      assert.ok(typeof candidate.name === 'string' && candidate.name.length > 0, `候选缺名字：${candidate.path}`)
      assert.ok(candidate.form === 'bundle' || candidate.form === 'single', `未知形态：${candidate.form}`)
      assert.equal(candidate.hasInnerDll, candidate.form === 'bundle', `${candidate.name} 的 hasInnerDll 与 form 不一致`)
      if (candidate.form === 'bundle') {
        assert.ok(
          candidate.declaredInstrument === true || candidate.declaredInstrument === false,
          `${candidate.name} 目录包必须读到 moduleinfo 声明`,
        )
      } else {
        assert.equal(candidate.declaredInstrument, null, `${candidate.name} 单文件没有 moduleinfo，声明必须是 null`)
      }
      assert.ok(
        candidate.recognized === 'instrument' || candidate.recognized === 'effect' || candidate.recognized === null,
        `${candidate.name} 的 recognized 只能是 instrument/effect/null，实际 ${JSON.stringify(candidate.recognized)}`,
      )
    }

    assert.ok(abplCandidate, 'ABPL 目录包必须在候选里')
    assert.ok(agmlCandidate, 'AGML 目录包必须在候选里')
    assert.equal(abplCandidate.declaredInstrument, true, 'ABPL 的 moduleinfo 必须声明 Instrument')
    assert.equal(agmlCandidate.declaredInstrument, true, 'AGML 的 moduleinfo 必须声明 Instrument')

    const singles = candidates.filter((candidate) => candidate.form === 'single')
    assert.ok(singles.length > 0, '必须扫到单文件形态')
    assert.ok(singles.every((candidate) => candidate.declaredInstrument === null), '单文件候选的 declaredInstrument 必须全是 null')

    assert.ok(byNameOrPath(/fabfilter/i).length > 0, 'FabFilter 必须在候选里')
    assert.ok(byNameOrPath(/waveshell/i).length > 0, 'WaveShell 必须在候选里')
  })
}

const missingLabels = [
  ['FabFilter Twin 3', twinCandidate],
  ['FabFilter Pro-Q 3', proqCandidate],
  ['WaveShell', waveCandidate],
  ['ABPL', abplCandidate],
  ['AGML', agmlCandidate],
].filter(([, candidate]) => !candidate).map(([name]) => name)

if (scanDirExists && candidates.length > 0) {
  if (missingLabels.length > 0) {
    console.log(`SKIP 认可标签：候选里缺少 ${missingLabels.join('、')}`)
  } else {
    test('认可标签：音源/效果器建议类别', () => {
      // 规则本身：先具体后一般，首条命中生效。
      assert.equal(recognizeVst3('FabFilter Twin 3'), 'instrument')
      assert.equal(recognizeVst3('FabFilter Pro-Q 3'), 'effect')
      assert.equal(recognizeVst3('WaveShell1-VST3 15.0_x64'), 'effect')
      assert.equal(recognizeVst3('ABPL'), 'instrument')
      assert.equal(recognizeVst3('AGML'), 'instrument')
      assert.equal(recognizeVst3(''), null, '没有名称时不猜')
      // 扫描候选必须带上同一个标签。
      assert.equal(twinCandidate.recognized, 'instrument')
      assert.equal(proqCandidate.recognized, 'effect')
      assert.equal(waveCandidate.recognized, 'effect')
      assert.equal(abplCandidate.recognized, 'instrument')
      assert.equal(agmlCandidate.recognized, 'instrument')
    })
  }
}

if (!twinCandidate) {
  console.log('SKIP 单文件加载冒烟：扫描结果里没有 FabFilter Twin 3')
} else if (!depsReady) {
  console.log('SKIP 单文件加载冒烟：venv 或 pedalboard/numpy/mido 不可用')
} else {
  test('单文件加载冒烟：FabFilter Twin 3 经侧车渲染单音', async () => {
    const out = join(WORK, 'twin3.wav')
    const result = await renderVst3Stem({
      plugin: twinCandidate.path,
      notes: [{ pitch: 60, start: 0, dur: 0.5, vel: 100 }],
      duration: 1.5,
      out,
    })
    // 侧车只接受 is_instrument 的插件（非乐器会以 kind=load 拒绝），
    // 所以渲染成功本身就是 is_instrument 的证据。
    assert.ok(result.peak > 0.01, `峰值应大于 0.01，实际 ${result.peak}`)
    assert.ok(Math.abs(result.seconds - 1.5) < 0.1, `时长应约 1.5s，实际 ${result.seconds}`)
    assert.ok(existsSync(out), '应写出 WAV')
  })

  if (proqCandidate) {
    test('侧车 is_instrument 门禁：非乐器插件被拒（kind=load）', async () => {
      await assert.rejects(
        renderVst3Stem({
          plugin: proqCandidate.path,
          notes: [{ pitch: 60, start: 0, dur: 0.5, vel: 100 }],
          duration: 1.5,
          out: join(WORK, 'proq3.wav'),
        }),
        (err) => err.kind === 'load' && err.code === 'LOAD_FAILED' && /不是乐器插件/.test(err.message),
      )
    })
  }
}

if (!abplCandidate) {
  console.log('SKIP 试听旋律冒烟：扫描结果里没有 ABPL')
} else if (!depsReady) {
  console.log('SKIP 试听旋律冒烟：venv 或 pedalboard/numpy/mido 不可用')
} else {
  test('试听旋律冒烟：ABPL 8 音琶音（/vst3/test 同款）', async () => {
    // 与 src/host/routes.js 的 vst3TestRoute 同一套模式：根音按实测音域
    // clamp(55, low+4, high-12)，音程 0/4/7/12/7/4/0/7，间隔 0.25s、时长 0.22s。
    const range = builtInCatalog().plugins.find((entry) => /ABPL/i.test(entry.plugin))?.range ?? null
    const root = range ? Math.min(Math.max(55, range.low + 4), range.high - 12) : 55
    assert.equal(root, 55, 'ABPL 的实测音域应把根音夹到 55')
    const intervals = [0, 4, 7, 12, 7, 4, 0, 7]
    const notes = intervals.map((interval, index) => ({
      pitch: root + interval,
      start: index * 0.25,
      dur: 0.22,
      vel: index === intervals.length - 1 ? 110 : 100,
    }))
    if (range) {
      for (const note of notes) {
        assert.ok(
          note.pitch >= range.low && note.pitch <= range.high,
          `琶音音高 ${note.pitch} 超出实测音域 ${range.low}-${range.high}`,
        )
      }
    }
    const out = join(WORK, 'abpl-melody.wav')
    const result = await renderVst3Stem({ plugin: abplCandidate.path, notes, duration: 2.8, out })
    assert.ok(result.peak > 0.01, `峰值应大于 0.01，实际 ${result.peak}`)
    assert.ok(Math.abs(result.seconds - 2.8) <= 0.3, `时长应约 2.8s，实际 ${result.seconds}`)
    assert.ok(existsSync(out), '应写出 WAV')
  })
}

if (!agmlCandidate) {
  console.log('SKIP 吉他扫弦冒烟：扫描结果里没有 AGML')
} else if (!depsReady) {
  console.log('SKIP 吉他扫弦冒烟：venv 或 pedalboard/numpy/mido 不可用')
} else {
  test('吉他扫弦冒烟：AGML 四和弦 20 音（/vst3/test 同款）', async () => {
    // 与 src/host/routes.js 的 vst3TestRoute 同一套扫弦模式：D/D/G/A 四个和弦，
    // 每和弦 5 音从低到高错开 0.018s，前三个 0.9s、末个 1.4s，duration 5.2s。
    const chords = [
      { start: 0.0, pitches: [50, 57, 62, 66, 69], dur: 0.9, vel: 100 },
      { start: 1.0, pitches: [50, 57, 62, 66, 69], dur: 0.9, vel: 100 },
      { start: 2.0, pitches: [55, 59, 62, 67, 71], dur: 0.9, vel: 100 },
      { start: 3.0, pitches: [45, 52, 57, 61, 64], dur: 1.4, vel: 110 },
    ]
    const notes = chords.flatMap((chord) => chord.pitches.map((pitch, index) => ({
      pitch,
      start: chord.start + index * 0.018,
      dur: chord.dur,
      vel: chord.vel,
    })))
    assert.equal(notes.length, 20, '四和弦 × 5 音 = 20 个音')
    assert.deepEqual(
      notes.slice(0, 5).map((note) => Number(note.start.toFixed(6))),
      [0, 0.018, 0.036, 0.054, 0.072],
      '弦间错开 0.018s',
    )
    assert.equal(notes[19].vel, 110, '末和弦力度 110')
    const range = builtInCatalog().plugins.find((entry) => /AGML/i.test(entry.plugin))?.range ?? null
    if (range) {
      for (const note of notes) {
        assert.ok(
          note.pitch >= range.low && note.pitch <= range.high,
          `扫弦音高 ${note.pitch} 超出实测音域 ${range.low}-${range.high}`,
        )
      }
    }
    const out = join(WORK, 'agml-strum.wav')
    const result = await renderVst3Stem({ plugin: agmlCandidate.path, notes, duration: 5.2, out })
    assert.ok(result.peak > 0.01, `峰值应大于 0.01，实际 ${result.peak}`)
    assert.ok(Math.abs(result.seconds - 5.2) <= 0.3, `时长应约 5.2s，实际 ${result.seconds}`)
    assert.ok(existsSync(out), '应写出 WAV')
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
if (previousConfig === undefined) delete process.env.ANYAUDIO_CONFIG
else process.env.ANYAUDIO_CONFIG = previousConfig
if (previousState === undefined) delete process.env.ANYAUDIO_STATE
else process.env.ANYAUDIO_STATE = previousState

console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed) process.exitCode = 1
