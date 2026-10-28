/**
 * Multi-font planning: work out which bank each track should use, assign
 * collision-free bank offsets, and pick a playable program on that bank.
 *
 * The renderer loads every bank into ONE synth, so all tracks share one reverb
 * and one voice pool. Drum kits are the exception: spessasynth routes channel 9
 * through `isGMGSDrum` presets and ignores the bank, so drums always come from
 * the first loaded bank.
 */

import { basename, extname } from 'node:path'
import { defaultFontPath, findRecommended, findRecommendedByFile, listFonts, resolveFont } from './fonts.js'
import { categoryOfProgram, fontScore, rankFonts } from './scoring.js'
import { loadSoundBank } from './synth.js'

export function melodicPresets(bank) {
  return (bank.presets ?? []).filter((preset) => preset.isGMGSDrum !== true && (preset.bankMSB ?? 0) !== 120)
}

export function hasDrumKit(bank) {
  return (bank.presets ?? []).some((preset) => preset.isGMGSDrum === true || (preset.bankMSB ?? 0) === 120)
}

/**
 * Smallest offset that keeps every preset inside bank 0..127 and avoids the
 * (bank, program) pairs already taken by earlier fonts. Presets are checked by
 * their own bank number, so a font that spreads across many banks still lands
 * in one contiguous, non-overlapping slice.
 */
export function planOffset(used, bank) {
  const presets = melodicPresets(bank)
  for (let offset = 0; offset <= 127; offset++) {
    let ok = true
    for (const preset of presets) {
      const targetBank = (preset.bankMSB ?? 0) + offset
      if (targetBank > 127 || used.has(`${targetBank}:${preset.program}`)) {
        ok = false
        break
      }
    }
    if (ok) return offset
  }
  return null
}

/**
 * Which program to send to this bank so the wanted GM program is actually
 * heard: an exact program 0 match, a single-instrument bank (its only preset),
 * or a bank whose program-0 presets all share one program number.
 */
export function pickProgram(bank, wantedProgram) {
  const melodic = melodicPresets(bank).filter((preset) => (preset.bankMSB ?? 0) === 0)
  if (melodic.length === 0) return null
  const exact = melodic.find((preset) => preset.program === wantedProgram)
  if (exact) return exact.program
  const programs = new Set(melodic.map((preset) => preset.program))
  if (programs.size === 1) return melodic[0].program
  return null
}

function sanitizeId(value) {
  return String(value)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'font'
}

/** Installed fonts, annotated with the curated metadata when the file name matches. */
export async function loadCatalog() {
  const installed = await listFonts()
  const catalog = []
  const seen = new Set()
  for (const entry of installed) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    const recommended = findRecommendedByFile(entry.name)
    catalog.push({
      id: recommended?.id ?? sanitizeId(entry.name),
      name: recommended?.name ?? entry.name,
      path: entry.path,
      bytes: entry.bytes,
      source: entry.source,
      recommended: recommended ?? null,
      installed: true,
    })
  }
  return catalog
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || /\.(sf2|sf3|dls|sfogg)$/i.test(value)
}

/** Accept a font id, an installed file name, or a path as the default font. */
async function resolveDefaultFont(fontPath, catalog, workspaceRoot) {
  if (typeof fontPath === 'string' && fontPath.trim()) {
    const wanted = fontPath.trim()
    const installed = catalog.find((entry) => entry.id === wanted) ?? catalog.find((entry) => entry.name === wanted)
    if (installed) return installed.path
    if (!looksLikePath(wanted)) {
      const recommended = findRecommended(wanted)
      if (recommended) {
        throw new Error(`sound source "${wanted}" is not installed. Install it with anyaudio_sources (action "install", id "${wanted}"), or pass a .sf2 path.`)
      }
      throw new Error(`unknown default sound source "${wanted}". Installed: ${catalog.map((entry) => entry.id).join(', ') || 'none'}.`)
    }
  }
  if (fontPath === undefined || fontPath === null || fontPath === '') {
    const preferred = await defaultFontPath()
    if (!preferred) {
      throw new Error('no SoundFont installed. Install one with anyaudio_sources (action "install", id "generaluser") or pass a .sf2 path.')
    }
    return preferred
  }
  return resolveFont({ path: fontPath, workspaceRoot })
}

