import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { FONT_EXTENSIONS, RECOMMENDED_FONTS, findRecommendedByFile, fontSearchDirs, installFont, listFonts, resolveFont } from '../audio/fonts.js'
import { loadCatalog } from '../audio/banks.js'
import { mergedCatalog } from '../audio/vst3-catalog.js'
import { scanPluginTimbres } from '../audio/vst3-presets.js'
import { DRUM_MAP, INSTRUMENTS } from '../audio/score.js'
import { CATEGORY_LABELS, scoreTable } from '../audio/scoring.js'
import { listSourceKinds } from '../audio/sources.js'
import { loadSoundBank, listPresets } from '../audio/synth.js'
import { readConfig, updateConfig } from '../config.js'
import { finalizeTool, formatBytes, relativeToWorkspace, textRenderer, workspaceRootOf } from './shared.js'

function groupInstruments() {
  const families = {
    keyboard: ['piano', 'epiano', 'harpsichord', 'celesta', 'vibraphone', 'marimba', 'organ', 'accordion'],
    plucked: ['nylon-guitar', 'steel-guitar', 'harp', 'koto', 'guzheng', 'guqin', 'pipa', 'yangqin', 'sitar', 'banjo', 'shamisen', 'kalimba', 'dulcimer'],
    bowed: ['violin', 'viola', 'cello', 'contrabass', 'strings', 'slow-strings', 'pizzicato', 'erhu', 'fiddle', 'tremolo-strings'],
    wind: ['flute', 'recorder', 'pan-flute', 'shakuhachi', 'dizi', 'xiao', 'whistle', 'oboe', 'clarinet', 'bassoon', 'sheng', 'suona', 'shenai', 'englishhorn', 'harmonica', 'ocarina'],
    brass: ['trumpet', 'trombone', 'tuba', 'horn', 'brass-section'],
    bass: ['bass', 'finger-bass', 'pick-bass', 'fretless-bass', 'contrabass'],
    percussion: ['timpani', 'taiko', 'chinese-drums', 'tubular-bells', 'bianzhong', 'musicbox', 'tinkle-bell', 'steel-drums', 'woodblock', 'melodic-tom', 'synth-drum'],
    texture: ['choir', 'voice-ooh', 'new-age-pad', 'warm-pad', 'choir-pad', 'bowed-pad', 'halo-pad', 'soundtrack', 'crystal', 'atmosphere', 'seashore', 'rain-fx'],
  }
  return Object.entries(families).map(([family, names]) => ({
    family,
    instruments: names.map((name) => ({ name, program: INSTRUMENTS[name] })),
  }))
}

/**
 * Fonts left in a project folder by 0.1.0 and earlier. They are reported so the
 * user can re-install them into the shared library; nothing is moved or deleted
 * automatically.
 */
async function legacyProjectFonts(workspaceRoot) {
  if (!workspaceRoot) return []
  const dir = join(workspaceRoot, '.anyaudio', 'fonts')
  const names = await readdir(dir).catch(() => [])
  const found = []
  for (const name of names) {
    if (!FONT_EXTENSIONS.has(extname(name).toLowerCase())) continue
    const info = await stat(join(dir, name)).catch(() => null)
    if (info?.isFile()) found.push({ name, path: join(dir, name), bytes: info.size })
  }
  return found
}

/** The exact score field for one SF2 preset: bank 0 uses the alias/program, other banks need the object form. */
function writeForPreset(preset) {
  if (preset.drums) return 'drums:true（鼓组，音高按鼓件名）'
  if (preset.bank === 0) {
    const alias = PROGRAM_ALIASES.get(preset.program)
    return alias ? `instrument:"${alias}"` : `instrument:${preset.program}`
  }
  return `instrument:{program:${preset.program}, bank:${preset.bank}, name:"${preset.name}"}`
}

async function resolveBankArg(value, workspaceRoot) {
  if (typeof value !== 'string' || !value.trim()) return resolveFont({ path: value, workspaceRoot })
  const wanted = value.trim()
  const catalog = await loadCatalog()
  const entry =
    catalog.find((item) => item.id === wanted) ??
    catalog.find((item) => item.name === wanted) ??
    catalog.find((item) => item.path.split(/[\\/]/).pop().toLowerCase() === wanted.toLowerCase())
  return entry ? entry.path : resolveFont({ path: wanted, workspaceRoot })
}

