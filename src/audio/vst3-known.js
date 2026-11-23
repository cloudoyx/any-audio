/**
 * 官方认可清单：给扫描到的 VST3 插件一个"音源 / 效果器"建议标签。
 *
 * 官方 moduleinfo 并不总是声明类别（单文件插件根本没有 moduleinfo），所以
 * 这里人工维护一份名称规则。它只是建议，不强制：扫描结果和 mergedCatalog
 * 都会带上 recognized，界面可以据此排序或提示，但用户仍可添加任何插件。
 *
 * 规则按数组顺序匹配，先具体后一般，首条命中生效；match 对名称做小写子串
 * 测试。'play' 这类过短过泛的词不要用，否则会误伤一大片。
 */

export const VST3_KNOWN = [
  // 音源：先列具体产品名，再列厂商/系列兜底。
  { match: 'fabfilter twin', kind: 'instrument' },
  { match: 'fabfilter one', kind: 'instrument' },
  { match: 'kontakt', kind: 'instrument' },
  { match: 'serum', kind: 'instrument' },
  { match: 'vital', kind: 'instrument' },
  { match: 'omnisphere', kind: 'instrument' },
  { match: 'keyscape', kind: 'instrument' },
  { match: 'trilian', kind: 'instrument' },
  { match: 'pianoteq', kind: 'instrument' },
  { match: 'ezdrummer', kind: 'instrument' },
  { match: 'ezbass', kind: 'instrument' },
  { match: 'ezkeys', kind: 'instrument' },
  { match: 'superior drummer', kind: 'instrument' },
  { match: 'addictive drums', kind: 'instrument' },
  { match: 'addictive keys', kind: 'instrument' },
  { match: 'halion', kind: 'instrument' },
  { match: 'groove agent', kind: 'instrument' },
  { match: 'sampletank', kind: 'instrument' },
  { match: 'ample', kind: 'instrument' },
  { match: 'abpl', kind: 'instrument' },
  { match: 'agml', kind: 'instrument' },
  // 效果器：fabfilter 兜底必须排在 twin/one 之后。
  { match: 'fabfilter', kind: 'effect' },
  { match: 'waveshell', kind: 'effect' },
  { match: 'waves', kind: 'effect' },
  { match: 'valhalla', kind: 'effect' },
  { match: 'izotope', kind: 'effect' },
  { match: 'ozone', kind: 'effect' },
  { match: 'neutron', kind: 'effect' },
  { match: 'nectar', kind: 'effect' },
  { match: 'oeksound', kind: 'effect' },
  { match: 'soothe', kind: 'effect' },
  { match: 'soundtoys', kind: 'effect' },
  { match: 'solid state logic', kind: 'effect' },
  { match: 'maag', kind: 'effect' },
  { match: 'noiseash', kind: 'effect' },
  { match: 'audified', kind: 'effect' },
  { match: 'brainworx', kind: 'effect' },
  { match: 'plugin alliance', kind: 'effect' },
  { match: 'slate digital', kind: 'effect' },
]

/** 按名称给出建议类别；没有命中返回 null（未知，不猜）。 */
export function recognizeVst3(name) {
  const wanted = String(name ?? '').trim().toLowerCase()
  if (!wanted) return null
  for (const rule of VST3_KNOWN) {
    if (wanted.includes(rule.match)) return rule.kind
  }
  return null
}
