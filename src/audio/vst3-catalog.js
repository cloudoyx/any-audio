/**
 * VST3 音色档案：内置条目、校验与磁盘读写。
 *
 * 一条档案描述一个音源插件：装在哪、实测能弹多高多低、四个演奏法键位在哪、
 * 有哪些效果音。音域必须与 engine/vst3_worker.py 的 PLUGIN_RANGES 一致——
 * 侧车按插件文件名里的 abpl / agml 匹配音域，超出直接拒绝渲染。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { readConfig } from '../config.js'
import { CATEGORY_LABELS } from './scoring.js'
import { recognizeVst3 } from './vst3-known.js'
import { ARTICULATIONS, GUITAR_FX_SOUNDS } from './vst3-techniques.js'

export const CATALOG_VERSION = 1

export class Vst3CatalogError extends Error {
  constructor(message) {
    super(message)
    this.name = 'Vst3CatalogError'
  }
}

/** Windows 的 .vst3 是目录包；内层 DLL 由侧车自己找。 */
const VST3_DIR = 'C:\\Program Files\\Common Files\\VST3'

function copyArticulations() {
  return ARTICULATIONS.map((item) => ({ ...item }))
}

/**
 * 内置档案。每次调用都返回新对象，调用方改了也不会污染下一次。
 *
 * 音域是实测值，不是说明书标注：AGML 说明书 E1–C5（40–84），实测 42 起
 * 才有声；ABPL 说明书 B0–F4（23–65），实测 40–72。
 */
export function builtInCatalog() {
  return {
    version: CATALOG_VERSION,
    plugins: [
      {
        id: 'ample-bass-p-lite',
        name: 'Ample Bass P Lite 4 (ABPL)',
        vendor: 'Ample Sound',
        plugin: `${VST3_DIR}\\ABPL.vst3`,
        format: 'vst3',
        instrument: true,
        range: { low: 40, high: 72 },
        families: { bass: 9 },
        articulations: copyArticulations(),
        fxSounds: [],
        // 厂商预设由 vst3-presets.js 扫描后写进机器配置，mergedCatalog 再挂上来；
        // 内置档案本身不带音色，所以这里是空数组。
        timbres: [],
        notes: '低音区不出声（实测 MIDI 40 以下静音）；52 以上音高可能不准。',
      },
      {
        id: 'ample-guitar-m-lite',
        name: 'Ample Guitar M Lite (AGML)',
        vendor: 'Ample Sound',
        plugin: `${VST3_DIR}\\AGML.vst3`,
        format: 'vst3',
        instrument: true,
        range: { low: 42, high: 84 },
        families: { guitar: 9 },
        articulations: copyArticulations(),
        fxSounds: GUITAR_FX_SOUNDS.map((item) => ({ ...item })),
        timbres: [],
        notes: '低音 E 弦不出声（实测 MIDI 42 起）；效果音直接当音符弹。',
      },
      {
        id: 'dexed',
        name: 'Dexed',
        vendor: 'Digital Suburban',
        plugin: `${VST3_DIR}\\Dexed.vst3`,
        format: 'vst3',
        instrument: true,
        range: { low: 21, high: 108 },
        families: { synthLead: 8, synthPad: 8 },
        articulations: [],
        fxSounds: [],
        // 参数型预设：probe 把 program 参数的 32 个具名取值写进机器配置，
        // mergedCatalog 再按插件路径挂上来，所以内置档案本身不带音色。
        timbres: [],
        notes: 'FM 合成器；预设由 program 参数提供（参数型）',
      },
      {
        id: 'grand-piano',
        name: 'Grand Piano (Audiolatry)',
        vendor: 'Audiolatry',
        plugin: `${VST3_DIR}\\Grand Piano Windows VST3\\Grand Piano.vst3`,
        format: 'vst3',
        instrument: true,
        range: { low: 21, high: 108 },
        families: { piano: 9 },
        articulations: [],
        fxSounds: [],
        timbres: [],
        notes: '单音色 ROMpler（一档）；无预设可切换',
      },
    ],
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Stable id for a scanned plugin: the path is the identity, the hash keeps the
 *  id short and cannot collide with a built-in id. */
export function scannedId(path) {
  return `scanned-${createHash('sha1').update(String(path).toLowerCase()).digest('hex').slice(0, 10)}`
}

/** 机器配置里按插件路径存的音色表；路径大小写不敏感（Windows）。 */
function timbresByPath(config) {
  const map = new Map()
  for (const entry of config.vst3?.timbres ?? []) {
    map.set(entry.path.toLowerCase(), entry.timbres)
  }
  return map
}

/**
 * Built-in entries plus the plugins the person added through /vst3/add.
 *
 * A scanned entry has no measured range, no family scores and no articulations:
 * it can only be used by naming its id explicitly, never by `auto`, and the
 * renderer skips the compile-time range check for it. A scanned path that is
 * already a built-in plugin is dropped — the built-in entry has the measured
 * data and must win.
 */
export async function mergedCatalog() {
  const builtIn = builtInCatalog()
  const { config } = await readConfig()
  const timbres = timbresByPath(config)
  const seen = new Set(builtIn.plugins.map((entry) => entry.plugin.toLowerCase()))
  const scanned = []
  for (const plugin of config.vst3?.plugins ?? []) {
    const path = String(plugin.path ?? '').trim()
    if (!path || seen.has(path.toLowerCase())) continue
    seen.add(path.toLowerCase())
    const name = plugin.name || basename(path).replace(/\.vst3$/i, '') || path
    scanned.push({
      id: scannedId(path),
      name,
      vendor: plugin.vendor || '未知',
      plugin: path,
      format: 'vst3',
      instrument: true,
      range: null,
      families: { default: 5 },
      articulations: [],
      fxSounds: [],
      timbres: timbres.get(path.toLowerCase()) ?? [],
      notes: '扫描条目：音域与演奏法未实测，只能显式 source 引用。',
      kind: 'scanned',
      // A suggestion only: the official metadata often says nothing about the
      // class, and a single-file plugin has no metadata at all.
      recognized: recognizeVst3(name),
    })
  }
  return {
    version: builtIn.version,
    plugins: [
      ...builtIn.plugins.map((entry) => ({
        ...entry,
        kind: 'builtin',
        timbres: timbres.get(entry.plugin.toLowerCase()) ?? [],
      })),
      ...scanned,
    ],
  }
}

function requireString(value, where) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Vst3CatalogError(`${where} 必须是非空字符串`)
  }
  return value
}

