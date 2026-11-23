#!/usr/bin/env node
/**
 * VST3 预设导入、谱面校验与渲染链路测试。
 * Run: node test/vst3-presets.mjs
 *
 * 覆盖本轮「从清单选音源+音色」的测试面：
 *  1. 预设导入核心（假适配器注入）：匹配、扫描目录透传、归一化、按 id 去重、
 *     坏条目丢弃；没有适配器认领 / 适配器抛错 / 返回非数组 / 没有预设目录都只
 *     返回空数组，不整体失败；
 *  2. 真实适配器解析（fixture 目录 + 假 XML）：扩展名过滤、根元素属性解析、
 *     实体解码、坏文件跳过、文件名作音色名、id 稳定、排序；
 *  3. 真实预设目录冒烟：本机装了带预设的 VST3 音源时扫描结果非空、statePath
 *     存在、id 唯一；缺失 SKIP；
 *  4. scanAndStoreTimbres 幂等：写临时配置，第二次扫描 changed=false；
 *     mergedCatalog 按插件路径挂载 timbres；配置里的重复路径/坏条目被清洗；
 *  5. 谱面校验：preset 无 source 报错、preset 类型错报错、VST3 无 preset 用默认、
 *     未知 preset 报错并列出音色、不写 source 报错并附清单、source:"auto" 不再是
 *     魔法值、SF2 轨写 preset 被忽略并警告、鼓轨写 VST3 source 报错；
 *  6. 超音域报错文案只让改音高，不再建议换音源；
 *  7. list 的写法与谱面字段一致，且 list 只读不落盘配置；
 *  8. 真实渲染：source+preset 渲染成功且逐轨报告含 source/preset；不写 preset
 *     时报告不带 preset（插件 / venv / Python 依赖 / SoundFont 缺失 SKIP）。
 *
 * 约束：机器配置指向临时文件，绝不写用户配置；真实插件/目录缺失一律 SKIP，
 * 不因机器差异失败。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listFonts } from '../src/audio/fonts.js'
import { compileScore } from '../src/audio/score.js'
import { mergedCatalog } from '../src/audio/vst3-catalog.js'
import { PRESET_ADAPTERS } from '../src/audio/vst3-preset-adapters/index.js'
import { ampleSoundAdapter } from '../src/audio/vst3-preset-adapters/ample-sound.js'
import { presetAdapterIds, scanAndStoreTimbres, scanPluginTimbres } from '../src/audio/vst3-presets.js'
import { readConfig } from '../src/config.js'
import { createProject } from '../src/project/store.js'
import { musicToolDefinition, selectSources } from '../src/tools/music.js'
import { sourcesToolDefinition } from '../src/tools/sources.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(here, '..')
const WORK = mkdtempSync(join(tmpdir(), 'anyaudio-vst3-presets-'))
const ANYAUDIO = join(REPO_ROOT, '.anyaudio')
const PROJECTS = join(ANYAUDIO, 'projects')
const TMP = join(ANYAUDIO, 'tmp')
const OUT = join(ANYAUDIO, 'out')
const REAL_PYTHON = join(
  REPO_ROOT, '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
)

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
  const project = await createProject(REPO_ROOT, { name: `vst3-presets-${projectSeq}` })
  return project.id
}

// Shared fake catalog: a VST3 source whose plugin file exists (so selectSources
// never falls back) plus two timbres, and one SF2 source. Nothing here depends
// on what is installed on the machine.
const FIXTURE = join(WORK, 'fixtures')
await mkdir(FIXTURE, { recursive: true })
const fakePlugin = join(FIXTURE, 'FakeSynth.vst3')
await writeFile(fakePlugin, 'fake vst3 package')
const fakeStateA = join(FIXTURE, 'Warm Pad.state')
const fakeStateB = join(FIXTURE, 'Bass.state')
await writeFile(fakeStateA, '<AEB_STATE Name="Warm Pad"/>\n')
await writeFile(fakeStateB, '<AEB_STATE Name="Bass"/>\n')
const fakeCatalog = {
  version: 1,
  plugins: [{
    id: 'fake-synth',
    name: 'Fake Synth',
    vendor: 'Test',
    plugin: fakePlugin,
    format: 'vst3',
    instrument: true,
    range: { low: 28, high: 96 },
    families: { default: 5 },
    articulations: [],
    fxSounds: [],
    notes: '',
    timbres: [
      { id: 'timbre-warm', name: 'Warm Pad', category: 'Pad', type: 'Synth', statePath: fakeStateA },
      { id: 'timbre-bass', name: 'Bass', category: 'Bass', type: 'Bass', statePath: fakeStateB },
    ],
  }],
}
const fakeFonts = [{ id: 'fake-font', name: 'Fake Font', path: join(FIXTURE, 'fake.sf2') }]

// ---------------------------------------------------------------------------
test('预设导入核心：假适配器扫描、归一化、按 id 去重、坏条目丢弃', async () => {
  const fixtureDir = join(WORK, 'fake-presets')
  await mkdir(fixtureDir, { recursive: true })
  let seenDir = null
  const adapter = {
    id: 'fixture-adapter',
    async matches(pluginPath) { return pluginPath === fakePlugin },
    async presetDir() { return fixtureDir },
    async scan(dir) {
      seenDir = dir
      return [
        { presetId: 'p1', name: 'Warm Pad', category: 'Pad', type: 'Synth', statePath: join(dir, 'warm.state') },
        // Same id as p1: the first one wins.
        { presetId: 'p1', name: 'Duplicate id', category: 'X', type: 'Y', statePath: join(dir, 'dup.state') },
        { presetId: '', name: 'No id', statePath: join(dir, 'noid.state') },
        { presetId: 'p2', name: 'Bass', statePath: join(dir, 'bass.state') },
        { presetId: 'p3', name: '', statePath: join(dir, 'noname.state') },
        { presetId: 'p4', name: 'No state', statePath: '' },
        null,
        'not an object',
      ]
    },
  }
  PRESET_ADAPTERS.push(adapter)
  try {
    const timbres = await scanPluginTimbres(fakePlugin)
    assert.equal(seenDir, fixtureDir, '核心必须把适配器给的预设目录原样传进 scan')
    assert.deepEqual(timbres.map((timbre) => timbre.id), ['p1', 'p2'], '按 id 去重并丢掉缺字段的条目')
    assert.deepEqual(timbres[0], {
      id: 'p1',
      name: 'Warm Pad',
      category: 'Pad',
      type: 'Synth',
      statePath: join(fixtureDir, 'warm.state'),
    })
    assert.equal(timbres[1].category, '', '缺 category 归一成空串')
    assert.equal(timbres[1].type, '', '缺 type 归一成空串')
    assert.equal(timbres[1].statePath, join(fixtureDir, 'bass.state'))
  } finally {
    PRESET_ADAPTERS.pop()
  }
})

test('预设导入核心：没有适配器认领、适配器抛错、返回非数组都返回空数组', async () => {
  assert.deepEqual(await scanPluginTimbres(''), [], '空路径直接返回空数组')
  assert.deepEqual(await scanPluginTimbres(join(WORK, 'NoAdapter-xyz.vst3')), [], '没有适配器认领返回空数组')

  const throwingMatch = {
    id: 'throwing-match',
    async matches() { throw new Error('boom') },
    async presetDir() { return WORK },
    async scan() { return [{ presetId: 'x', name: 'X', statePath: 'x' }] },
  }
  PRESET_ADAPTERS.push(throwingMatch)
  try {
    assert.deepEqual(await scanPluginTimbres(join(WORK, 'NoAdapter-xyz.vst3')), [], 'matches 抛错按不匹配处理')
  } finally {
    PRESET_ADAPTERS.pop()
  }

  const noDir = {
    id: 'no-dir',
    async matches() { return true },
    async presetDir() { return null },
    async scan() { return [{ presetId: 'x', name: 'X', statePath: 'x' }] },
  }
  PRESET_ADAPTERS.push(noDir)
  try {
    assert.deepEqual(await scanPluginTimbres(join(WORK, 'NoAdapter-xyz.vst3')), [], '没有预设目录返回空数组')
  } finally {
    PRESET_ADAPTERS.pop()
  }

  const badScan = {
    id: 'bad-scan',
    async matches() { return true },
    async presetDir() { return WORK },
    async scan() { return 'not an array' },
  }
  PRESET_ADAPTERS.push(badScan)
  try {
    assert.deepEqual(await scanPluginTimbres(join(WORK, 'NoAdapter-xyz.vst3')), [], 'scan 返回非数组按空处理')
  } finally {
    PRESET_ADAPTERS.pop()
  }

  const throwingScan = {
    id: 'throwing-scan',
    async matches() { return true },
    async presetDir() { return WORK },
    async scan() { throw new Error('boom') },
  }
  PRESET_ADAPTERS.push(throwingScan)
  try {
    assert.deepEqual(await scanPluginTimbres(join(WORK, 'NoAdapter-xyz.vst3')), [], 'scan 抛错返回空数组')
  } finally {
    PRESET_ADAPTERS.pop()
  }

  const ids = presetAdapterIds()
  assert.ok(ids.length >= 1, '至少注册了一个预设适配器')
  assert.equal(new Set(ids).size, ids.length, '适配器 id 必须唯一')
  assert.ok(ids.every((id) => typeof id === 'string' && id.trim()), `适配器 id 必须是非空字符串：${JSON.stringify(ids)}`)
})

test('真实适配器解析：fixture 目录里的假 XML（扩展名过滤、属性解析、坏文件跳过、文件名作音色名）', async () => {
  const dir = join(WORK, 'adapter-fixture')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'Warm Pad.state'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<AEB_STATE Name="Warm &amp; Pad" Category="Pad" Type="Synth" Lib="x"/>\n',
    'utf8',
  )
  await writeFile(join(dir, 'Bass.abplstate'), "<AEB_STATE Name='Bass' Category='Bass' Type='Bass'/>", 'utf8')
  // Two files may carry the same XML Name; the file name is the identity.
  await writeFile(join(dir, 'Same Name A.state'), '<AEB_STATE Name="Same"/>', 'utf8')
  await writeFile(join(dir, 'Same Name B.state'), '<AEB_STATE Name="Same"/>', 'utf8')
  // Not a preset: extension does not end in "state".
  await writeFile(join(dir, 'notes.txt'), '<AEB_STATE Name="Not a preset"/>', 'utf8')
  // Broken presets are skipped, not fatal.
  await writeFile(join(dir, 'broken.state'), 'this is not xml at all', 'utf8')
  await writeFile(join(dir, 'declaration-only.state'), '<?xml version="1.0"?>', 'utf8')

  const timbres = await ampleSoundAdapter.scan(dir)
  assert.deepEqual(
    timbres.map((timbre) => timbre.name),
    ['Bass', 'Same Name A', 'Same Name B', 'Warm Pad'],
    '按文件名排序；扩展名不以 state 结尾的跳过；坏 XML 跳过',
  )
  const byName = new Map(timbres.map((timbre) => [timbre.name, timbre]))
  assert.equal(byName.get('Warm Pad').label, 'Warm & Pad', 'XML 实体必须解码')
  assert.equal(byName.get('Warm Pad').category, 'Pad')
  assert.equal(byName.get('Warm Pad').type, 'Synth')
  assert.equal(byName.get('Warm Pad').statePath, join(dir, 'Warm Pad.state'))
  assert.equal(byName.get('Bass').label, 'Bass')
  assert.equal(byName.get('Bass').category, 'Bass')
  assert.equal(byName.get('Same Name A').label, 'Same', 'XML Name 只作元数据')
  assert.equal(byName.get('Same Name B').label, 'Same', '同名 XML 不合并两条音色')
  // The adapter speaks the raw shape ({ presetId }); vst3-presets.js renames it
  // to { id } when it normalises (covered by the fake-adapter test above).
  for (const timbre of timbres) {
    assert.match(timbre.presetId, /^preset-[0-9a-f]{10}$/, `音色 id 形状不对：${timbre.presetId}`)
  }
  assert.equal(new Set(timbres.map((timbre) => timbre.presetId)).size, timbres.length, '音色 id 必须唯一')

  // Ids are stable across scans (the state file path is the identity).
  const again = await ampleSoundAdapter.scan(dir)
  assert.deepEqual(
    again.map((timbre) => timbre.presetId),
    timbres.map((timbre) => timbre.presetId),
    '重复扫描 id 必须稳定',
  )

  assert.deepEqual(await ampleSoundAdapter.scan(join(WORK, 'no-such-preset-dir')), [], '目录不存在返回空数组')
  const unknownPlugin = join(WORK, 'DefinitelyNotInstalled-xyz.vst3')
  assert.equal(await ampleSoundAdapter.matches(unknownPlugin), false, '没有预设目录的插件不认领')
  assert.equal(await ampleSoundAdapter.presetDir(unknownPlugin), null, '没有预设目录返回 null')
})

// 真实预设目录冒烟：本机装了带预设的 VST3 音源才跑，缺失 SKIP。
const installedWithPresets = []
for (const entry of (await mergedCatalog()).plugins) {
  if (!existsSync(entry.plugin)) continue
  const timbres = await scanPluginTimbres(entry.plugin)
  if (timbres.length > 0) installedWithPresets.push({ entry, timbres })
}
if (installedWithPresets.length === 0) {
  console.log('SKIP 真实预设目录冒烟：本机没有带预设的已装 VST3 音源')
} else {
  test('真实预设目录冒烟：扫描结果非空、statePath 存在、id 唯一', () => {
    for (const { entry, timbres } of installedWithPresets) {
      assert.ok(timbres.length > 0, `${entry.id} 应扫到音色`)
      const ids = new Set()
      for (const timbre of timbres) {
        assert.ok(timbre.id && timbre.name && timbre.statePath, `${entry.id} 的音色缺字段：${JSON.stringify(timbre)}`)
        assert.ok(existsSync(timbre.statePath), `音色状态文件必须存在：${timbre.statePath}`)
        assert.ok(!ids.has(timbre.id), `${entry.id} 的音色 id 重复：${timbre.id}`)
        ids.add(timbre.id)
      }
    }
  })
}

test('scanAndStoreTimbres：临时配置里幂等落盘，mergedCatalog 按路径挂载音色', async () => {
  useConfig('scan-config.json')
  const first = await scanAndStoreTimbres()
  assert.equal(typeof first.changed, 'boolean')
  assert.ok(Array.isArray(first.plugins) && first.plugins.length >= 1, '每个音源都要报告扫描结果')
  for (const plugin of first.plugins) {
    assert.ok(plugin.id && plugin.name && plugin.path, `扫描报告缺字段：${JSON.stringify(plugin)}`)
    assert.ok(Number.isInteger(plugin.timbres) && plugin.timbres >= 0, `音色数必须是非负整数：${plugin.timbres}`)
  }
  assert.equal(first.total, first.plugins.reduce((sum, plugin) => sum + plugin.timbres, 0), 'total 必须等于各音源音色数之和')
  assert.equal(first.changed, first.total > 0, '空配置下第一次扫描：有音色才写文件')

  const second = await scanAndStoreTimbres()
  assert.equal(second.changed, false, '结果没变时第二次扫描不写配置')
  assert.equal(second.total, first.total, '重复扫描不累积音色')

  const { config } = await readConfig()
  assert.ok(Array.isArray(config.vst3.timbres))
  const withTimbres = first.plugins.filter((plugin) => plugin.timbres > 0)
  assert.equal(config.vst3.timbres.length, withTimbres.length, '配置里只留真正有音色的音源')
  for (const stored of config.vst3.timbres) {
    assert.ok(stored.timbres.length > 0, '配置里不应留空音色条目')
  }

  // mergedCatalog mounts the stored timbres by plugin path (case-insensitive).
  const merged = await mergedCatalog()
  for (const stored of config.vst3.timbres) {
    const entry = merged.plugins.find((plugin) => plugin.plugin.toLowerCase() === stored.path.toLowerCase())
    assert.ok(entry, `配置里的路径必须对应一个音源：${stored.path}`)
    assert.deepEqual(entry.timbres, stored.timbres, 'mergedCatalog 必须原样挂载配置里的音色')
  }
})

test('配置清洗：vst3.timbres 的重复路径与坏条目被丢弃并记 issue', async () => {
  const configPath = useConfig('normalize-config.json')
  await writeFile(configPath, JSON.stringify({
    vst3: {
      timbres: [
        { path: 'C:\\VST3\\A.vst3', timbres: [{ id: 'a', name: 'A', category: 'Pad', type: 'Synth', statePath: 'C:\\p\\a.state' }] },
        // Same path, different case: Windows paths are case-insensitive.
        { path: 'c:\\vst3\\a.VST3', timbres: [{ id: 'b', name: 'B' }] },
        { path: '', timbres: [] },
        'not an object',
        {
          path: 'C:\\VST3\\B.vst3',
          timbres: [
            { id: '', name: 'no id' },
            { id: 'c', name: 'C', statePath: 42 },
            null,
          ],
        },
      ],
    },
  }), 'utf8')

  const { config, issues } = await readConfig()
  assert.equal(config.vst3.timbres.length, 2, '重复路径与坏条目必须被丢弃')
  assert.equal(config.vst3.timbres[0].path, 'C:\\VST3\\A.vst3')
  assert.equal(config.vst3.timbres[1].path, 'C:\\VST3\\B.vst3')
  assert.deepEqual(
    config.vst3.timbres[1].timbres,
    [{ id: 'c', name: 'C', category: '', type: '', statePath: '' }],
    '缺字段的音色归一成空串，坏条目丢弃',
  )
  assert.ok(issues.some((issue) => /duplicate/.test(issue)), `重复路径应记 issue：${issues.join(' | ')}`)
  assert.ok(issues.some((issue) => /not an object/.test(issue)), `坏条目应记 issue：${issues.join(' | ')}`)
})

test('谱面校验：preset 必须配 source，类型错直接报错', () => {
  assert.throws(
    () => compileScore({ tracks: [{ name: 'lead', instrument: 'bass', preset: 'Mute G', notes: [[0, 0.5, 40, 100]] }] }),
    (err) => {
      assert.equal(err.name, 'ScoreError')
      assert.match(err.message, /track "lead"/)
      assert.match(err.message, /preset "Mute G" needs a source/)
      assert.match(err.message, /anyaudio_sources/)
      return true
    },
    'preset 没有 source 必须报错',
  )
  assert.throws(
    () => compileScore({ tracks: [{ name: 'lead', instrument: 'bass', source: 'ample-bass-p-lite', preset: 42, notes: [[0, 0.5, 40, 100]] }] }),
    (err) => err.name === 'ScoreError' && /preset must be a non-empty string/.test(err.message),
    'preset 不是字符串必须报错',
  )
  assert.throws(
    () => compileScore({ tracks: [{ name: 'lead', instrument: 'bass', source: 'ample-bass-p-lite', preset: '   ', notes: [[0, 0.5, 40, 100]] }] }),
    /preset must be a non-empty string/,
    'preset 只有空白必须报错',
  )
  // An empty string means "not written": no error, no preset on the track.
  const compiled = compileScore({
    tracks: [{ name: 'lead', instrument: 'bass', source: 'ample-bass-p-lite', preset: '', notes: [[0, 0.5, 40, 100]] }],
  })
  assert.equal(compiled.tracks[0].preset, undefined, '空串 preset 等于没写')
})

test('选源：VST3 无 preset 用默认；preset 按名字/ id 解析到状态文件；未知 preset 报错并列出音色', async () => {
  const noPreset = compileScore({
    tracks: [{ name: 'lead', instrument: 'piano', source: 'fake-synth', notes: [[0, 0.5, 60, 100]] }],
  })
  const plain = await selectSources(noPreset, { catalog: fakeCatalog, fonts: fakeFonts })
  assert.equal(plain.vst3Tracks.length, 1, '显式 VST3 source 应交给侧车')
  assert.equal(plain.vst3Tracks[0].presetPath, undefined, '不写 preset 时用插件默认音色')
  assert.equal(plain.warnings.length, 0, `不写 preset 不该有警告：${JSON.stringify(plain.warnings)}`)

  const byName = compileScore({
    tracks: [{ name: 'lead', instrument: 'piano', source: 'fake-synth', preset: 'Warm Pad', notes: [[0, 0.5, 60, 100]] }],
  })
  const named = await selectSources(byName, { catalog: fakeCatalog, fonts: fakeFonts })
  assert.equal(named.vst3Tracks[0].presetPath, fakeStateA, 'preset 按音色名解析到状态文件')

  const byId = compileScore({
    tracks: [{ name: 'lead', instrument: 'piano', source: 'fake-synth', preset: 'timbre-bass', notes: [[0, 0.5, 60, 100]] }],
  })
  const ided = await selectSources(byId, { catalog: fakeCatalog, fonts: fakeFonts })
  assert.equal(ided.vst3Tracks[0].presetPath, fakeStateB, 'preset 也接受音色 id')

  const unknown = compileScore({
    tracks: [{ name: 'lead', instrument: 'piano', source: 'fake-synth', preset: 'No Such Timbre', notes: [[0, 0.5, 60, 100]] }],
  })
  await assert.rejects(
    selectSources(unknown, { catalog: fakeCatalog, fonts: fakeFonts }),
    (err) => {
      assert.equal(err.name, 'ScoreError')
      assert.match(err.message, /has no preset "No Such Timbre"/)
      assert.match(err.message, /Warm Pad/)
      assert.match(err.message, /Bass/)
      return true
    },
    '未知 preset 必须报错并列出该音源的音色',
  )
})

test('选源：不写 source 报错并附完整清单；source:"auto" 不再是魔法值', async () => {
  const missing = compileScore({ tracks: [{ name: 'lead', instrument: 'piano', notes: [[0, 0.5, 60, 100]] }] })
  await assert.rejects(
    selectSources(missing, { catalog: fakeCatalog, fonts: fakeFonts }),
    (err) => {
      assert.equal(err.name, 'ScoreError')
      assert.match(err.message, /track "lead" names no source/)
      assert.match(err.message, /Available sources:/)
      assert.match(err.message, /\[SF2\] fake-font — Fake Font/)
      assert.match(err.message, /\[VST3\] fake-synth — Fake Synth; preset: Warm Pad, Bass/)
      return true
    },
    '不写 source 必须报错并附可用清单',
  )

  // Auto source selection was removed: "auto" is just an unknown id now.
  const auto = compileScore({ tracks: [{ name: 'lead', instrument: 'piano', source: 'auto', notes: [[0, 0.5, 60, 100]] }] })
  await assert.rejects(
    selectSources(auto, { catalog: fakeCatalog, fonts: fakeFonts }),
    /unknown sound source "auto"/,
    'source:"auto" 不能再被当成自动选源',
  )
})

test('选源：SF2 轨写 preset 被忽略并警告；鼓轨写 VST3 source 报错', async () => {
  const sf2Preset = compileScore({
    tracks: [{ name: 'pad', instrument: 'piano', source: 'fake-font', preset: 'Warm Pad', notes: [[0, 0.5, 60, 100]] }],
  })
  const sf2 = await selectSources(sf2Preset, { catalog: fakeCatalog, fonts: fakeFonts })
  assert.equal(sf2.vst3Tracks.length, 0, 'SF2 轨不能进 VST3 计划')
  assert.ok(
    sf2.warnings.some((warning) => /preset "Warm Pad" only applies to a VST3 source/.test(warning)),
    `SF2 轨写 preset 必须警告：${JSON.stringify(sf2.warnings)}`,
  )

  const drums = compileScore({
    tracks: [{ name: 'kit', drums: true, source: 'fake-synth', notes: [[0, 0.25, 36, 100]] }],
  })
  await assert.rejects(
    selectSources(drums, { catalog: fakeCatalog, fonts: fakeFonts }),
    /drum track.*VST3 instrument/,
    '鼓轨写 VST3 source 必须报错（鼓组永远来自默认 SF2 库）',
  )
})

test('超音域报错只让改音高，不再建议换音源', () => {
  const score = {
    tracks: [{ name: '超低贝斯', instrument: 'bass', source: 'ample-bass-p-lite', notes: [[0, 0.5, 20, 100]] }],
  }
  assert.throws(() => compileScore(score), (err) => {
    assert.equal(err.name, 'ScoreError')
    assert.match(err.message, /track "超低贝斯"/, '错误必须点名音轨')
    assert.match(err.message, /MIDI 40-72/, '错误必须给出实测音域')
    assert.match(err.message, /pitch 20/, '错误必须给出越界音高')
    assert.match(err.message, /Move the pitch into range\./, '错误必须给出下一步')
    assert.doesNotMatch(
      err.message,
      /choose another source|another source|换音源|换一个音源/i,
      '超音域不该再建议换音源（选源是写谱人的职责，不是修音高的手段）',
    )
    return true
  })
})

test('list 的写法与谱面字段一致，且 list 只读不落盘配置', async () => {
  const configPath = useConfig('list-config.json')
  const listed = await sourcesToolDefinition.execute({ action: 'list' }, exec)
  assert.equal(listed.ok, true)
  assert.equal(listed.action, 'list')
  assert.ok(Array.isArray(listed.fonts), 'list 必须返回 fonts 数组')
  assert.ok(Array.isArray(listed.vst3), 'list 必须返回 vst3 数组')
  assert.ok(listed.vst3.length >= 1, '内置 VST3 音源必须出现在清单里')

  for (const entry of listed.vst3) {
    assert.equal(entry.kind, 'vst3')
    assert.ok(entry.id && entry.name, `VST3 条目缺 id/name：${JSON.stringify(entry)}`)
    assert.ok(Array.isArray(entry.timbres), `${entry.id} 的 timbres 必须是数组`)
    if (entry.timbresTruncated) assert.ok(entry.timbreCount > entry.timbres.length, '截断时总数必须大于预览数')
    else assert.equal(entry.timbreCount, entry.timbres.length, '未截断时总数必须等于预览数')
    for (const timbre of entry.timbres) {
      assert.equal(
        timbre.write,
        `source:"${entry.id}", preset:"${timbre.name}"`,
        'VST3 音色的写法必须是 source + preset',
      )
    }
  }

  for (const font of listed.fonts) {
    assert.equal(font.kind, 'sf2')
    assert.ok(font.id && font.name, `SF2 条目缺 id/name：${JSON.stringify(font)}`)
    assert.ok(Array.isArray(font.timbres), `${font.id} 的 timbres 必须是数组`)
    for (const timbre of font.timbres) {
      assert.match(timbre.write, /^instrument:/, 'SF2 音色的写法必须是 instrument')
    }
  }

  // What the agent actually reads: every source must show its write hint and its
  // timbres, so "pick from the list" is possible without guessing.
  const text = sourcesToolDefinition.output.render({ action: 'list' }, listed).map((block) => block.text).join('\n')
  assert.match(text, /每条轨都要写 source/, '清单开头必须说明每条轨都要写 source')
  for (const entry of [...listed.fonts, ...listed.vst3]) {
    assert.ok(text.includes(`写法: source:"${entry.id}"`), `清单必须给出 ${entry.id} 的写法`)
    assert.ok(text.includes('音色:'), `清单必须给出 ${entry.id} 的音色`)
  }
  for (const entry of listed.vst3) {
    if (entry.timbres.length > 0) {
      assert.ok(text.includes('preset:"<音色名>"'), `VST3 清单必须给出 preset 写法：${entry.id}`)
      assert.ok(text.includes(entry.timbres[0].name), `VST3 清单必须列出音色名：${entry.id}`)
    } else {
      assert.ok(text.includes('不写 preset，用该音源默认音色'), `没有音色的 ${entry.id} 必须说明用默认音色`)
    }
  }

  assert.equal(existsSync(configPath), false, 'list 只读：工具调用不能落盘配置')
})

// 真实渲染：插件 / venv / Python 依赖 / SoundFont 四样齐全才跑。
const renderSkip = []
const renderCandidates = []
for (const entry of (await mergedCatalog()).plugins) {
  if (!existsSync(entry.plugin)) continue
  const timbres = await scanPluginTimbres(entry.plugin)
  if (timbres.length > 0) renderCandidates.push({ entry, timbres })
}
if (renderCandidates.length === 0) renderSkip.push('没有带预设的已装 VST3 音源')
if (!existsSync(REAL_PYTHON)) {
  renderSkip.push(`项目 venv 不存在（${REAL_PYTHON}）`)
} else {
  const probe = spawnSync(REAL_PYTHON, ['-c', 'import pedalboard, numpy, mido'], { encoding: 'utf8', timeout: 60000 })
  if (probe.status !== 0) renderSkip.push('venv 缺少 pedalboard/numpy/mido')
}
const installedFonts = await listFonts()
if (installedFonts.length === 0) renderSkip.push('没有安装 SoundFont（node scripts/fetch-font.mjs）')

if (renderSkip.length > 0) {
  console.log(`SKIP 真实渲染：${renderSkip.join('；')}`)
} else {
  test('真实渲染：source+preset 渲染成功，逐轨报告含 source/preset', async () => {
    useConfig('render-config.json')
    const { entry, timbres } = renderCandidates[0]
    const presetName = timbres[0].name
    const pitch = entry.range ? Math.min(Math.max(60, entry.range.low), entry.range.high) : 60
    const projectId = await freshProject()
    const result = await musicToolDefinition.execute({
      projectId,
      score: {
        title: 'preset-render',
        tracks: [{ name: 'lead', instrument: 'piano', source: entry.id, preset: presetName, notes: [[0, 1.2, pitch, 100]] }],
      },
      durationSec: 2,
    }, exec)

    assert.equal(result.ok, true)
    assert.equal(result.tracks.length, 1)
    const track = result.tracks[0]
    assert.equal(track.source, entry.id, '逐轨报告必须写明音源 id')
    assert.equal(track.sourceKind, 'vst3', '显式 VST3 source 必须走侧车')
    assert.equal(track.preset, presetName, '逐轨报告必须写明音色名')
    assert.equal(result.vst3.length, 1)
    assert.equal(result.vst3[0].id, entry.id)
    assert.equal(result.vst3[0].track, 'lead')
    assert.equal(result.vst3[0].preset, presetName, 'vst3 汇总必须带 preset')
    assert.ok(result.peakDb > -40, `mix 峰值应高于 -40 dBFS，实际 ${result.peakDb}`)
    assert.ok(result.peakDb <= 0, `mix 峰值不应超过 0 dBFS，实际 ${result.peakDb}`)
    assert.ok(result.file && existsSync(join(REPO_ROOT, result.file)), `渲染文件必须存在：${result.file}`)
    assert.ok(!result.warnings.some((warning) => /fallback/.test(warning)), '显式 VST3 不应出现回退警告')
  })

  test('真实渲染：VST3 不写 preset 用默认音色，报告不带 preset', async () => {
    useConfig('render-config.json')
    const { entry } = renderCandidates[0]
    const pitch = entry.range ? Math.min(Math.max(60, entry.range.low), entry.range.high) : 60
    const projectId = await freshProject()
    const result = await musicToolDefinition.execute({
      projectId,
      score: {
        title: 'default-timbre',
        tracks: [{ name: 'lead', instrument: 'piano', source: entry.id, notes: [[0, 1.2, pitch, 100]] }],
      },
      durationSec: 2,
    }, exec)

    assert.equal(result.ok, true)
    assert.equal(result.tracks[0].source, entry.id)
    assert.equal(result.tracks[0].sourceKind, 'vst3')
    assert.equal(result.tracks[0].preset, undefined, '没写 preset 时逐轨报告不应带 preset')
    assert.equal(result.vst3[0].preset, undefined, '没写 preset 时 vst3 汇总不应带 preset')
    assert.ok(result.peakDb > -40, `mix 峰值应高于 -40 dBFS，实际 ${result.peakDb}`)
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
