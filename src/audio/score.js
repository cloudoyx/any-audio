/**
 * Score parsing: turns a compact JSON score (seconds-based, video-timeline
 * friendly) into sample-accurate MIDI events for the SoundFont renderer.
 */

const NOTE_BASE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
const ACCIDENTAL = { '#': 1, s: 1, '♯': 1, b: -1, '♭': -1 }

/** General MIDI programs that map well onto the instrument families used for
 *  animation scoring. Chinese instruments point at their closest GM timbre;
 *  a custom SoundFont may expose better patches under a different program. */
export const INSTRUMENTS = {
  piano: 0, 'grand-piano': 0, 'bright-piano': 1, epiano: 4, 'electric-piano': 4,
  harpsichord: 6, celesta: 8, glockenspiel: 9, musicbox: 10, 'music-box': 10,
  vibraphone: 11, marimba: 12, xylophone: 13, 'tubular-bells': 14, dulcimer: 15,
  organ: 16, accordion: 21, harmonica: 22, 'nylon-guitar': 24, guitar: 25,
  'steel-guitar': 25, 'jazz-guitar': 26, 'clean-guitar': 27, 'muted-guitar': 28,
  overdrive: 29, distortion: 30, 'bass': 33, 'finger-bass': 33, 'pick-bass': 34,
  'fretless-bass': 35, 'slap-bass': 36,
  violin: 40, viola: 41, cello: 42, contrabass: 43, 'tremolo-strings': 44,
  pizzicato: 45, harp: 46, timpani: 47, strings: 48, 'slow-strings': 49,
  'synth-strings': 50, choir: 52, 'voice-ooh': 53, 'synth-voice': 54,
  trumpet: 56, trombone: 57, tuba: 58, 'muted-trumpet': 59, horn: 60,
  'brass-section': 61, 'synth-brass': 62, sax: 65, 'soprano-sax': 64,
  'tenor-sax': 66, oboe: 68, englishhorn: 69, bassoon: 70, clarinet: 71,
  piccolo: 72, flute: 73, recorder: 74, 'pan-flute': 75, 'bottle-blow': 76,
  shakuhachi: 77, whistle: 78, ocarina: 79,
  'square-lead': 80, 'saw-lead': 81, 'calliope-lead': 82, 'charang': 84,
  'voice-lead': 85, 'fifth-lead': 86, 'bass-lead': 87,
  'new-age-pad': 88, 'warm-pad': 89, 'polysynth-pad': 90, 'choir-pad': 91,
  'bowed-pad': 92, 'metal-pad': 93, 'halo-pad': 94, 'sweep-pad': 95,
  'rain-fx': 96, soundtrack: 97, crystal: 98, atmosphere: 99, brightness: 100,
  'goblins': 101, echoes: 102, 'sci-fi': 103, sitar: 104, banjo: 105,
  shamisen: 106, koto: 107, kalimba: 108, bagpipes: 109, fiddle: 110,
  shenai: 111, 'tinkle-bell': 112, agogo: 113, 'steel-drums': 114,
  woodblock: 115, taiko: 116, 'melodic-tom': 117, 'synth-drum': 118,
  'reverse-cymbal': 119, 'guitar-fret': 120, 'breath-noise': 121,
  seashore: 122, birds: 123, telephone: 124, helicopter: 125,
  applause: 126, gunshot: 127,
  // Chinese instruments: closest GM timbre, documented here so the model does
  // not have to guess program numbers.
  guzheng: 107, guqin: 107, pipa: 105, yangqin: 15, erhu: 110,
  dizi: 73, xiao: 77, sheng: 22, suona: 111, bianzhong: 112, 'chinese-drums': 116,
  drums: 0, kit: 0,
}

export const DRUM_MAP = {
  kick: 36, 'kick-soft': 35, snare: 38, 'snare-rim': 37, 'clap': 39,
  'hat-closed': 42, 'hat-pedal': 44, 'hat-open': 46, crash: 49, ride: 51,
  'tom-low': 41, 'tom-mid': 45, 'tom-high': 48, 'tom-floor': 43,
  cowbell: 56, tambourine: 54, shaker: 70, 'taiko': 41, 'low-drum': 36,
  gong: 52, 'chinese-cymbal': 52, 'ride-bell': 53, 'triangle': 81,
}