/**
 * Resolve the bank a render uses when the caller names none. A saved default
 * that no longer exists (the file was deleted, the id was uninstalled) falls
 * back to the installed default instead of failing every render, and the result
 * says so — the settings page uses the same function, so what it shows is what
 * the renderer does.
 */
export async function resolveConfiguredDefault(fontPath, { workspaceRoot } = {}) {
  const catalog = await loadCatalog()
  const configured = typeof fontPath === 'string' ? fontPath.trim() : ''
  try {
    return { path: await resolveDefaultFont(configured, catalog, workspaceRoot), configured, stale: false }
  } catch (error) {
    if (!configured) throw error
    const fallback = await defaultFontPath()
    if (!fallback) throw error
    return { path: fallback, configured, stale: true, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function resolveSource(value, catalog, workspaceRoot) {
  if (looksLikePath(value)) {
    const path = await resolveFont({ path: value, workspaceRoot })
    const recommended = findRecommendedByFile(basename(path)) ?? null
    return { id: recommended?.id ?? sanitizeId(path), name: recommended?.name ?? basename(path), path, recommended }
  }
  const known = catalog.find((entry) => entry.id === value) ?? catalog.find((entry) => entry.name === value)
  if (known) return known
  const recommended = findRecommended(value)
  if (recommended) {
    // Declared but not installed: give the model a precise next step.
    throw new Error(
      `sound source "${value}" is not installed. Install it with anyaudio_sources (action "install", id "${value}") or pass a .sf2 path as the source. ` +
        `Installed: ${catalog.map((entry) => entry.id).join(', ') || 'none'}`,
    )
  }
  throw new Error(
    `unknown sound source "${value}". Installed: ${catalog.map((entry) => entry.id).join(', ') || 'none'}. ` +
      'Use anyaudio_sources action "list" to see ids.',
  )
}

/**
 * Decide banks + per-track assignments for a compiled score.
 * Returns { banks, layout, warnings } where `banks` is ready for the renderer
 * and `layout` is keyed by track name.
 */
export async function planFonts(compiled, { workspaceRoot, fontPath } = {}) {
  const warnings = []
  if (compiled.tracks.length > 16) throw new Error('a score can use at most 16 tracks')
  const catalog = await loadCatalog()
  const defaultPath = await resolveDefaultFont(fontPath, catalog, workspaceRoot)
  const defaultRecommended = findRecommendedByFile(basename(defaultPath))
  const defaultEntry = {
    id: defaultRecommended?.id ?? sanitizeId(basename(defaultPath)),
    name: defaultRecommended?.name ?? basename(defaultPath),
    path: defaultPath,
    recommended: defaultRecommended ?? null,
  }

  const banks = []
  const used = new Set()
  const entries = new Map()

  async function addBank(entry) {
    if (entries.has(entry.path)) return entries.get(entry.path)
    const bank = await loadSoundBank(entry.path)
    const offset = planOffset(used, bank)
    if (offset === null) {
      throw new Error(
        `no safe bank offset left for "${entry.name}" without overwriting presets of already loaded fonts. ` +
          'Load fewer fonts in one call, or use "source" on fewer tracks.',
      )
    }
    if (banks.length > 0 && hasDrumKit(bank)) {
      warnings.push(`drum kit of "${entry.name}" is unused: drums always come from the first loaded bank ("${banks[0].name}"); render drums in a separate pass if you need another kit`)
    }
    for (const preset of melodicPresets(bank)) used.add(`${(preset.bankMSB ?? 0) + offset}:${preset.program}`)
    const record = { id: entry.id, name: entry.name, path: entry.path, bank, offset }
    entries.set(entry.path, record)
    banks.push(record)
    return record
  }

  const defaultBank = await addBank(defaultEntry)
  if (compiled.tracks.some((track) => track.drums) && !hasDrumKit(defaultBank.bank)) {
    warnings.push(`default font "${defaultEntry.name}" has no drum kit; drum tracks will be silent unless another font is loaded first`)
  }

  const layout = new Map()
  const autoPicks = []
  for (const track of compiled.tracks) {
    const requested = track.source === undefined || track.source === null || track.source === '' ? null : String(track.source)
    if (track.drums) {
      const program = pickProgram(defaultBank.bank, 0)
      layout.set(track.name, { source: defaultEntry.id, fontId: defaultEntry.id, offset: 0, program: track.program })
      if (program === null && !hasDrumKit(defaultBank.bank)) warnings.push(`track "${track.name}" is a drum track but the default font has no drum kit`)
      continue
    }
    if (requested === 'auto') {
      autoPicks.push(track)
      continue
    }
    const entry = requested ? await resolveSource(requested, catalog, workspaceRoot) : defaultEntry
    const record = await addBank(entry)
    const program = pickProgram(record.bank, track.program)
    if (program === null) {
      throw new Error(
        `"${entry.name}" cannot play ${track.instrument} (GM program ${track.program}) on its bank. ` +
          `Installed sources: ${catalog.map((item) => item.id).join(', ') || 'none'}. Choose another source for track "${track.name}" or drop the source.`,
      )
    }
    if (program !== track.program) warnings.push(`track "${track.name}": ${entry.name} has no GM program ${track.program}, using its program ${program} (${entry.name} is a single-instrument bank)`)
    layout.set(track.name, { source: entry.id, fontId: entry.id, offset: record.offset, program })
  }

  if (autoPicks.length > 0) {
    const candidates = catalog.filter((entry) => entry.recommended).length > 0 ? catalog.filter((entry) => entry.recommended) : catalog
    for (const track of autoPicks) {
      const category = categoryOfProgram(track.program)
      const ranked = rankFonts(
        candidates.map((entry) => entry.recommended ?? { id: entry.id, name: entry.name, scores: {} }),
        category,
        track.program,
      )
      let chosen = null
      for (const candidate of ranked) {
        if (candidate.id === defaultEntry.id) {
          chosen = { entry: defaultEntry, record: defaultBank, program: track.program, score: candidate.score, category }
          break
        }
        const entry = candidates.find((item) => (item.recommended?.id ?? item.id) === candidate.id)
        if (!entry) continue
        const record = await addBank(entry)
        const program = pickProgram(record.bank, track.program)
        if (program !== null) {
          chosen = { entry, record, program, score: candidate.score, category }
          break
        }
      }
      if (!chosen) {
        warnings.push(`track "${track.name}": no installed source scored better than the default for ${category}; kept the default font`)
        layout.set(track.name, { source: defaultEntry.id, fontId: defaultEntry.id, offset: 0, program: track.program })
        continue
      }
      if (chosen.entry.id !== defaultEntry.id) {
        if (chosen.program !== track.program) warnings.push(`track "${track.name}": ${chosen.entry.name} uses its program ${chosen.program}`)
        warnings.push(`track "${track.name}": auto-picked ${chosen.entry.name} for ${chosen.category} (score ${chosen.score}/10)`)
      }
      layout.set(track.name, { source: chosen.entry.id, fontId: chosen.entry.id, offset: chosen.record.offset, program: chosen.program })
    }
  }

  return {
    banks,
    layout,
    warnings,
    fonts: banks.map((record) => ({ id: record.id, name: record.name, file: basename(record.path), offset: record.offset })),
  }
}

/** Convenience for tools that want scores without loading any bank. */
export function scoreFonts(fonts, category, program) {
  return fonts.map((font) => ({ ...font, score: fontScore(font, category, program) }))
}

export { categoryOfProgram }