// 清单只给预览：音色多的音源列前若干个，完整清单用 presets 查。
const TIMBRE_PREVIEW = 12

/** GM program → 第一个别名（INSTRUMENTS 的键序决定），把 bank 的 program 写成 instrument。 */
const PROGRAM_ALIASES = new Map()
for (const [name, program] of Object.entries(INSTRUMENTS)) {
  if (!PROGRAM_ALIASES.has(program)) PROGRAM_ALIASES.set(program, name)
}

/**
 * SF2 的可写音色：bank 0 的每个 program 一条。name 是库里的预设名，write 是谱里
 * 能直接用的 instrument 写法（GM 别名优先，没有别名用 program 号）。读不了库返回
 * timbres: null——一个坏库不该让整份清单失败。vendor 取库元数据里的作者，SF2 没有
 * 厂商字段，这是最接近的一项。
 */
async function sf2Info(path) {
  let bank
  try {
    bank = await loadSoundBank(path)
  } catch {
    return { timbres: null, vendor: '' }
  }
  const byProgram = new Map()
  for (const preset of listPresets(bank, { limit: 10000 })) {
    if (preset.drums || preset.bank !== 0 || byProgram.has(preset.program)) continue
    byProgram.set(preset.program, preset.name)
  }
  const timbres = [...byProgram.entries()]
    .sort(([left], [right]) => left - right)
    .map(([program, name]) => {
      const alias = PROGRAM_ALIASES.get(program)
      return { name, program, write: alias ? `instrument:"${alias}"` : `instrument:${program}` }
    })
  const engineer = bank.soundBankInfo?.engineer
  return { timbres, vendor: typeof engineer === 'string' ? engineer.trim() : '' }
}

function formatScores(scores) {
  if (!scores) return '未评分'
  const parts = Object.entries(scores)
    .filter(([family]) => family !== 'default')
    .map(([family, score]) => `${family} ${score}`)
  if (Number.isFinite(scores.default)) parts.push(`default ${scores.default}（兜底）`)
  return parts.join(', ') || '未评分'
}

function formatTimbres(entry, kind) {
  if (kind === 'sf2' && entry.timbresReadable === false) return '读取失败（用 presets 重试）'
  if (!entry.timbres?.length) {
    return kind === 'sf2'
      ? '1 个音色（默认）— 用默认音色，instrument 可省略'
      : '1 个音色（默认）— 不写 preset，用该音源默认音色'
  }
  const shown = entry.timbres.map((timbre) => (kind === 'sf2' ? `${timbre.name}→${timbre.write}` : timbre.name))
  const count = entry.timbreCount ?? entry.timbres.length
  // SF2 lists bank 0 (the standard GM set); other banks hold extra patches and
  // are reachable through "presets", which prints the exact field for each.
  const head = kind === 'sf2'
    ? `bank 0 共 ${count} 个${entry.timbresTruncated ? `，列前 ${entry.timbres.length} 个` : ''}；其他 bank 用 presets 查`
    : entry.timbresTruncated
      ? `共 ${count} 个，列前 ${entry.timbres.length} 个`
      : `${count} 个`
  return `${head} — ${shown.join(' · ')}`
}

function formatWriteHint(entry, kind) {
  if (!entry.timbres?.length) {
    return kind === 'sf2'
      ? `source:"${entry.id}"（用默认音色，instrument 可省略）`
      : `source:"${entry.id}"（不写 preset，用默认音色）`
  }
  return kind === 'sf2'
    ? `source:"${entry.id}"，instrument 按每条音色给出的值`
    : `source:"${entry.id}", preset:"<音色名>"`
}