const AUTOMATION = {
  volume: 7, pan: 10, expression: 11, modulation: 1, breath: 2,
  sustain: 64, 'reverb-send': 91, 'chorus-send': 93, brightness: 74,
  cutoff: 74, resonance: 71, vibrato: 1,
}

const DEFAULT_VELOCITY = 88
const BLOCK = 128
const EVENT_PRIORITY = { bank: 0, program: 1, cc: 2, off: 3, on: 4 }

export class ScoreError extends Error {
  constructor(issues) {
    super(Array.isArray(issues) ? issues.join('\n') : String(issues))
    this.name = 'ScoreError'
    this.issues = Array.isArray(issues) ? issues : [String(issues)]
  }
}

export function parsePitch(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`invalid pitch: ${value}`)
    const rounded = Math.round(value)
    if (rounded < 0 || rounded > 127) throw new Error(`pitch out of MIDI range: ${value}`)
    return rounded
  }
  if (typeof value === 'string') {
    const match = /^([a-gA-G])([#bs♯♭]?)(-?\d+)$/.exec(value.trim())
    if (!match) throw new Error(`invalid pitch name "${value}" (use MIDI numbers or names like D3, F#4, Bb2)`)
    const semitone = NOTE_BASE[match[1].toLowerCase()] + (ACCIDENTAL[match[2]] ?? 0)
    const midi = (Number(match[3]) + 1) * 12 + semitone
    if (midi < 0 || midi > 127) throw new Error(`pitch out of MIDI range: ${value}`)
    return midi
  }
  throw new Error(`invalid pitch: ${String(value)}`)
}

export function resolveInstrument(spec) {
  if (spec === undefined || spec === null || spec === '') return { program: 0, bank: 0, label: 'piano' }
  if (typeof spec === 'number') {
    if (!Number.isInteger(spec) || spec < 0 || spec > 127) throw new Error(`invalid program number: ${spec}`)
    return { program: spec, bank: 0, label: `program ${spec}` }
  }
  if (typeof spec === 'string') {
    const key = spec.trim().toLowerCase().replace(/[\s_]+/g, '-')
    if (key in INSTRUMENTS) return { program: INSTRUMENTS[key], bank: 0, label: key }
    const asNumber = Number(key)
    if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 127) return { program: asNumber, bank: 0, label: `program ${asNumber}` }
    throw new Error(`unknown instrument "${spec}"; see the anyaudio-scoring skill for the instrument list or pass a GM program number`)
  }
  if (typeof spec === 'object') {
    const base = resolveInstrument(spec.program ?? spec.presetName ?? 0)
    return { program: base.program, bank: Number.isFinite(spec.bank) ? spec.bank : 0, label: spec.name ?? base.label }
  }
  throw new Error(`invalid instrument: ${String(spec)}`)
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function number(value, what) {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(parsed)) throw new Error(`${what} must be a number, got ${JSON.stringify(value)}`)
  return parsed
}

function collectNotes(track, warn, drums = false) {
  const notes = []
  if (!Array.isArray(track.notes)) throw new Error(`track "${track.name}" needs a notes array`)
  const parseOne = (value) => {
    if (drums && typeof value === 'string') {
      const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-')
      if (key in DRUM_MAP) return DRUM_MAP[key]
    }
    return parsePitch(value)
  }
  track.notes.forEach((entry, index) => {
    let start, duration, pitch, velocity
    if (Array.isArray(entry)) {
      ;[start, duration, pitch, velocity] = entry
    } else if (entry && typeof entry === 'object') {
      start = entry.t ?? entry.start ?? entry.time
      duration = entry.d ?? entry.dur ?? entry.duration
      pitch = entry.p ?? entry.pitch ?? entry.n ?? entry.note
      velocity = entry.v ?? entry.velocity
    } else {
      throw new Error(`track "${track.name}" note #${index} must be an array or object`)
    }
    start = number(start, `note #${index} start`)
    duration = number(duration, `note #${index} duration`)
    if (start < 0) throw new Error(`track "${track.name}" note #${index} starts before 0`)
    if (duration <= 0) throw new Error(`track "${track.name}" note #${index} duration must be > 0`)
    const pitches = Array.isArray(pitch) ? pitch : [pitch]
    if (!pitches.length) throw new Error(`track "${track.name}" note #${index} has no pitch`)
    const vel = velocity === undefined ? DEFAULT_VELOCITY : Math.round(number(velocity, `note #${index} velocity`))
    if (vel < 1 || vel > 127) warn(`track "${track.name}" note #${index} velocity clamped to 1..127`)
    for (const p of pitches) {
      notes.push({ start, duration, midi: parseOne(p), velocity: Math.max(1, Math.min(127, vel)) })
    }
  })
  return notes
}

