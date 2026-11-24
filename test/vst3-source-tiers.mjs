#!/usr/bin/env node
/**
 * 二档音源（参数型预设）、一档钢琴与鼓轨 VST3 的回归测试。
 * Run: node test/vst3-source-tiers.mjs
 *
 * 覆盖：
 *  A. 参数型预设（假档案 + 假侧车，确定性）：
 *     1. timbresFromPrograms：probe 结果 → 音色（去空格、去重、id 形状、坏条目丢弃）；
 *     2. 谱面 preset 按名字 / id 解析成 presetParameter（不是 presetPath / presetFile）；
 *     3. 未知 preset 报错并列出该音源的音色；
 *     4. 配置往返保留 kind/parameter/value，state 型条目形状不变；
 *     5. 侧车协议：{kind:"parameter"} 原样透传，缺字段按 kind=param 拦下。
 *  B. 真实渲染（插件 / 运行时 / Python 依赖 / SoundFont 缺任何一样都 SKIP）：
 *     6. Dexed：'Say Again.' 与 'PHAROH' 的频谱重心差 > 200 Hz；
 *     7. Grand Piano：渲染一个音，峰值 > 0.01。
 *  C. 鼓轨（假档案，确定性）：
 *     8. 鼓轨写 VST3 source 走 VST3 路径，track.vst3 被设置、drums 保留；
 *     9. 鼓轨写 SF2 source 仍走 SF2 路径。
 *
 * 约束：机器配置指向临时文件，绝不写用户配置；真实插件 / 运行时缺失一律 SKIP，
 * 不因机器差异失败。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listFonts } from '../src/audio/fonts.js'
import { compileScore } from '../src/audio/score.js'
import { mergedCatalog, timbresFromPrograms } from '../src/audio/vst3-catalog.js'
import { createVst3Process, resolveVst3Python } from '../src/audio/vst3-process.js'
import { parseWav, peakOf } from '../src/audio/wav.js'
import { readConfig } from '../src/config.js'
import { projectDir } from '../src/project/paths.js'
import { createProject } from '../src/project/store.js'
import { musicToolDefinition, selectSources } from '../src/tools/music.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(here, '..')
const WORK = mkdtempSync(join(tmpdir(), 'anyaudio-vst3-tiers-'))
const ANYAUDIO = join(REPO_ROOT, '.anyaudio')
const PROJECTS = join(ANYAUDIO, 'projects')
const TMP = join(ANYAUDIO, 'tmp')
const OUT = join(ANYAUDIO, 'out')
const FAKE_WORKER = join(here, 'fixtures', 'fake-vst3-worker.mjs')
const DEXED = 'C:\\Program Files\\Common Files\\VST3\\Dexed.vst3'
const GRAND_PIANO = 'C:\\Program Files\\Common Files\\VST3\\Grand Piano Windows VST3\\Grand Piano.vst3'
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

/** Point the config at a fresh scratch file for one test. */
function useConfig(name) {
  const path = join(WORK, name)
  process.env.ANYAUDIO_CONFIG = path
  process.env.ANYAUDIO_STATE = `${path}.state.json`
  return path
}

const exec = { agent: { workspaceRoot: REPO_ROOT } }
const tests = []
function test(name, fn) { tests.push([name, fn]) }

let projectSeq = 0
async function freshProject() {
  projectSeq++
  const project = await createProject(REPO_ROOT, { name: `vst3-tiers-${projectSeq}` })
  return project.id
}