function requireMidi(value, where) {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new Vst3CatalogError(`${where} 必须是 0-127 的整数（MIDI 编号），现在是 ${JSON.stringify(value)}`)
  }
  return value
}

/** 演奏法和效果音共用一套形状：{ id, keyswitch, name }。 */
function validateKeyswitchList(list, where) {
  if (!Array.isArray(list)) throw new Vst3CatalogError(`${where} 必须是数组`)
  const seen = new Set()
  for (const [index, item] of list.entries()) {
    const at = `${where}[${index}]`
    if (!isObject(item)) throw new Vst3CatalogError(`${at} 必须是对象`)
    requireString(item.id, `${at}.id`)
    requireString(item.name, `${at}.name`)
    requireMidi(item.keyswitch, `${at}.keyswitch`)
    if (seen.has(item.keyswitch)) {
      throw new Vst3CatalogError(`${at}.keyswitch ${item.keyswitch} 与同一列表里的其他键位重复`)
    }
    seen.add(item.keyswitch)
  }
}

/** 音色条目的三种来源：状态文件、插件预设文件、具名程序参数。 */
const TIMBRE_KINDS = new Set(['state', 'parameter', 'file'])

/**
 * 音色条目：{ id, name, category, type, kind, ... }，id 在同一音源内唯一。
 *
 * kind 缺省是 state（厂商预设状态文件，用 statePath）；parameter 型用
 * parameter + value 描述一个具名程序参数取值，没有 statePath；file 型用
 * statePath 指向插件自己的预设文件。
 */
function validateTimbres(list, where) {
  if (!Array.isArray(list)) throw new Vst3CatalogError(`${where} 必须是数组`)
  const seen = new Set()
  for (const [index, item] of list.entries()) {
    const at = `${where}[${index}]`
    if (!isObject(item)) throw new Vst3CatalogError(`${at} 必须是对象`)
    requireString(item.id, `${at}.id`)
    requireString(item.name, `${at}.name`)
    for (const field of ['category', 'type']) {
      if (typeof item[field] !== 'string') throw new Vst3CatalogError(`${at}.${field} 必须是字符串`)
    }
    const kind = item.kind ?? 'state'
    if (!TIMBRE_KINDS.has(kind)) {
      throw new Vst3CatalogError(`${at}.kind 必须是 "state"、"parameter" 或 "file"，现在是 ${JSON.stringify(item.kind)}`)
    }
    if (kind === 'parameter') {
      requireString(item.parameter, `${at}.parameter`)
      requireString(item.value, `${at}.value`)
    } else if (typeof item.statePath !== 'string') {
      throw new Vst3CatalogError(`${at}.statePath 必须是字符串`)
    }
    if (seen.has(item.id)) {
      throw new Vst3CatalogError(`${at}.id "${item.id}" 与同一音源的其他音色重复`)
    }
    seen.add(item.id)
  }
}

/**
 * probe 的结果 → 参数型音色：每个具名取值一条，name 是谱面 preset 写的名字，
 * value 是侧车要设给参数的值。同一个参数里重名的取值只留第一条。
 */
