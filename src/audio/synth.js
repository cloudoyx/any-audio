import { readFile, stat } from 'node:fs/promises'
import { SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core'
import { peakOf, rmsOf, toDb } from './wav.js'

const BLOCK = 128
const bankCache = new Map()

/** Load a SoundFont/DLS bank, cached by path + mtime so repeated tool calls stay fast. */
export async function loadSoundBank(path) {
  const info = await stat(path)
  const key = `${path}:${info.size}:${info.mtimeMs}`
  const cached = bankCache.get(key)
  if (cached) return cached
  const raw = await readFile(path)
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  let bank
  try {
    bank = SoundBankLoader.fromArrayBuffer(buffer)
  } catch (error) {
    throw new Error(`could not parse soundbank "${path}": ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!bank || !Array.isArray(bank.presets) || bank.presets.length === 0) {
    throw new Error(`soundbank "${path}" contains no presets`)
  }
  if (bankCache.size > 4) bankCache.clear()
  bankCache.set(key, bank)
  return bank
}

export function listPresets(bank, { query, limit = 200 } = {}) {
  const filter = typeof query === 'string' && query.trim() ? query.trim().toLowerCase() : null
  const presets = (bank.presets ?? []).filter((preset) => {
    if (!filter) return true
    return String(preset.name ?? '').toLowerCase().includes(filter) || String(preset.program) === filter
  })
  return presets.slice(0, limit).map((preset) => ({
    name: preset.name,
    program: preset.program,
    bank: preset.bankMSB ?? 0,
    drums: preset.isGMGSDrum === true || (preset.bankMSB ?? 0) === 120,
  }))
}

function applyEvent(synth, event) {
  switch (event.type) {
    case 'on':
      synth.noteOn(event.channel, event.note, event.velocity)
      break
    case 'off':
      synth.noteOff(event.channel, event.note)
      break
    case 'cc':
      synth.controllerChange(event.channel, event.controller, event.value)
      break
    case 'program':
      synth.programChange(event.channel, event.program)
      break
    case 'bank':
      synth.controllerChange(event.channel, 0, Math.max(0, Math.min(127, event.bank | 0)))
      break
    case 'pitch':
      synth.pitchWheel(event.channel, event.value)
      break
    default:
      throw new Error(`unknown score event "${event.type}"`)
  }
}

/**
 * Render compiled score events with the SoundFont engine.
 * All tracks share one synth pass so reverb and chorus behave like a real
 * ensemble; `onlyTrack` renders a single stem for later mixing.
 *
 * Pass either one `soundBank` (legacy) or `banks` + `layout` from
 * `planFonts()`; the layout remaps each track's bank offset and program so
 * different tracks can use different fonts in the same synth.
 */
export async function renderCompiled(compiled, options) {
  const {
    soundBank,
    banks,
    layout,
    sampleRate = compiled.sampleRate ?? 48000,
    durationSec,
    onlyTrack,
    peakDb = -3,
    normalize = true,
  } = options

  const bankList = Array.isArray(banks) && banks.length > 0 ? banks : soundBank ? [{ bank: soundBank, id: 'main', offset: 0 }] : null
  if (!bankList) throw new Error('renderCompiled needs a soundBank or a banks array')

  const tracks = onlyTrack ? compiled.tracks.filter((track) => track.name === onlyTrack) : compiled.tracks
  if (onlyTrack && tracks.length === 0) {
    throw new Error(`score has no track named "${onlyTrack}"`)
  }
  const endSec = tracks.reduce((max, track) => Math.max(max, track.endSec), 0)
  const explicitDuration = Number.isFinite(durationSec)
  const totalSec = Math.max(0.1, explicitDuration ? durationSec : endSec)
  const frames = Math.ceil(totalSec * sampleRate)

  const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false, voiceCap: 512 })
  for (const entry of bankList) synth.soundBankManager.addSoundBank(entry.bank, entry.id ?? 'main', entry.offset ?? 0)
  await synth.processorInitialized
  synth.setSystemParameter('reverbGain', compiled.effects.reverb)
  synth.setSystemParameter('chorusGain', compiled.effects.chorus)
  synth.setSystemParameter('delayGain', compiled.effects.delay)

  const assignmentFor = (track) => {
    if (!layout) return null
    return typeof layout.get === 'function' ? layout.get(track.name) ?? null : layout[track.name] ?? null
  }

  const events = []
  for (const track of tracks) {
    const assignment = assignmentFor(track)
    for (const event of track.events) {
      if (!assignment) {
        events.push(event)
        continue
      }
      if (event.type === 'bank') {
        events.push({ ...event, bank: Math.max(0, Math.min(127, (event.bank ?? 0) + (assignment.offset ?? 0))) })
      } else if (event.type === 'program' && Number.isInteger(assignment.program)) {
        events.push({ ...event, program: assignment.program })
      } else {
        events.push(event)
      }
    }
  }
  events.sort((a, b) => a.t - b.t)

  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  let position = 0
  for (const event of events) {
    const target = Math.min(frames, Math.round(event.t * sampleRate))
    while (position < target) {
      const count = Math.min(BLOCK, target - position)
      synth.process(left, right, position, count)
      position += count
    }
    applyEvent(synth, event)
  }
  while (position < frames) {
    const count = Math.min(BLOCK, frames - position)
    synth.process(left, right, position, count)
    position += count
  }

  let broken = 0
  for (let i = 0; i < frames; i++) {
    if (!Number.isFinite(left[i])) {
      left[i] = 0
      broken++
    }
    if (!Number.isFinite(right[i])) {
      right[i] = 0
      broken++
    }
  }

  const peakBefore = peakOf([left, right])
  let appliedGain = 1
  if (normalize && peakBefore > 0 && Number.isFinite(peakDb)) {
    appliedGain = Math.pow(10, peakDb / 20) / peakBefore
    for (let i = 0; i < frames; i++) {
      left[i] *= appliedGain
      right[i] *= appliedGain
    }
  }

  return {
    channels: [left, right],
    sampleRate,
    durationSec: frames / sampleRate,
    frames,
    appliedGain,
    peakBeforeDb: toDb(peakBefore),
    peakDb: toDb(peakOf([left, right])),
    rmsDb: toDb(rmsOf([left, right])),
    brokenSamples: broken,
    notes: tracks.reduce((sum, track) => sum + track.notes.length, 0),
    voices: synth.voiceCount,
  }
}