// Shared fake catalog: two VST3 sources whose plugin files exist (so selectSources
// never falls back) plus one SF2 source. Nothing here depends on what is
// installed on the machine.
const FIXTURE = join(WORK, 'fixtures')
await mkdir(FIXTURE, { recursive: true })
const fakePlugin = join(FIXTURE, 'FakeSynth.vst3')
await writeFile(fakePlugin, 'fake vst3 package')
const fakeDrumPlugin = join(FIXTURE, 'FakeDrums.vst3')
await writeFile(fakeDrumPlugin, 'fake vst3 package')
const fakeCatalog = {
  version: 1,
  plugins: [
    {
      id: 'fake-fm',
      name: 'Fake FM',
      vendor: 'Test',
      plugin: fakePlugin,
      format: 'vst3',
      instrument: true,
      range: { low: 21, high: 108 },
      families: { synthLead: 8 },
      articulations: [],
      fxSounds: [],
      notes: '',
      // 参数型音色：没有状态文件，描述一个具名程序参数取值。
      timbres: [
        {
          id: 'program:PHAROH', name: 'PHAROH', category: '', type: '',
          kind: 'parameter', parameter: 'program', value: 'PHAROH',
        },
        {
          id: 'program:Say Again.', name: 'Say Again.', category: '', type: '',
          kind: 'parameter', parameter: 'program', value: 'Say Again.',
        },
      ],
    },
    {
      id: 'fake-drums',
      name: 'Fake Drums',
      vendor: 'Test',
      plugin: fakeDrumPlugin,
      format: 'vst3',
      instrument: true,
      range: { low: 0, high: 127 },
      families: { drums: 9 },
      articulations: [],
      fxSounds: [],
      notes: '',
      timbres: [],
    },
  ],
}
const fakeFonts = [{ id: 'fake-font', name: 'Fake Font', path: join(FIXTURE, 'fake.sf2') }]

// ---------------------------------------------------------------------------
// A. 参数型预设（确定性）
// ---------------------------------------------------------------------------
test('timbresFromPrograms：probe 结果转成参数型音色（去空格、去重、坏条目丢弃）', () => {
  const timbres = timbresFromPrograms([
    { parameter: ' program ', values: [' PHAROH   ', 'Say Again.', 'PHAROH', '', 42, null] },
    { parameter: '', values: ['ignored'] },
    { parameter: 'bank', values: ['A'] },
    null,
    { parameter: 'program', values: 'not an array' },
  ])
  assert.deepEqual(
    timbres.map((timbre) => timbre.name),
    ['PHAROH', 'Say Again.', 'A'],
    '名字去空格、同参数同名的取值只留第一条、非字符串与空参数丢弃',
  )
  assert.deepEqual(timbres[0], {
    id: 'program:PHAROH',
    name: 'PHAROH',
    category: '',
    type: '',
    kind: 'parameter',
    parameter: 'program',
    value: 'PHAROH',
  }, '参数型音色必须带 kind/parameter/value，且没有 statePath')
  assert.equal(timbres[0].statePath, undefined, '参数型音色不能有 statePath')
  assert.equal(timbres[2].id, 'bank:A', 'id 形状是 <参数名>:<取值>')
  assert.deepEqual(timbresFromPrograms(null), [], '非数组输入返回空数组')
})

test('选源：preset 按名字 / id 解析成 presetParameter，不是 presetPath', async () => {
  const byName = compileScore({
    tracks: [{ name: 'lead', source: 'fake-fm', preset: 'PHAROH', notes: [[0, 0.5, 60, 100]] }],
  })
  const named = await selectSources(byName, { catalog: fakeCatalog, fonts: fakeFonts })
  assert.equal(named.vst3Tracks.length, 1, '显式 VST3 source 应交给侧车')
  const namedTrack = named.vst3Tracks[0]
  assert.deepEqual(
    namedTrack.presetParameter,
    { parameter: 'program', value: 'PHAROH' },
    '参数型预设必须解析成 presetParameter',
  )
  assert.equal(namedTrack.presetPath, undefined, '参数型预设不能落成状态文件路径')
  assert.equal(namedTrack.presetFile, undefined, '参数型预设不能落成插件预设文件')
  assert.equal(namedTrack.vst3.id, 'fake-fm')

  const byId = compileScore({
    tracks: [{ name: 'lead', source: 'fake-fm', preset: 'program:Say Again.', notes: [[0, 0.5, 60, 100]] }],
  })
  const ided = await selectSources(byId, { catalog: fakeCatalog, fonts: fakeFonts })
  assert.deepEqual(
    ided.vst3Tracks[0].presetParameter,
    { parameter: 'program', value: 'Say Again.' },
    'preset 也接受音色 id，取值里的空格与句点必须原样保留',
  )
})

test('选源：未知 preset 报错并列出该音源的参数型音色', async () => {
  const unknown = compileScore({
    tracks: [{ name: 'lead', source: 'fake-fm', preset: 'No Such Program', notes: [[0, 0.5, 60, 100]] }],
  })
  await assert.rejects(
    selectSources(unknown, { catalog: fakeCatalog, fonts: fakeFonts }),
    (err) => {
      assert.equal(err.name, 'ScoreError')
      assert.match(err.message, /has no preset "No Such Program"/)
      assert.match(err.message, /PHAROH/, '错误必须列出可用音色')
      assert.match(err.message, /Say Again\./, '错误必须列出可用音色')
      return true
    },
    '未知 preset 必须报错并列出该音源的音色',
  )
})

