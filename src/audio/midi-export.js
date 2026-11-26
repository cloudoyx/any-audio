/**
 * Standard MIDI export, one file per instrument track.
 *
 * This is the clip bay's button, not a tool: the scores are the ones
 * `anyaudio_music` already froze into `sources/<materialId>.score.json`, so a
 * project rendered before those snapshots existed simply has nothing to export.
 *
 * What goes in is what the person would keep working with in a DAW: notes,
 * velocities and the CC11 expression curve. Mix CCs (volume, pan, sends) and
 * program/bank are deliberately left out — the instruments are replaced by the
 * person's own at the other end.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MIDIBuilder } from 'spessasynth_core'

import { projectDir, resolveInside, safeName } from '../project/paths.js'
import { readMaterialIndex } from '../project/store.js'
import { compileScore } from './score.js'

const MIDI_DIR = 'midi'
/** Ticks per quarter note: the value a DAW reads without second-guessing. */
const PPQ = 480
/** The score counts seconds; a tempo is only what turns seconds into ticks. */
const BPM = 120

function ticksAt(second, { bpm = BPM, ppq = PPQ } = {}) {
  return Math.max(0, Math.round((second * bpm * ppq) / 60))
}

/**
 * One track as a standalone MIDI file.
 *
 * Events are added in tick order because the writer appends deltas as they come:
 * at the same tick a controller change goes first (so a note starts with the
 * right expression), then note-offs, then note-ons.
 *
 * Exported so the ordering can be tested without building a project.
 */
export function buildTrackMidi(track, { bpm = BPM, ppq = PPQ } = {}) {
  const builder = new MIDIBuilder({ format: 0, name: track.name, timeDivision: ppq, initialTempo: bpm })
  const events = []
  for (const note of track.notes) {
    events.push({ tick: ticksAt(note.start, { bpm, ppq }), order: 2, kind: 'on', note })
    events.push({ tick: ticksAt(note.start + note.duration, { bpm, ppq }), order: 1, kind: 'off', note })
  }
  for (const event of track.events) {
    if (event.type !== 'cc' || event.controller !== 11) continue
    events.push({ tick: ticksAt(event.t, { bpm, ppq }), order: 0, kind: 'cc', value: event.value })
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  for (const event of events) {
    if (event.kind === 'cc') {
      builder.controllerChange(event.tick, 0, track.channel, 11, event.value)
    } else if (event.kind === 'on') {
      builder.noteOn(event.tick, 0, track.channel, event.note.midi, event.note.velocity)
    } else {
      builder.noteOff(event.tick, 0, track.channel, event.note.midi)
    }
  }
  return Buffer.from(builder.writeMIDI())
}

/**
 * The distinct scores a project holds: the same score written onto every stem
 * material is one score, not one per stem. Anything unreadable is reported in
 * `skipped` instead of failing the whole click or vanishing silently.
 */
export async function readProjectScores(workspaceRoot, projectId) {
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const root = projectDir(workspaceRoot, projectId)
  const scores = new Map()
  const skipped = []
  for (const material of index.materials ?? []) {
    const snapshot = material?.source?.snapshot
    if (typeof snapshot !== 'string' || !snapshot.endsWith('.score.json')) continue
    let text
    try {
      text = await readFile(resolveInside(root, snapshot, 'source.snapshot'), 'utf8')
    } catch {
      // The snapshot is gone, or the index was hand-edited to point outside the
      // project. The music itself is still there; only its MIDI cannot be made.
      skipped.push(`${material?.label ?? material?.id ?? 'score'}: snapshot unreadable`)
      continue
    }
    const key = createHash('sha1').update(text).digest('hex').slice(0, 8)
    if (scores.has(key)) continue
    try {
      scores.set(key, { key, score: JSON.parse(text) })
    } catch (error) {
      skipped.push(`${material?.label ?? material?.id ?? 'score'}: ${error.message}`)
    }
  }
  return { scores: [...scores.values()], skipped: [...new Set(skipped)] }
}

/**
 * Write `<project>/midi/<title>-<key>/<track>.mid` for every score in the
 * project. The folder is keyed by the score's content, so clicking twice
 * replaces the same files instead of piling up copies.
 */
export async function exportProjectMidi({ workspaceRoot, projectId }) {
  const { scores, skipped } = await readProjectScores(workspaceRoot, projectId)
  const outRoot = join(projectDir(workspaceRoot, projectId), MIDI_DIR)
  const files = []
  for (const { key, score } of scores) {
    let compiled
    try {
      compiled = compileScore(score)
    } catch (error) {
      skipped.push(`${score?.title ?? key}: ${error.message}`)
      continue
    }
    const title = safeName(String(score?.title ?? '').trim(), 'score')
    const folder = `${title}-${key}`
    const dir = join(outRoot, folder)
    // Replace, do not merge: a track renamed since the last click must not leave
    // its old file behind.
    await rm(dir, { recursive: true, force: true })
    const tracks = compiled.tracks.filter((track) => track.notes.length > 0)
    if (tracks.length === 0) continue
    await mkdir(dir, { recursive: true })
    const used = new Set()
    for (const track of tracks) {
      const base = safeName(track.name, 'track')
      let name = base
      for (let suffix = 2; used.has(name); suffix++) name = `${base}-${suffix}`
      used.add(name)
      await writeFile(join(dir, `${name}.mid`), buildTrackMidi(track))
      files.push(`${MIDI_DIR}/${folder}/${name}.mid`.replace(/\\/g, '/'))
    }
  }
  return { dir: scores.length > 0 ? outRoot : null, files, scores: scores.length, skipped }
}