export function timbresFromPrograms(programs) {
  const out = []
  const seen = new Set()
  for (const program of Array.isArray(programs) ? programs : []) {
    const parameter = typeof program?.parameter === 'string' ? program.parameter.trim() : ''
    if (!parameter) continue
    for (const raw of Array.isArray(program.values) ? program.values : []) {
      if (typeof raw !== 'string') continue
      const name = raw.trim()
      if (!name) continue
      const id = `${parameter}:${name}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, name, category: '', type: '', kind: 'parameter', parameter, value: name })
    }
  }
  return out
}

/** 乐器族评分：键是 scoring.js 的族键或 default（兜底分），分数 1-10，供 auto 跨类选源使用。 */
function validateFamilies(families, where) {
  if (families === undefined) return
  if (!isObject(families)) throw new Vst3CatalogError(`${where} 必须是 { 乐器族: 评分 } 对象`)
  for (const [family, score] of Object.entries(families)) {
    if (family !== 'default' && !(family in CATEGORY_LABELS)) {
      throw new Vst3CatalogError(`${where}.${family} 不是合法的乐器族；可用：${Object.keys(CATEGORY_LABELS).join(', ')}，或 default（兜底分）`)
    }
    if (!Number.isInteger(score) || score < 1 || score > 10) {
      throw new Vst3CatalogError(`${where}.${family} 评分必须是 1-10 的整数，现在是 ${JSON.stringify(score)}`)
    }
  }
}

function validatePlugin(entry, index) {
  const where = `plugins[${index}]`
  if (!isObject(entry)) throw new Vst3CatalogError(`${where} 必须是对象`)
  requireString(entry.id, `${where}.id`)
  requireString(entry.name, `${where}.name`)
  requireString(entry.vendor, `${where}.vendor`)
  requireString(entry.plugin, `${where}.plugin`)
  if (entry.format !== 'vst3') {
    throw new Vst3CatalogError(`${where}.format 必须是 "vst3"，现在是 ${JSON.stringify(entry.format)}`)
  }
  if (entry.instrument !== true) {
    throw new Vst3CatalogError(`${where}.instrument 必须是 true（音色档案只收乐器插件）`)
  }
  // A scanned entry has not been measured yet: its range and articulations may
  // be absent. Built-in entries (no `kind`, or kind "builtin") still need both.
  const scanned = entry.kind === 'scanned'
  if (entry.range === undefined || entry.range === null) {
    if (!scanned) throw new Vst3CatalogError(`${where}.range 必须是 { low, high } 对象`)
  } else {
    if (!isObject(entry.range)) throw new Vst3CatalogError(`${where}.range 必须是 { low, high } 对象`)
    requireMidi(entry.range.low, `${where}.range.low`)
    requireMidi(entry.range.high, `${where}.range.high`)
    if (entry.range.low > entry.range.high) {
      throw new Vst3CatalogError(`${where}.range.low (${entry.range.low}) 不能大于 range.high (${entry.range.high})`)
    }
  }
  validateFamilies(entry.families, `${where}.families`)
  if (entry.articulations === undefined) {
    if (!scanned) throw new Vst3CatalogError(`${where}.articulations 必须是数组`)
  } else {
    validateKeyswitchList(entry.articulations, `${where}.articulations`)
  }
  validateKeyswitchList(entry.fxSounds, `${where}.fxSounds`)
  if (entry.timbres !== undefined) validateTimbres(entry.timbres, `${where}.timbres`)
  if (typeof entry.notes !== 'string') throw new Vst3CatalogError(`${where}.notes 必须是字符串`)
}

/**
 * 校验一份音色档案。通过时原样返回 data，失败抛 Vst3CatalogError（中文）。
 *
 * 只校验必需字段和类型，未知字段保留——档案是给人手改的 JSON，多写一个
 * 备注字段不该让整份档案读不进来。
 */
export function validateCatalog(data) {
  if (!isObject(data)) throw new Vst3CatalogError('音色档案必须是一个对象')
  if (data.version !== undefined && (!Number.isInteger(data.version) || data.version < 1)) {
    throw new Vst3CatalogError(`version 必须是正整数，现在是 ${JSON.stringify(data.version)}`)
  }
  if (!Array.isArray(data.plugins)) throw new Vst3CatalogError('音色档案缺少 plugins 数组')
  if (data.plugins.length === 0) throw new Vst3CatalogError('plugins 不能是空数组：档案里至少要有一个音源')
  const seen = new Set()
  for (const [index, entry] of data.plugins.entries()) {
    validatePlugin(entry, index)
    if (seen.has(entry.id)) {
      throw new Vst3CatalogError(`plugins[${index}].id "${entry.id}" 与前面的条目重复`)
    }
    seen.add(entry.id)
  }
  return data
}

/** 从磁盘读一份档案并校验；读不到、不是 JSON、校验不过都抛中文错误。 */
export async function loadCatalog(path) {
  const target = String(path ?? '').trim()
  if (!target) throw new Vst3CatalogError('读取音色档案需要文件路径')
  let text
  try {
    text = await readFile(target, 'utf8')
  } catch (error) {
    throw new Vst3CatalogError(`读取音色档案失败：${target}（${error.message}）`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Vst3CatalogError(`音色档案不是合法 JSON：${target}（${error.message}）`)
  }
  return validateCatalog(data)
}

/** 校验后写出档案（UTF-8、两空格缩进、结尾换行）；目录不存在会先建。 */
export async function saveCatalog(path, data) {
  const target = String(path ?? '').trim()
  if (!target) throw new Vst3CatalogError('保存音色档案需要文件路径')
  validateCatalog(data)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return target
}