function applyHumanize(notes, humanize, seed) {
  if (!humanize) return notes
  const timing = Math.max(0, Number(humanize.timingMs ?? 0)) / 1000
  const velocitySpread = Math.max(0, Number(humanize.velocity ?? 0))
  if (!timing && !velocitySpread) return notes
  const random = mulberry32(seed)
  return notes.map((note) => {
    const shift = timing ? (random() * 2 - 1) * timing : 0
    const velocityJitter = velocitySpread ? Math.round((random() * 2 - 1) * velocitySpread) : 0
    return {
      ...note,
      start: Math.max(0, note.start + shift),
      velocity: Math.max(1, Math.min(127, note.velocity + velocityJitter)),
    }
  })
}

function automationEvents(automation, warn) {
  const trackName = automation.track ?? automation.name
  if (!trackName) throw new Error('automation entry needs a track name')
  const controller = automation.controller ?? automation.cc
  const cc = typeof controller === 'number' ? controller : AUTOMATION[String(controller ?? 'expression').toLowerCase()]
  if (cc === undefined) throw new Error(`unknown automation controller "${controller}"`)
  const points = automation.points
  if (!Array.isArray(points) || points.length === 0) throw new Error(`automation for "${trackName}" needs points`)
  const parsed = points.map((point, index) => {
    const [t, raw] = Array.isArray(point) ? point : [point.t, point.v ?? point.value]
    const value = number(raw, `automation point #${index} value`)
    return { t: Math.max(0, number(t, `automation point #${index} time`)), value: Math.max(0, Math.min(127, value)) }
  })
  parsed.sort((a, b) => a.t - b.t)
  const events = []
  const step = 1 / 20
  for (let i = 0; i < parsed.length; i++) {
    const current = parsed[i]
    events.push({ t: current.t, type: 'cc', controller: cc, value: Math.round(current.value) })
    const next = parsed[i + 1]
    if (!next) continue
    const span = next.t - current.t
    if (span <= step) continue
    for (let t = current.t + step; t < next.t - 1e-6; t += step) {
      const ratio = (t - current.t) / span
      events.push({ t, type: 'cc', controller: cc, value: Math.round(current.value + (next.value - current.value) * ratio) })
    }
  }
  return { trackName, events }
}

/**
 * CC7 for a relative gain. spessasynth's concave volume curve gives an
 * attenuation of 40*log10(cc/127) dB, so a plain dB conversion needs /40.
 */
function cc7For(gainDb) {
  return Math.max(1, Math.min(127, Math.round(127 * Math.pow(10, gainDb / 40))))
}

/**
 * Compile a score object into per-track event lists.
 * Notes use seconds so the musical timeline and the video timeline share one
 * clock; no tempo map is needed.
 */
