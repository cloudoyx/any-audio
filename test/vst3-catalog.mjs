#!/usr/bin/env node
/**
 * VST3 音色档案与演奏法常量测试。
 * Run: node test/vst3-catalog.mjs
 *
 * 覆盖内置档案数据、validateCatalog 的中文报错、loadCatalog/saveCatalog 的
 * 读写与往返一致，以及 vst3-techniques.js 的键位/力度常量。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CATALOG_VERSION, Vst3CatalogError, builtInCatalog, loadCatalog, saveCatalog, validateCatalog,
} from '../src/audio/vst3-catalog.js'
import {
  ARTICULATIONS, BASS_KEYS, GUITAR_CONTROL_KEYS, GUITAR_FX_SOUNDS,
  KEYSWITCH_HOLD_SEC, KEYSWITCH_LEAD_SEC, VELOCITY,
} from '../src/audio/vst3-techniques.js'

const WORK = await mkdtemp(join(tmpdir(), 'anyaudio-vst3-catalog-'))
const tests = []
function test(name, fn) { tests.push([name, fn]) }

function expectCatalogError(run, pattern, label) {
  assert.throws(run, (err) => {
    assert.equal(err.name, 'Vst3CatalogError', `${label}：必须抛 Vst3CatalogError`)
    assert.match(err.message, pattern, `${label}：错误信息应匹配 ${pattern}`)
    return true
  }, label)
}

function mutateCatalog(index, mutate) {
  const data = builtInCatalog()
  mutate(data.plugins[index], data)
  return data
}

// ---------------------------------------------------------------------------
test('内置档案：版本、四个插件与实测音域', () => {
  const catalog = builtInCatalog()
  assert.equal(CATALOG_VERSION, 1)
  assert.equal(catalog.version, CATALOG_VERSION)
  assert.equal(catalog.plugins.length, 4)
  // 按 id 找，不按位置：以后再加档案也不会让这条测试挂掉。
  const byId = new Map(catalog.plugins.map((entry) => [entry.id, entry]))
  const bass = byId.get('ample-bass-p-lite')
  const guitar = byId.get('ample-guitar-m-lite')
  assert.ok(bass, '内置档案必须有 ABPL')
  assert.ok(guitar, '内置档案必须有 AGML')
  assert.deepEqual(bass.range, { low: 40, high: 72 })
  assert.deepEqual(guitar.range, { low: 42, high: 84 })
  for (const entry of catalog.plugins) {
    assert.equal(entry.format, 'vst3')
    assert.equal(entry.instrument, true)
    assert.match(entry.plugin, /^C:\\Program Files\\Common Files\\VST3\\/)
    assert.ok(entry.plugin.endsWith('.vst3'))
  }
  assert.ok(bass.plugin.endsWith('\\ABPL.vst3'))
  assert.ok(guitar.plugin.endsWith('\\AGML.vst3'))
})

test('内置档案：四个演奏法键位 24/26/28/30，AGML 11 个效果音', () => {
  const [bass, guitar] = builtInCatalog().plugins
  for (const entry of [bass, guitar]) {
    assert.deepEqual(entry.articulations.map((item) => item.keyswitch), [24, 26, 28, 30])
    assert.deepEqual(entry.articulations.map((item) => item.id), ['sus', 'pm', 'ls', 'hp'])
    assert.deepEqual(entry.articulations, ARTICULATIONS, '档案里的演奏法必须来自 vst3-techniques 常量')
  }
  assert.deepEqual(bass.fxSounds, [])
  assert.equal(guitar.fxSounds.length, 11)
  assert.deepEqual(guitar.fxSounds.map((item) => item.keyswitch), [77, 78, 79, 80, 81, 82, 83, 84, 89, 90, 91])
  assert.deepEqual(guitar.fxSounds, GUITAR_FX_SOUNDS, '档案里的效果音必须来自 vst3-techniques 常量')
})

test('builtInCatalog 每次返回新对象，改一份不污染下一份', () => {
  const first = builtInCatalog()
  first.plugins[0].range.low = 0
  first.plugins[0].articulations[0].keyswitch = 1
  first.plugins.push({})
  const second = builtInCatalog()
  assert.equal(second.plugins.length, 4)
  assert.equal(second.plugins[0].range.low, 40)
  assert.equal(second.plugins[0].articulations[0].keyswitch, 24)
})

test('validateCatalog 接受内置档案并原样返回', () => {
  const catalog = builtInCatalog()
  assert.equal(validateCatalog(catalog), catalog)
})

test('validateCatalog：档案级缺字段/类型错报中文错', () => {
  expectCatalogError(() => validateCatalog(null), /音色档案必须是一个对象/, 'null')
  expectCatalogError(() => validateCatalog([]), /音色档案必须是一个对象/, '数组')
  expectCatalogError(() => validateCatalog({}), /音色档案缺少 plugins 数组/, '缺 plugins')
  expectCatalogError(() => validateCatalog({ plugins: [] }), /plugins 不能是空数组/, '空 plugins')
  expectCatalogError(() => validateCatalog({ version: 0, plugins: builtInCatalog().plugins }), /version 必须是正整数/, 'version 0')
  expectCatalogError(() => validateCatalog({ version: '1', plugins: builtInCatalog().plugins }), /version 必须是正整数/, 'version 字符串')
})

test('validateCatalog：插件缺字段报中文错', () => {
  const cases = [
    ['id', (plugin) => { delete plugin.id }, /plugins\[0\]\.id 必须是非空字符串/],
    ['name', (plugin) => { delete plugin.name }, /plugins\[0\]\.name 必须是非空字符串/],
    ['vendor', (plugin) => { delete plugin.vendor }, /plugins\[0\]\.vendor 必须是非空字符串/],
    ['plugin', (plugin) => { delete plugin.plugin }, /plugins\[0\]\.plugin 必须是非空字符串/],
    ['range', (plugin) => { delete plugin.range }, /plugins\[0\]\.range 必须是 \{ low, high \} 对象/],
    ['articulations', (plugin) => { delete plugin.articulations }, /plugins\[0\]\.articulations 必须是数组/],
    ['fxSounds', (plugin) => { delete plugin.fxSounds }, /plugins\[0\]\.fxSounds 必须是数组/],
    ['notes', (plugin) => { delete plugin.notes }, /plugins\[0\]\.notes 必须是字符串/],
  ]
  for (const [label, mutate, pattern] of cases) {
    expectCatalogError(() => validateCatalog(mutateCatalog(0, mutate)), pattern, `缺 ${label}`)
  }
})

test('validateCatalog：插件类型错报中文错', () => {
  const cases = [
    ['format', 0, (plugin) => { plugin.format = 'vst2' }, /plugins\[0\]\.format 必须是 "vst3"/],
    ['instrument', 0, (plugin) => { plugin.instrument = false }, /plugins\[0\]\.instrument 必须是 true/],
    ['range.low 小数', 0, (plugin) => { plugin.range.low = 40.5 }, /plugins\[0\]\.range\.low 必须是 0-127 的整数/],
    ['range.high 越界', 0, (plugin) => { plugin.range.high = 200 }, /plugins\[0\]\.range\.high 必须是 0-127 的整数/],
    ['articulation 非对象', 0, (plugin) => { plugin.articulations[0] = 'sus' }, /plugins\[0\]\.articulations\[0\] 必须是对象/],
    ['keyswitch 越界', 0, (plugin) => { plugin.articulations[0].keyswitch = 128 }, /plugins\[0\]\.articulations\[0\]\.keyswitch 必须是 0-127 的整数/],
    ['效果音缺 name', 1, (plugin) => { delete plugin.fxSounds[0].name }, /plugins\[1\]\.fxSounds\[0\]\.name 必须是非空字符串/],
  ]
  for (const [label, index, mutate, pattern] of cases) {
    expectCatalogError(() => validateCatalog(mutateCatalog(index, mutate)), pattern, label)
  }
})

test('validateCatalog：重复 id 与重复键位报中文错', () => {
  const duplicateId = builtInCatalog()
  duplicateId.plugins[1].id = duplicateId.plugins[0].id
  expectCatalogError(
    () => validateCatalog(duplicateId),
    /plugins\[1\]\.id "ample-bass-p-lite" 与前面的条目重复/,
    '重复 id',
  )

  const duplicateKey = builtInCatalog()
  duplicateKey.plugins[0].articulations[1].keyswitch = 24
  expectCatalogError(
    () => validateCatalog(duplicateKey),
    /plugins\[0\]\.articulations\[1\]\.keyswitch 24 与同一列表里的其他键位重复/,
    '重复键位',
  )

  const duplicateFx = builtInCatalog()
  duplicateFx.plugins[1].fxSounds[1].keyswitch = 77
  expectCatalogError(
    () => validateCatalog(duplicateFx),
    /plugins\[1\]\.fxSounds\[1\]\.keyswitch 77 与同一列表里的其他键位重复/,
    '效果音重复键位',
  )
})

test('validateCatalog：low > high 报中文错', () => {
  const data = builtInCatalog()
  data.plugins[0].range = { low: 80, high: 40 }
  expectCatalogError(
    () => validateCatalog(data),
    /plugins\[0\]\.range\.low \(80\) 不能大于 range\.high \(40\)/,
    'low>high',
  )
})

test('validateCatalog：未知字段保留（档案是给人手改的 JSON）', () => {
  const data = builtInCatalog()
  data.plugins[0].remark = '手写备注'
  data.updatedAt = '2026-11-23'
  assert.equal(validateCatalog(data), data)
  assert.equal(data.plugins[0].remark, '手写备注')
})

test('loadCatalog：空路径、不存在路径、坏 JSON、校验不过都报中文错', async () => {
  await assert.rejects(loadCatalog(''), (err) => err.name === 'Vst3CatalogError' && /需要文件路径/.test(err.message))
  await assert.rejects(
    loadCatalog(join(WORK, 'nope.json')),
    (err) => err.name === 'Vst3CatalogError' && /读取音色档案失败/.test(err.message),
  )
  const badJson = join(WORK, 'bad.json')
  await writeFile(badJson, '{ not json', 'utf8')
  await assert.rejects(
    loadCatalog(badJson),
    (err) => err.name === 'Vst3CatalogError' && /不是合法 JSON/.test(err.message),
  )
  const invalid = join(WORK, 'invalid.json')
  await writeFile(invalid, JSON.stringify({ plugins: [] }), 'utf8')
  await assert.rejects(
    loadCatalog(invalid),
    (err) => err.name === 'Vst3CatalogError' && /plugins 不能是空数组/.test(err.message),
  )
})

test('saveCatalog → loadCatalog 往返一致（UTF-8、两空格缩进、结尾换行）', async () => {
  const target = join(WORK, 'nested', 'deep', 'catalog.json')
  assert.equal(await saveCatalog(target, builtInCatalog()), target)
  const text = await readFile(target, 'utf8')
  assert.ok(text.endsWith('\n'), '文件应以换行结尾')
  assert.ok(text.includes('\n  "version": 1'), '应为两空格缩进')
  assert.ok(!text.startsWith('\uFEFF'), '不能写 BOM')
  assert.deepEqual(await loadCatalog(target), builtInCatalog())
})

test('saveCatalog：校验不过不落盘，空路径报错', async () => {
  const target = join(WORK, 'invalid-save.json')
  const data = builtInCatalog()
  data.plugins[0].range = { low: 90, high: 10 }
  await assert.rejects(
    saveCatalog(target, data),
    (err) => err.name === 'Vst3CatalogError' && /不能大于/.test(err.message),
  )
  assert.equal(existsSync(target), false, '校验失败不能留下文件')
  await assert.rejects(saveCatalog('', builtInCatalog()), /需要文件路径/)
})

test('演奏法常量：键位、时长与力度语义', () => {
  assert.equal(KEYSWITCH_LEAD_SEC, 0.02)
  assert.equal(KEYSWITCH_HOLD_SEC, 0.02)
  assert.deepEqual(
    ARTICULATIONS.map((item) => [item.id, item.keyswitch]),
    [['sus', 24], ['pm', 26], ['ls', 28], ['hp', 30]],
  )
  assert.equal(GUITAR_FX_SOUNDS.length, 11)
  assert.deepEqual(
    GUITAR_FX_SOUNDS.map((item) => item.keyswitch),
    [77, 78, 79, 80, 81, 82, 83, 84, 89, 90, 91],
  )
  assert.deepEqual(
    [GUITAR_CONTROL_KEYS.stringSelect.low, GUITAR_CONTROL_KEYS.stringSelect.high],
    [31, 36],
  )
  assert.equal(GUITAR_CONTROL_KEYS.positionSelect.keyswitch, 37)
  assert.equal(GUITAR_CONTROL_KEYS.repeatNote.keyswitch, 86)
  assert.equal(GUITAR_CONTROL_KEYS.autoLegato.keyswitch, 87)
  assert.equal(GUITAR_CONTROL_KEYS.openStringFirst.keyswitch, 92)
  assert.equal(BASS_KEYS.pullOff.keyswitch, 21)
  assert.equal(VELOCITY.guitar.popAt, 127)
  assert.equal(VELOCITY.bass.longMax, 125)
  assert.equal(VELOCITY.bass.accentMin, 126)
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
await rm(WORK, { recursive: true, force: true })
console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed) process.exitCode = 1