test('配置往返：参数型音色的 kind/parameter/value 留住，state 型条目形状不变', async () => {
  const configPath = useConfig('parameter-config.json')
  await writeFile(configPath, JSON.stringify({
    vst3: {
      timbres: [{
        path: 'C:\\VST3\\Dexed.vst3',
        timbres: [
          {
            id: 'program:PHAROH', name: 'PHAROH', category: '', type: '',
            kind: 'parameter', parameter: 'program', value: 'PHAROH',
          },
          { id: 'state-warm', name: 'Warm', category: 'Pad', type: 'Synth', statePath: 'C:\\p\\warm.state' },
          // 参数型缺 value：读配置时必须丢弃，不能变成一条没有取值的音色。
          { id: 'program:broken', name: 'Broken', kind: 'parameter', parameter: 'program' },
        ],
      }],
    },
  }), 'utf8')

  const { config } = await readConfig()
  const stored = config.vst3.timbres[0].timbres
  assert.equal(stored.length, 2, '缺 value 的参数型音色必须被丢弃')
  assert.deepEqual(stored[0], {
    id: 'program:PHAROH', name: 'PHAROH', category: '', type: '',
    kind: 'parameter', parameter: 'program', value: 'PHAROH',
  }, '参数型音色读回来必须还是参数型')
  assert.deepEqual(stored[1], {
    id: 'state-warm', name: 'Warm', category: 'Pad', type: 'Synth', statePath: 'C:\\p\\warm.state',
  }, 'state 型条目的形状不能因为参数型而改变')
})

test('侧车协议：{kind:"parameter"} 原样透传，缺字段按 kind=param 拦下', async () => {
  const manager = createVst3Process({ command: process.execPath, args: [FAKE_WORKER] })
  const task = (extra = {}) => ({
    plugin: fakePlugin,
    notes: [{ pitch: 60, start: 0, dur: 0.5, vel: 100 }],
    duration: 1,
    out: join(WORK, 'fake-out.wav'),
    ...extra,
  })
  try {
    for (const preset of [
      { kind: 'parameter', parameter: 'program' },
      { kind: 'parameter', parameter: '', value: 'PHAROH' },
      { kind: 'parameter', parameter: 'program', value: '   ' },
      { kind: 'bogus', path: 'x' },
    ]) {
      await assert.rejects(
        manager.render(task({ preset })),
        (err) => err.code === 'BAD_PRESET' && err.kind === 'param',
        `坏 preset 必须按 kind=param 拦下：${JSON.stringify(preset)}`,
      )
    }
    assert.equal(manager.getState().starts, 0, '参数校验不能启动进程')

    const parameter = await manager.render(task({
      preset: { kind: 'parameter', parameter: ' program ', value: ' PHAROH ' },
    }))
    assert.deepEqual(
      parameter.preset,
      { kind: 'parameter', parameter: 'program', value: 'PHAROH' },
      '参数型 preset 必须原样送到 worker（只去首尾空格）',
    )

    const state = await manager.render(task({ preset: { kind: 'state', path: ' C:\\p\\warm.state ' } }))
    assert.deepEqual(state.preset, { kind: 'state', path: 'C:\\p\\warm.state' }, 'state 型对象同样透传')
  } finally {
    await manager.shutdown()
  }
})

// ---------------------------------------------------------------------------
// B. 真实渲染（跳过保护）
// ---------------------------------------------------------------------------
const FRAME = 2048
const HOP = 1024

function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + len / 2] = aRe - bRe
        im[i + k + len / 2] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/** 平均频谱重心（Hz）：逐帧 FFT 后按幅度加权求频率均值，静音帧跳过。 */