export function compileScore(score, { sampleRate = 48000 } = {}) {
  if (!score || typeof score !== 'object') throw new ScoreError('score must be a JSON object')
  if (!Array.isArray(score.tracks) || score.tracks.length === 0) throw new ScoreError('score.tracks must be a non-empty array')
  if (score.tracks.length > 16) throw new ScoreError('a score can use at most 16 tracks (one MIDI channel each)')
  const warnings = []
  const warn = (message) => {
    if (!warnings.includes(message)) warnings.push(message)
  }

  const usedChannels = new Set()
  // Per-track volume goes out as CC7. spessasynth maps CC7 to initialAttenuation
  // with a 40*log10 curve (not the 20*log10 a plain dB gain would need), so the
  // gain is applied as (gainDb - offset) / 40 with one offset per score: that
  // keeps the authored balance, makes positive gains reachable (the loudest
  // track sits at CC7 127) and keeps the master normalisation in charge of the
  // absolute level. See test/verify.mjs "per-track gainDb matches the request".
  const gainCeiling = score.tracks.reduce((max, raw) => {
    const value = Number(raw?.gainDb)
    return Number.isFinite(value) ? Math.max(max, value) : max
  }, 0)
  const tracks = score.tracks.map((raw, index) => {
    const track = raw ?? {}
    const name = String(track.name ?? `track-${index + 1}`)
    const drums = track.drums === true || track.kit === true
    let channel = Number.isInteger(track.channel) ? track.channel : drums ? 9 : undefined
    if (channel === undefined) {
      channel = [...Array(16).keys()].find((candidate) => !usedChannels.has(candidate) && candidate !== 9)
    }
    if (channel === undefined) throw new ScoreError('ran out of free MIDI channels; merge some tracks')
    if (channel < 0 || channel > 15) throw new ScoreError(`track "${name}": channel must be 0..15`)
    if (usedChannels.has(channel)) throw new ScoreError(`track "${name}": channel ${channel} is already used by another track`)
    usedChannels.add(channel)

    const instrument = resolveInstrument(track.instrument ?? track.program ?? (drums ? 'drums' : 'piano'))
    const source = typeof track.source === 'string' && track.source.trim() ? track.source.trim() : undefined
    const gainDb = Number.isFinite(Number(track.gainDb)) ? Number(track.gainDb) : 0
    const pan = Number.isFinite(Number(track.pan)) ? Math.max(-1, Math.min(1, Number(track.pan))) : 0
    const reverb = Number.isFinite(Number(track.reverb)) ? Math.max(0, Math.min(1, Number(track.reverb))) : 0.35
    const chorus = Number.isFinite(Number(track.chorus)) ? Math.max(0, Math.min(1, Number(track.chorus))) : 0

    let notes = collectNotes(track, warn, drums)
    notes = applyHumanize(notes, track.humanize, index * 7919 + (Number(track.humanize?.seed) || 0))

    const events = []
    const program = drums ? 0 : instrument.program
    events.push({ t: 0, type: 'bank', channel, bank: instrument.bank })
    events.push({ t: 0, type: 'program', channel, program })
    events.push({ t: 0, type: 'cc', channel, controller: 7, value: cc7For(gainDb - gainCeiling) })
    events.push({ t: 0, type: 'cc', channel, controller: 10, value: Math.round((pan + 1) * 63.5) })
    events.push({ t: 0, type: 'cc', channel, controller: 91, value: Math.round(reverb * 127) })
    if (chorus > 0) events.push({ t: 0, type: 'cc', channel, controller: 93, value: Math.round(chorus * 127) })
    for (const note of notes) {
      events.push({ t: note.start, type: 'on', channel, note: note.midi, velocity: note.velocity })
      events.push({ t: note.start + note.duration, type: 'off', channel, note: note.midi })
    }
    events.sort((a, b) => a.t - b.t || EVENT_PRIORITY[a.type] - EVENT_PRIORITY[b.type])

    const end = notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0)
    return {
      name, channel, program, bank: instrument.bank, instrument: instrument.label, source,
      drums, gainDb, pan, reverb, chorus, notes, events, endSec: end,
    }
  })

  const byName = new Map(tracks.map((track) => [track.name, track]))
  for (const automation of score.automation ?? []) {
    const { trackName, events } = automationEvents(automation, warn)
    const target = byName.get(trackName)
    if (!target) throw new ScoreError(`automation references unknown track "${trackName}"`)
    for (const event of events) target.events.push({ ...event, channel: target.channel })
    target.events.sort((a, b) => a.t - b.t)
  }

  const endSec = tracks.reduce((max, track) => Math.max(max, track.endSec), 0)
  const declared = Number(score.durationSec)
  const durationSec = Number.isFinite(declared) && declared > 0 ? Math.max(declared, endSec) : endSec

  return {
    sampleRate,
    title: score.title ?? 'untitled',
    tracks,
    endSec,
    durationSec,
    effects: {
      reverb: Number.isFinite(Number(score.effects?.reverb)) ? Number(score.effects.reverb) : 1,
      chorus: Number.isFinite(Number(score.effects?.chorus)) ? Number(score.effects.chorus) : 0,
      delay: Number.isFinite(Number(score.effects?.delay)) ? Number(score.effects.delay) : 0,
    },
    warnings,
  }
}

export { BLOCK }
