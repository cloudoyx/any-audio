/**
 * Which instrument family a GM program belongs to, and how good a given
 * SoundFont is at it. Font scores are coarse (one number per family) with
 * optional overrides for individual presets; that is deliberate — a full
 * per-preset review list would be unmaintainable.
 */

export const CATEGORY_LABELS = {
  piano: 'piano',
  chromatic: 'bells and mallets',
  organ: 'organ and accordion',
  guitar: 'guitar',
  bass: 'bass',
  strings: 'solo strings',
  ensemble: 'string ensembles and choir',
  brass: 'brass',
  reed: 'reed (sax, oboe, clarinet)',
  pipe: 'flutes and pipes',
  synthLead: 'synth leads',
  synthPad: 'synth pads',
  ethnic: 'ethnic and Chinese instruments',
  percussive: 'mallet and melodic percussion',
  drums: 'drum kits',
}

const RANGES = [
  ['piano', 0, 7],
  ['chromatic', 8, 15],
  ['organ', 16, 23],
  ['guitar', 24, 31],
  ['bass', 32, 39],
  ['strings', 40, 47],
  ['ensemble', 48, 55],
  ['brass', 56, 63],
  ['reed', 64, 71],
  ['pipe', 72, 79],
  ['synthLead', 80, 87],
  ['synthPad', 88, 95],
  ['ethnic', 104, 111],
  ['percussive', 112, 119],
]

/** Map a GM program to the family the scoring tables use. FX programs (96-103,
 * 120-127) fall back to synthPad, which is where they are usually used as. */
export function categoryOfProgram(program) {
  const value = Number(program)
  if (!Number.isInteger(value) || value < 0 || value > 127) return 'synthPad'
  for (const [category, min, max] of RANGES) if (value >= min && value <= max) return category
  return 'synthPad'
}

/**
 * Score a font for one category, 1-10. A preset-level override wins over the
 * family score; families the font does not list fall back to `default`.
 */
export function fontScore(font, category, program) {
  if (!font) return 0
  const overrides = Array.isArray(font.presetScores) ? font.presetScores : []
  if (Number.isInteger(program)) {
    const override = overrides.find((entry) => entry.program === program && (entry.bank ?? 0) === 0)
    if (override && Number.isFinite(override.score)) return clampScore(override.score)
  }
  const scores = font.scores ?? {}
  if (Number.isFinite(scores[category])) return clampScore(scores[category])
  if (Number.isFinite(scores.default)) return clampScore(scores.default)
  return 5
}

function clampScore(value) {
  return Math.max(1, Math.min(10, Math.round(value)))
}

/** Rank fonts for a category; ties keep the declared order (default font first). */
export function rankFonts(fonts, category, program) {
  return [...fonts]
    .map((font, index) => ({ font, index, score: fontScore(font, category, program) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => ({ ...entry.font, score: entry.score, category }))
}

/** Human-readable table used by the sources tool and the skill. */
export function scoreTable(fonts) {
  return fonts.map((font) => ({
    id: font.id,
    scores: Object.fromEntries(Object.keys(CATEGORY_LABELS).map((category) => [category, fontScore(font, category)])),
  }))
}