function spectralCentroid(path) {
  const wav = parseWav(readFileSync(path))
  const mono = new Float32Array(wav.frames)
  for (let i = 0; i < wav.frames; i++) {
    let sum = 0
    for (const channel of wav.channels) sum += channel[i]
    mono[i] = sum / wav.channels.length
  }
  const window = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))
  const re = new Float64Array(FRAME)
  const im = new Float64Array(FRAME)
  let centroidSum = 0
  let frames = 0
  for (let start = 0; start + FRAME <= mono.length; start += HOP) {
    let energy = 0
    for (let i = 0; i < FRAME; i++) {
      const value = mono[start + i] * window[i]
      re[i] = value
      im[i] = 0
      energy += value * value
    }
    if (energy < 1e-6) continue
    fft(re, im)
    let weighted = 0
    let magnitudeSum = 0
    for (let bin = 1; bin < FRAME / 2; bin++) {
      const frequency = (bin * wav.sampleRate) / FRAME
      const magnitude = Math.hypot(re[bin], im[bin])
      weighted += frequency * magnitude
      magnitudeSum += magnitude
    }
    centroidSum += weighted / magnitudeSum
    frames++
  }
  return Math.round(centroidSum / Math.max(1, frames))
}

// 真实渲染：插件 / 运行时 / Python 依赖 / SoundFont 四样齐全才跑。
const renderSkip = []
for (const [label, plugin] of [['Dexed', DEXED], ['Grand Piano', GRAND_PIANO]]) {
  if (!existsSync(plugin)) renderSkip.push(`${label} 未安装（${plugin}）`)
}
if (!existsSync(REAL_PYTHON)) {
  renderSkip.push(`VST3 运行时不存在（${REAL_PYTHON}）`)
} else {
  const probe = spawnSync(REAL_PYTHON, ['-c', 'import pedalboard, numpy, mido'], { encoding: 'utf8', timeout: 60000 })
  if (probe.status !== 0) renderSkip.push('运行时缺少 pedalboard/numpy/mido')
}
const installedFonts = await listFonts()
if (installedFonts.length === 0) renderSkip.push('没有安装 SoundFont（node scripts/fetch-font.mjs）')

if (renderSkip.length > 0) {
  console.log(`SKIP 真实渲染：${renderSkip.join('；')}`)
} else {
  test('真实渲染：Dexed 两个参数型预设的频谱重心差 > 200 Hz', async () => {
    useConfig('dexed-config.json')
    // probe 是 /vst3/add 落盘参数型音色的同一条路径：先问插件有哪些具名程序，
    // 再写进配置，mergedCatalog 会按插件路径挂到内置 dexed 档案上。
    const manager = createVst3Process({ renderTimeoutMs: 180000, readyTimeoutMs: 120000, idleSec: 300 })
    let programs
    try {
      ({ programs } = await manager.probe(DEXED))
    } finally {
      await manager.shutdown()
    }
    const timbres = timbresFromPrograms(programs)
    const names = new Set(timbres.map((timbre) => timbre.name))
    if (!names.has('Say Again.') || !names.has('PHAROH')) {
      console.log(`SKIP Dexed 预设对比：本机 Dexed 没有 Say Again. / PHAROH（probe 到 ${names.size} 个音色）`)
      return
    }
    await writeFile(
      process.env.ANYAUDIO_CONFIG,
      JSON.stringify({ vst3: { timbres: [{ path: DEXED, timbres }] } }),
      'utf8',
    )
    const merged = await mergedCatalog()
    const dexed = merged.plugins.find((entry) => entry.id === 'dexed')
    assert.ok(dexed, '内置档案必须有 dexed')
    assert.ok(dexed.timbres.length > 0, 'mergedCatalog 必须把 probe 落盘的参数型音色挂到 dexed 上')

    const centroids = {}
    for (const preset of ['Say Again.', 'PHAROH']) {
      const projectId = await freshProject()
      const result = await musicToolDefinition.execute({
        projectId,
        score: {
          title: `dexed-${preset}`,
          // 高音区单音：两个预设的谐波分布差异在这里最明显。
          tracks: [{ name: 'lead', source: 'dexed', preset, notes: [[0, 1.5, 72, 100]] }],
        },
        durationSec: 2.5,
      }, exec)
      assert.equal(result.ok, true)
      assert.equal(result.tracks[0].sourceKind, 'vst3', '显式 VST3 source 必须走侧车')
      assert.equal(result.tracks[0].preset, preset, '逐轨报告必须写明音色名')
      assert.equal(result.vst3[0].preset, preset, 'vst3 汇总必须带 preset')
      assert.ok(!result.warnings.some((warning) => /fallback/.test(warning)), '显式 VST3 不应出现回退警告')
      const attached = result.attached[0]
      assert.ok(attached, '渲染结果必须挂进项目')
      centroids[preset] = spectralCentroid(join(projectDir(REPO_ROOT, projectId), attached.file))
    }
    const diff = Math.abs(centroids['Say Again.'] - centroids['PHAROH'])
    console.log(`Dexed 频谱重心：Say Again. ${centroids['Say Again.']} Hz，PHAROH ${centroids['PHAROH']} Hz，差 ${diff} Hz`)
    assert.ok(
      diff > 200,
      `两个预设的频谱重心差应大于 200 Hz，实际 ${diff} Hz`
      + `（Say Again. ${centroids['Say Again.']} Hz，PHAROH ${centroids['PHAROH']} Hz）`,
    )
  })

  test('真实渲染：Grand Piano 一个音的峰值 > 0.01', async () => {
    useConfig('grand-piano-config.json')
    const projectId = await freshProject()
    const result = await musicToolDefinition.execute({
      projectId,
      score: {
        title: 'grand-piano',
        tracks: [{ name: 'piano', source: 'grand-piano', notes: [[0, 1.5, 60, 100]] }],
      },
      durationSec: 2.5,
    }, exec)
    assert.equal(result.ok, true)
    assert.equal(result.tracks[0].sourceKind, 'vst3', '显式 VST3 source 必须走侧车')
    assert.equal(result.tracks[0].preset, undefined, '一档钢琴没有预设，报告不应带 preset')
    assert.ok(result.peakDb > -40, `mix 峰值应高于 -40 dBFS，实际 ${result.peakDb}`)
    const attached = result.attached[0]
    assert.ok(attached, '渲染结果必须挂进项目')
    const wav = parseWav(readFileSync(join(projectDir(REPO_ROOT, projectId), attached.file)))
    const peak = peakOf(wav.channels)
    assert.ok(peak > 0.01, `Grand Piano 渲染峰值应大于 0.01，实际 ${peak}`)
  })
}

