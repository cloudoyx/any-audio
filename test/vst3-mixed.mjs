#!/usr/bin/env node
/**
 * VST3 混合编制回归测试。
 * Run: node test/vst3-mixed.mjs
 *
 * 覆盖 t7 的渲染器合并：
 *  1. SF2 鼓 + VST3 贝斯（notes 第 5 元素 art 'pm'）+ SF2 钢琴走真实链路渲染，
 *     断言逐轨 sourceKind、stems 产出、mix 峰值与贝斯 stem 不是静音；
 *  2. source 必填：不写 source 报错并附可用清单，写了 VST3 id 就交给侧车；
 *  3. 编译期音域校验：pitch 20 + VST3 source 在 compileScore 报错并点名音轨；
 *  4. 插件缺失回退：可注入假档案（内置条目指向不存在的路径），显式 source
 *     标记 fallback=true——不需要真卸载插件。
 *
 * 真实渲染需要 插件 / venv / Python 依赖 / SoundFont 四样齐全，缺任何一样都
 * SKIP 而不是失败：测试不能因机器差异变红。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadCatalog } from '../src/audio/banks.js'
import { listFonts } from '../src/audio/fonts.js'
import { compileScore } from '../src/audio/score.js'
import { parseWav, peakOf } from '../src/audio/wav.js'
import { projectDir } from '../src/project/paths.js'
import { resolveVst3Python } from '../src/audio/vst3-process.js'
import { createProject } from '../src/project/store.js'
import { musicToolDefinition, selectSources } from '../src/tools/music.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(here, '..')
const WORK = mkdtempSync(join(tmpdir(), 'anyaudio-vst3-mixed-'))
const ANYAUDIO = join(REPO_ROOT, '.anyaudio')
const PROJECTS = join(ANYAUDIO, 'projects')
const TMP = join(ANYAUDIO, 'tmp')
const OUT = join(ANYAUDIO, 'out')
const REAL_PLUGIN = 'C:\\Program Files\\Common Files\\VST3\\ABPL.vst3'
// The interpreter the sidecar would actually launch: the machine-wide runtime
// installed from the settings page, or the checkout's own .venv.
const REAL_PYTHON = resolveVst3Python()

function listing(path) {
  try { return new Set(readdirSync(path)) } catch { return new Set() }
}
const hadAnyAudio = existsSync(ANYAUDIO)
const preexistingProjects = listing(PROJECTS)
const preexistingTmp = listing(TMP)
const preexistingOut = listing(OUT)

// Never touch the person's real config or font state: point both at scratch.
const previousConfig = process.env.ANYAUDIO_CONFIG
const previousState = process.env.ANYAUDIO_STATE
process.env.ANYAUDIO_CONFIG = join(WORK, 'config.json')
process.env.ANYAUDIO_STATE = join(WORK, 'state.json')

const exec = { agent: { workspaceRoot: REPO_ROOT } }
const tests = []
function test(name, fn) { tests.push([name, fn]) }

let projectSeq = 0
async function freshProject() {
  projectSeq++
  const project = await createProject(REPO_ROOT, { name: `vst3-mixed-${projectSeq}` })
  return project.id
}

// ---------------------------------------------------------------------------
test('source 必填：不写 source 报错并附可用清单，写了 VST3 id 就交给侧车', async () => {
  // 假档案的插件路径真实存在，选源结果就与机器上装没装 ABPL 无关。
  const fakePlugin = join(WORK, 'FakeBass.vst3')
  await writeFile(fakePlugin, 'fake vst3 package')
  const catalog = {
    version: 1,
    plugins: [{
      id: 'fake-bass', name: 'Fake Bass', vendor: 'Test', plugin: fakePlugin,
      format: 'vst3', instrument: true, range: { low: 28, high: 60 },
      families: { bass: 10 }, articulations: [], fxSounds: [], notes: '',
    }],
  }

  // 不写 source：不再自动挑，直接报错并把可用音源列出来。
  const missing = compileScore({ tracks: [{ name: '贝斯', instrument: 'bass', notes: [[0, 0.5, 40, 100]] }] })
  await assert.rejects(
    selectSources(missing, { catalog }),
    (err) => /track "贝斯" names no source/.test(err.message)
      && /Available sources:/.test(err.message)
      && /\[VST3\] fake-bass/.test(err.message),
    '不写 source 必须报错并附清单',
  )

  // 写了 VST3 id：交给侧车，SF2 计划里不再有这条轨。
  const explicit = compileScore({ tracks: [{ name: '贝斯', instrument: 'bass', source: 'fake-bass', notes: [[0, 0.5, 40, 100]] }] })
  const selection = await selectSources(explicit, { catalog })
  assert.equal(selection.vst3Tracks.length, 1, '显式 VST3 source 应交给侧车')
  assert.equal(selection.vst3Tracks[0].vst3.id, 'fake-bass')
  assert.equal(selection.sf2Compiled.tracks.length, 0, '选中 VST3 的轨不能同时留在 SF2 计划里')
  // A VST3 track's timbre is the plugin preset; an instrument name there is
  // ignored, and the reply says so instead of letting it pass silently.
  assert.equal(selection.warnings.length, 1, `应有一条 instrument 被忽略的警告，实际：${JSON.stringify(selection.warnings)}`)
  assert.match(selection.warnings[0], /does not apply to a VST3 source/)
})

test('编译期音域校验：VST3 轨超实测音域报错并点名音轨', async () => {
  const low = { tracks: [{ name: '超低贝斯', instrument: 'bass', source: 'ample-bass-p-lite', notes: [[0, 0.5, 20, 100]] }] }
  assert.throws(() => compileScore(low), (err) => {
    assert.match(err.message, /track "超低贝斯"/, '错误必须点名音轨')
    assert.match(err.message, /MIDI 40-72/, '错误必须给出实测音域')
    assert.match(err.message, /pitch 20/, '错误必须给出越界音高')
    return true
  })

  const high = { tracks: [{ name: '超高贝斯', instrument: 'bass', source: 'ample-bass-p-lite', notes: [[0, 0.5, 80, 100]] }] }
  assert.throws(() => compileScore(high), /track "超高贝斯".*MIDI 40-72.*pitch 80/)

  // 工具入口在渲染前就抛错，不会留下半成品。
  const projectId = await freshProject()
  await assert.rejects(
    musicToolDefinition.execute({ projectId, score: low }, exec),
    (err) => /超低贝斯/.test(err.message) && /MIDI 40-72/.test(err.message),
  )
})

test('回退：VST3 插件文件缺失时落回 SF2（可注入假档案，不卸载真插件）', async () => {
  const missingPlugin = join(WORK, 'not-installed', 'ABPL.vst3')
  const catalog = {
    version: 1,
    plugins: [{
      id: 'ample-bass-p-lite', name: 'Ample Bass P Lite 4 (ABPL)', vendor: 'Ample Sound',
      plugin: missingPlugin, format: 'vst3', instrument: true,
      range: { low: 40, high: 72 }, families: { bass: 10 },
      articulations: [{ id: 'sus', keyswitch: 24, name: '长音' }], fxSounds: [], notes: '',
    }],
  }

  // 显式 source：标记 fallback=true，并把 source 改回 auto 交给 SF2 计划。
  const explicitCompiled = compileScore({
    tracks: [{ name: '贝斯', instrument: 'bass', source: 'ample-bass-p-lite', notes: [[0, 0.5, 40, 100]] }],
  })
  const explicit = await selectSources(explicitCompiled, { catalog })
  assert.equal(explicit.vst3Tracks.length, 0, '插件缺失时显式 source 也不能渲染 VST3')
  assert.equal(explicit.sf2Compiled.tracks.length, 1, '显式 source 缺失应落回 SF2')
  const track = explicit.sf2Compiled.tracks[0]
  assert.equal(track.vst3Fallback, true, '显式 source 缺失时 fallback 必须为 true')
  assert.equal(track.source, 'auto', '回退后 source 改回 auto')
  assert.ok(
    explicit.warnings.some((warning) => /VST3 source "ample-bass-p-lite" is not installed .* SoundFont fallback/.test(warning)),
    `显式回退警告缺失：${JSON.stringify(explicit.warnings)}`,
  )
})

// 真实渲染：插件 / venv / Python 依赖 / SoundFont 四样齐全才跑。
const skipReasons = []
if (!existsSync(REAL_PLUGIN)) skipReasons.push(`ABPL.vst3 未安装（${REAL_PLUGIN}）`)
if (!existsSync(REAL_PYTHON)) {
  skipReasons.push(`项目 venv 不存在（${REAL_PYTHON}）`)
} else {
  const probe = spawnSync(REAL_PYTHON, ['-c', 'import pedalboard, numpy, mido'], { encoding: 'utf8', timeout: 60000 })
  if (probe.status !== 0) skipReasons.push('venv 缺少 pedalboard/numpy/mido')
}
const fonts = await listFonts()
if (fonts.length === 0) skipReasons.push('没有安装 SoundFont（node scripts/fetch-font.mjs）')
// Every track names its own source now, so the SF2 tracks need the installed
// bank's catalog id (the same id anyaudio_sources lists).
const defaultSource = fonts.length > 0 ? (await loadCatalog())[0]?.id ?? '' : ''

if (skipReasons.length > 0) {
  console.log(`SKIP 混合编制真实渲染：${skipReasons.join('；')}`)
} else {
  test('混合编制真实渲染：SF2 鼓 + VST3 贝斯（pm）+ SF2 钢琴', async () => {
    const projectId = await freshProject()
    const result = await musicToolDefinition.execute({
      projectId,
      score: {
        title: '混合编制回归',
        tracks: [
          {
            name: '鼓', drums: true, source: defaultSource,
            notes: [[0, 0.25, 36, 110], [0.5, 0.25, 38, 100], [1, 0.25, 42, 100], [1.5, 0.25, 36, 110]],
          },
          {
            name: '贝斯', instrument: 'bass', source: 'ample-bass-p-lite',
            notes: [[0, 0.9, 40, 100, 'pm'], [1, 0.9, 43, 100, 'pm'], [2, 0.9, 45, 100, 'sus']],
          },
          {
            name: '钢琴', instrument: 'piano', source: defaultSource,
            notes: [[0, 1.2, 60, 90], [1, 1.2, 64, 90], [2, 1.2, 67, 90]],
          },
        ],
      },
      durationSec: 3.5,
      stems: true,
    }, exec)

    assert.equal(result.ok, true)
    assert.equal(result.tracks.length, 3)
    const byName = new Map(result.tracks.map((track) => [track.name, track]))
    assert.equal(byName.get('贝斯').sourceKind, 'vst3', '贝斯轨必须走 VST3')
    assert.equal(byName.get('贝斯').source, 'ample-bass-p-lite')
    assert.equal(byName.get('贝斯').fallback, false, '显式 VST3 不应标记回退')
    assert.equal(byName.get('鼓').sourceKind, 'sf2', '鼓轨必须走 SF2')
    assert.equal(byName.get('钢琴').sourceKind, 'sf2', '钢琴轨必须走 SF2')
    assert.equal(result.vst3.length, 1)
    assert.equal(result.vst3[0].id, 'ample-bass-p-lite')
    assert.equal(result.vst3[0].track, '贝斯')

    assert.equal(result.stems.length, 3, 'stems:true 每轨一个 stem')
    assert.equal(result.attached.length, 3)
    assert.deepEqual(
      result.attached.map((entry) => entry.trackName).sort(),
      ['鼓', '贝斯', '钢琴'].sort(),
      '每个 stem 必须挂到自己的项目轨道',
    )
    for (const stem of result.stems) {
      assert.ok(existsSync(join(REPO_ROOT, stem)), `stem 文件必须存在：${stem}`)
    }

    assert.ok(result.peakDb > -40, `mix 峰值应高于 -40 dBFS，实际 ${result.peakDb}`)
    assert.ok(result.peakDb <= 0, `mix 峰值不应超过 0 dBFS，实际 ${result.peakDb}`)
    for (const name of ['鼓', '贝斯', '钢琴']) {
      const track = byName.get(name)
      assert.ok(Number.isFinite(track.rmsDb), `${name} 应有实测 RMS`)
      assert.ok(track.rmsDb > -60, `${name} 不应是静音（RMS ${track.rmsDb} dBFS）`)
    }

    // VST3 贝斯 stem 必须真的有声音：mix 有峰值也可能只是 SF2 两轨撑起来的。
    const bassAttached = result.attached.find((entry) => entry.trackName === '贝斯')
    assert.ok(bassAttached, '贝斯 stem 必须挂进项目')
    const bassWav = parseWav(await readFile(join(projectDir(REPO_ROOT, projectId), bassAttached.file)))
    assert.ok(peakOf(bassWav.channels) > 0.01, `VST3 贝斯 stem 峰值应大于 0.01，实际 ${peakOf(bassWav.channels)}`)
    assert.ok(!result.warnings.some((warning) => /贝斯.*fallback|fallback.*贝斯/.test(warning)), '显式 VST3 贝斯不应出现回退警告')
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

// Remove only what this run created: scratch projects and staged files.
for (const name of listing(PROJECTS)) {
  if (!preexistingProjects.has(name)) rmSync(join(PROJECTS, name), { recursive: true, force: true })
}
for (const name of listing(TMP)) {
  if (!preexistingTmp.has(name)) rmSync(join(TMP, name), { recursive: true, force: true })
}
for (const name of listing(OUT)) {
  if (!preexistingOut.has(name)) rmSync(join(OUT, name), { recursive: true, force: true })
}
if (!hadAnyAudio) {
  try {
    if (readdirSync(ANYAUDIO).length === 0) rmSync(ANYAUDIO, { recursive: true, force: true })
  } catch {}
}
rmSync(WORK, { recursive: true, force: true })
if (previousConfig === undefined) delete process.env.ANYAUDIO_CONFIG
else process.env.ANYAUDIO_CONFIG = previousConfig
if (previousState === undefined) delete process.env.ANYAUDIO_STATE
else process.env.ANYAUDIO_STATE = previousState

console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed) process.exitCode = 1
