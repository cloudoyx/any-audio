/**
 * VST3 音色（厂商预设）导入：适配器注册、扫描与结果结构。
 *
 * 核心只认抽象接口，不认任何厂商：
 *   { id, matches(pluginPath), presetDir(pluginPath), scan(presetDir) }
 * 厂商细节全部在 vst3-preset-adapters/ 里。扫描失败（目录不存在、XML 读不了、
 * 适配器抛错）只跳过那一条，不整体失败。
 *
 * 扫描结果写进机器配置的 vst3.timbres（按插件路径分组），mergedCatalog 读它
 * 给每个音源挂 timbres。重复扫描是幂等的：结果没变就不写文件。
 */
import { readConfig, updateConfig } from '../config.js'
import { mergedCatalog } from './vst3-catalog.js'
import { PRESET_ADAPTERS } from './vst3-preset-adapters/index.js'

/** 已注册的适配器 id，供诊断与测试确认注册了哪些厂商。 */
export function presetAdapterIds() {
  return PRESET_ADAPTERS.map((adapter) => adapter.id)
}

/**
 * 扫一个插件的音色。没有适配器认领、没有预设目录、扫描抛错都返回空数组——
 * 调用方不需要区分"没有预设"和"读不了"。
 */
export async function scanPluginTimbres(pluginPath) {
  const path = String(pluginPath ?? '').trim()
  if (!path) return []
  for (const adapter of PRESET_ADAPTERS) {
    let matched = false
    try {
      matched = Boolean(await adapter.matches(path))
    } catch {
      matched = false
    }
    if (!matched) continue
    let dir = null
    try {
      dir = await adapter.presetDir(path)
    } catch {
      dir = null
    }
    if (!dir) return []
    try {
      return normalizeTimbres(await adapter.scan(dir))
    } catch {
      return []
    }
  }
  return []
}

/**
 * 适配器返回 { presetId, ... }，档案里用 { id, ... }：这里统一形状并丢掉坏条目。
 * 同一音源内 id 重复只留第一条。
 */
function normalizeTimbres(items) {
  if (!Array.isArray(items)) return []
  const out = []
  const seen = new Set()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.presetId === 'string' ? item.presetId.trim() : ''
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const statePath = typeof item.statePath === 'string' ? item.statePath.trim() : ''
    if (!id || !name || !statePath || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name,
      category: typeof item.category === 'string' ? item.category.trim() : '',
      type: typeof item.type === 'string' ? item.type.trim() : '',
      statePath,
    })
  }
  return out
}

/**
 * 扫描全部音源并把结果写进机器配置的 vst3.timbres。
 *
 * 只存有音色的音源；没有预设目录的插件在档案里 timbres 为空数组，配置里不留
 * 空条目。结果与已存的一致时不写文件，所以重复扫描不会产生重复数据。
 */
export async function scanAndStoreTimbres() {
  const catalog = await mergedCatalog()
  const { config } = await readConfig()
  const stored = config.vst3?.timbres ?? []
  const entries = []
  const plugins = []
  for (const plugin of catalog.plugins) {
    const timbres = await scanPluginTimbres(plugin.plugin)
    plugins.push({ id: plugin.id, name: plugin.name, path: plugin.plugin, timbres: timbres.length })
    if (timbres.length) entries.push({ path: plugin.plugin, timbres })
  }
  const changed = JSON.stringify(entries) !== JSON.stringify(stored)
  if (changed) await updateConfig({ vst3: { timbres: entries } })
  return {
    changed,
    total: entries.reduce((sum, entry) => sum + entry.timbres.length, 0),
    plugins,
  }
}