// ---------------------------------------------------------------------------
// C. 鼓轨（确定性）
// ---------------------------------------------------------------------------
test('鼓轨：写 VST3 source 走 VST3 路径，track.vst3 被设置、drums 保留', async () => {
  const drums = compileScore({
    tracks: [{
      name: 'kit', drums: true, source: 'fake-drums',
      notes: [[0, 0.25, 36, 110], [0.5, 0.25, 38, 100], [1, 0.25, 42, 100]],
    }],
  })
  const selection = await selectSources(drums, { catalog: fakeCatalog, fonts: fakeFonts })
  assert.equal(selection.vst3Tracks.length, 1, '鼓轨写 VST3 source 必须走 VST3 路径')
  const track = selection.vst3Tracks[0]
  assert.equal(track.vst3.id, 'fake-drums', '鼓轨必须拿到 VST3 音源')
  assert.equal(track.drums, true, '鼓轨标记必须保留')
  assert.equal(track.vst3Fallback, undefined, '插件存在时不能标记回退')
  assert.deepEqual(
    track.notes.map((note) => note.midi),
    [36, 38, 42],
    'GM 鼓音符必须原样交给插件',
  )
  assert.equal(selection.sf2Compiled.tracks.length, 0, '鼓轨不能同时留在 SF2 计划里')
  assert.deepEqual(selection.warnings, [], `鼓轨写 VST3 不应有警告：${JSON.stringify(selection.warnings)}`)
})

test('鼓轨：写 SF2 source 仍走 SF2 路径', async () => {
  const drums = compileScore({
    tracks: [{ name: 'kit', drums: true, source: 'fake-font', notes: [[0, 0.25, 36, 110]] }],
  })
  const selection = await selectSources(drums, { catalog: fakeCatalog, fonts: fakeFonts })
  assert.equal(selection.vst3Tracks.length, 0, 'SF2 鼓轨不能进 VST3 计划')
  assert.equal(selection.sf2Compiled.tracks.length, 1, 'SF2 鼓轨必须留在 SF2 计划里')
  const track = selection.sf2Compiled.tracks[0]
  assert.equal(track.drums, true, '鼓轨标记必须保留')
  assert.equal(track.source, 'fake-font', 'SF2 鼓轨的 source 不能被改写')
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