export const sourcesToolDefinition = finalizeTool({
  name: 'anyaudio_sources',
  description:
    'Inspect and manage the sound sources used by anyaudio_music and anyaudio_sfx. Actions: "list" (every connected source — SoundFont banks and VST3 instruments — with its 1-10 instrument-family scores, measured range, and the timbres it offers, each with the exact score field to write), "install" (download a recommended bank or copy a .sf2/.sf3/.dls from disk into the shared library), "use" (choose the bank drum kits come from), "instruments" (GM alias reference — the names this plugin understands; not the list of available timbres, use "list" for that), "presets" (list one source\'s timbres — a SoundFont bank or a VST3 instrument — each with the exact score field to write), "kinds" (what source types exist, including planned ones such as sample packs and narration voices). ' +
    'The font library is shared by every project and agent session on this machine, so a bank installed once is available everywhere. ' +
    'Run "install" once if anyaudio_music reports that no SoundFont is installed. Custom banks are supported: pass "fromPath" to a local file or "url" to a direct download. Each track in a score names its source and timbre explicitly — the list action gives the exact field to write — and different tracks may use different sources. Drum kits always come from the default bank.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'install', 'instruments', 'presets', 'use', 'kinds'], description: 'What to do; defaults to "list" — the full source list (SF2 and VST3, with scores and measured ranges).' },
      id: { type: 'string', description: 'Recommended source/bank id for install, default "generaluser".' },
      url: { type: 'string', description: 'Direct URL of a custom SoundFont to install.' },
      fromPath: { type: 'string', description: 'Local SoundFont path to install (useful when downloads are blocked).' },
      path: { type: 'string', description: 'Bank path to inspect with "presets" or to make the default with "use".' },
      source: { type: 'string', description: 'The source id from action "list" — a SoundFont bank or a VST3 instrument. Lists that source\'s timbres, each with the exact score field to write.' },
      font: { type: 'string', description: 'Alias of "source" (kept for older calls): an installed id (e.g. "musescore-general"), file name or .sf2 path.' },
      query: { type: 'string', description: 'Filter preset names, e.g. "piano", "koto", "shakuhachi".' },
      limit: { type: 'number', description: 'Max presets to list, default 60.' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        message: { type: 'string' },
        fonts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        vst3: { type: 'array', items: { type: 'object', additionalProperties: true } },
        directories: { type: 'array', items: { type: 'string' } },
        instruments: { type: 'array', items: { type: 'object', additionalProperties: true } },
        drums: { type: 'object', additionalProperties: true },
        presets: { type: 'array', items: { type: 'object', additionalProperties: true } },
        kinds: { type: 'array', items: { type: 'object', additionalProperties: true } },
        font: { type: 'string' },
        default: { type: 'string' },
        defaultSource: { type: 'string' },
        bytes: { type: 'number' },
        sha256: { type: 'string' },
        license: { type: 'string' },
      },
    },
    render: textRenderer((_args, value) => {
      if (value.action === 'instruments') {
        return [
          'Instrument aliases (name → GM program):',
          ...value.instruments.map((group) => `${group.family}: ${group.instruments.map((entry) => `${entry.name}(${entry.program})`).join(', ')}`),
          `Drum kit keys: ${Object.keys(value.drums).join(', ')}`,
        ].join('\n')
      }
      if (value.action === 'presets') {
        if (value.kind === 'vst3') {
          return [`Timbres in ${value.source} (${value.timbres.length}):`, ...value.timbres.map((timbre) => `- ${timbre.name}${timbre.category ? ` (${timbre.category})` : ''} → ${timbre.write}`)].join('\n')
        }
        return [`Presets in ${value.font} (${value.presets.length} shown):`, ...value.presets.map((preset) => `- ${preset.name} — program ${preset.program}, bank ${preset.bank}${preset.drums ? ' (drum kit)' : ''} → ${preset.write}`)].join('\n')
      }
      if (value.action === 'kinds') {
        return value.kinds.map((kind) => `- ${kind.id} (${kind.status}) — ${kind.label}: ${kind.description}`).join('\n')
      }
      if (value.action === 'list') {
        const lines = [
          '已接入的全部音源（SF2 与 VST3 混排）。每条轨都要写 source；音色按每条给出的写法写。',
        ]
        for (const font of value.fonts) {
          const tag = font.default ? ' [fallback]' : font.recommended ? ' [recommended]' : ''
          const vendor = font.vendor ? `（${font.vendor}）` : ''
          lines.push(`- [SF2] ${font.id} — ${font.name}${vendor} (${formatBytes(font.bytes)})${tag}`)
          lines.push(`  评分: ${formatScores(font.scores)}`)
          lines.push(`  写法: ${formatWriteHint(font, 'sf2')}`)
          lines.push(`  音色: ${formatTimbres(font, 'sf2')}`)
        }
        for (const entry of value.vst3) {
          const vendor = entry.vendor && entry.vendor !== '未知' ? `（${entry.vendor}）` : ''
          const range = entry.range ? `，实测音域 MIDI ${entry.range.low}-${entry.range.high}` : '，音域未实测'
          lines.push(`- [VST3] ${entry.id} — ${entry.name}${vendor}${range}`)
          lines.push(`  评分: ${formatScores(entry.scores)}`)
          lines.push(`  写法: ${formatWriteHint(entry, 'vst3')}`)
          lines.push(`  音色: ${formatTimbres(entry, 'vst3')}`)
        }
        lines.push(`Families: ${Object.keys(CATEGORY_LABELS).join(', ')}`)
        // Two different things answer to "default": the bank the person chose
        // with action "use" (music.font), and the bank used when they chose
        // nothing. Calling both "default" is what made a person believe they
        // had configured one, while the tool kept saying "not set"
        // (improvement plan 04).
        lines.push(
          value.defaultSource
            ? `Configured default source (drum kits): ${value.defaultSource}`
            : `Configured default source (drum kits): not set — renders fall back to ${value.fonts.find((font) => font.default)?.name ?? 'the installed default bank'}`,
        )
        lines.push(`Search directories: ${value.directories.join(' | ')}`)
        if (value.legacy?.length) {
          lines.push('From an older version (project folder, not part of the shared library — re-install with install + fromPath to use them):')
          for (const font of value.legacy) lines.push(`- ${font.path} (${formatBytes(font.bytes)})`)
        }
        lines.push(`Source kinds: ${value.kinds.map((kind) => `${kind.id}:${kind.status}`).join(', ')}`)
        return lines.join('\n')
      }
      return value.message ?? 'done'
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const action = args.action ?? 'list'
    if (action === 'install') {
      const result = await installFont({
        id: args.id ?? 'generaluser',
        url: args.url,
        fromPath: args.fromPath,
        workspaceRoot,
      })
      return {
        ok: true,
        action,
        font: result.path,
        bytes: result.bytes,
        sha256: result.sha256,
        license: result.license,
        installed: true,
        message: `Installed ${result.path} (${formatBytes(result.bytes)}) into the shared font library${result.alreadyInstalled ? ' — already present' : ''}. License: ${result.license}`,
      }
    }
    if (action === 'instruments') {
      return { ok: true, action, instruments: groupInstruments(), drums: DRUM_MAP }
    }
    if (action === 'kinds') {
      return { ok: true, action, kinds: listSourceKinds() }
    }
    if (action === 'presets') {
      const wanted = String(args.source ?? args.path ?? args.font ?? '').trim()
      const catalog = await mergedCatalog()
      // A VST3 source id names a plugin; its timbres come from the catalog, not
      // from a SoundFont file. Checking it first keeps the two source kinds on
      // one action instead of making the caller guess which one to call.
      const vst3 = catalog.plugins.find((entry) => entry.id === wanted || entry.name === wanted)
      if (vst3) {
        const timbres = vst3.timbres?.length ? vst3.timbres : await scanPluginTimbres(vst3.plugin)
        return {
          ok: true,
          action,
          source: vst3.id,
          kind: 'vst3',
          timbres: timbres.map((timbre) => ({
            name: timbre.name,
            category: timbre.category,
            type: timbre.type,
            write: `source:"${vst3.id}", preset:"${timbre.name}"`,
          })),
        }
      }
      let fontPath
      try {
        fontPath = await resolveBankArg(wanted, workspaceRoot)
      } catch {
        const available = [
          ...(await listFonts()).map((font) => `[SF2] ${findRecommendedByFile(font.name)?.id ?? font.name}`),
          ...catalog.plugins.map((entry) => `[VST3] ${entry.id}`),
        ]
        throw new Error(`unknown source "${wanted}"; available sources: ${available.join(', ')}`)
      }
      const bank = await loadSoundBank(fontPath)
      const presets = listPresets(bank, { query: args.query, limit: Math.min(200, Math.max(1, Math.round(Number(args.limit) || 60))) })
        .map((preset) => ({ ...preset, write: writeForPreset(preset) }))
      return { ok: true, action, font: relativeToWorkspace(workspaceRoot, fontPath), presets }
    }
    if (action === 'use') {
      const fontPath = await resolveBankArg(args.path ?? args.font, workspaceRoot)
      // Store the stable id when the file is a recommended bank, so the default
      // survives a reinstall that changes the directory layout.
      const recommended = findRecommendedByFile(fontPath.split(/[\\/]/).pop())
      const value = recommended ? recommended.id : fontPath
      const { config, path: configPath } = await updateConfig({ music: { font: value } })
      return {
        ok: true,
        action,
        font: fontPath,
        default: config.music.font,
        message: `Default sound source set to ${fontPath}; it is the bank drum kits come from (persisted as "${config.music.font}" in ${configPath}).`,
      }
    }
    const fonts = await listFonts()
    const { config } = await readConfig()
    const table = new Map(scoreTable(RECOMMENDED_FONTS.map((font) => font)).map((entry) => [entry.id, entry.scores]))
    // 0.1.0 and earlier could install into <project>/.anyaudio/fonts. That folder
    // is no longer scanned (the library is machine-wide now); point at the files
    // so nothing silently disappears, without reading them into the library.
    const legacy = await legacyProjectFonts(workspaceRoot)
    const sf2 = []
    for (const font of fonts) {
      const recommended = findRecommendedByFile(font.name)
      const info = await sf2Info(font.path)
      sf2.push({
        ...font,
        kind: 'sf2',
        relativePath: relativeToWorkspace(workspaceRoot, font.path),
        // A custom bank has no catalog id; its file name is what the score's
        // `source` resolves against, so that is the id the list must show.
        id: recommended?.id ?? font.name,
        vendor: info.vendor,
        recommended: Boolean(recommended),
        default: Boolean(recommended?.default),
        scores: recommended ? table.get(recommended.id) : { default: 3 },
        timbres: info.timbres ? info.timbres.slice(0, TIMBRE_PREVIEW) : [],
        timbreCount: info.timbres?.length ?? 0,
        timbresTruncated: Boolean(info.timbres && info.timbres.length > TIMBRE_PREVIEW),
        timbresReadable: info.timbres !== null,
      })
    }
    // 音色清单以磁盘上的预设为准。配置里有扫描结果就用它；没有就现场扫一遍
    // （只读，不写配置——工具调用不落盘配置，落盘由设置页的扫描负责）。
    const vst3 = []
    for (const entry of (await mergedCatalog()).plugins) {
      const stored = entry.timbres ?? []
      const timbres = (stored.length ? stored : await scanPluginTimbres(entry.plugin)).map((timbre) => ({
        id: timbre.id,
        name: timbre.name,
        category: timbre.category,
        type: timbre.type,
        write: `source:"${entry.id}", preset:"${timbre.name}"`,
      }))
      vst3.push({
        id: entry.id,
        name: entry.name,
        vendor: entry.vendor,
        kind: 'vst3',
        path: entry.plugin,
        scores: entry.families ?? null,
        range: entry.range ?? null,
        articulations: entry.articulations?.length ?? 0,
        notes: entry.notes ?? '',
        timbres: timbres.slice(0, TIMBRE_PREVIEW),
        timbreCount: timbres.length,
        timbresTruncated: timbres.length > TIMBRE_PREVIEW,
      })
    }
    return {
      ok: true,
      action: 'list',
      fonts: sf2,
      vst3,
      // Declared as `string` in the output schema: omit the key when unset
      // instead of sending null, or the host rejects the whole result.
      ...(config.music.font ? { defaultSource: config.music.font } : {}),
      directories: fontSearchDirs(),
      legacy,
      extensions: [...FONT_EXTENSIONS],
      kinds: listSourceKinds(),
    }
  },
})

export function registerSourcesTool(ctx) {
  ctx.tools.register(sourcesToolDefinition)
}

