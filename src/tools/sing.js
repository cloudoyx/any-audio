// anyaudio_sing — local singing synthesis tool.
//
// The Agent supplies notes in the independent four-field singing format and the
// engine (engine/worker.py, driven by the M1 process manager) sings them on the
// local machine. The result lands on its own track in the clip bay as a single
// WAV, so it can be played, gain-adjusted, and regenerated line by line.
//
// Only one mode exists: per-phrase segmentation (no whole-song switch). A phrase
// is a run of notes separated by a rest (midi=null or a time gap); its timeline
// is zeroed before it is sent, otherwise the engine would fill 0..phraseStart
// with a leading rest (scheme appendix A.7 #7). The verse chunks are synthesised
// sequentially by one process and concatenated into one material.

import { readFile, rm, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseWav, encodeWav, peakOf, rmsOf, toDb } from '../audio/wav.js'
import { readConfig } from '../config.js'
import { attachMaterialFile } from '../project/attach.js'
import { projectDir } from '../project/paths.js'
import { createSingingProcess } from '../audio/singing-process.js'
import {
  deliverCopy, deliveryPath, finalizeTool, nowStamp, relativeToWorkspace,
  requireProjectId, scratchPath, textRenderer, workspaceRootOf, writeWavFile,
} from './shared.js'

// Injection point: tests install a fake process factory so no 1 GB runtime is
// needed. Production uses the real M1 manager. Same shape as TTS's credential
// resolver injection.
let processFactory = (options) => createSingingProcess(options)
export function setSingingProcessFactory(factory) {
  processFactory = factory ?? ((options) => createSingingProcess(options))
}

/** Validate + normalise a note. Returns [startSec, durSec, midi|null, lyric]. */
export function parseNote(raw, index) {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error(`notes[${index}] must be [startSec, durSec, midi|null, lyric]`)
  }
  const start = Number(raw[0])
  const dur = Number(raw[1])
  if (!Number.isFinite(start) || start < 0) throw new Error(`notes[${index}]: startSec must be a non-negative number`)
  if (!Number.isFinite(dur) || dur <= 0) throw new Error(`notes[${index}]: durSec must be greater than 0`)
  let midi = raw[2]
  if (midi !== null && midi !== undefined) {
    midi = Number(midi)
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
      throw new Error(`notes[${index}]: midi must be an integer 0..127 or null (rest)`)
    }
  } else {
    midi = null
  }
  const lyric = raw[3] === undefined || raw[3] === null ? '' : String(raw[3]).trim()
  return [start, dur, midi, lyric]
}

/** Split notes on rests (midi=null) or on a gap between notes, zeroing each
 *  phrase's timeline so no leading rest is inserted by the engine. */
export function splitNotes(notes) {
  const sorted = [...notes].sort((a, b) => a[0] - b[0])
  const phrases = []
  let current = []
  for (const note of sorted) {
    if (note[2] === null) {
      if (current.length) { phrases.push(current); current = [] }
      continue
    }
    current.push(note)
  }
  if (current.length) phrases.push(current)

  return phrases.map((phrase) => {
    const base = phrase[0][0]
    return phrase.map(([start, dur, midi, lyric]) => [Number((start - base).toFixed(4)), dur, midi, lyric])
  })
}

async function readWavMono(path) {
  const wav = parseWav(await readFile(path))
  const mono = new Float32Array(wav.frames)
  for (let i = 0; i < wav.frames; i++) {
    let sum = 0
    for (const channel of wav.channels) sum += channel[i]
    mono[i] = sum / wav.channels.length
  }
  return { mono, sampleRate: wav.sampleRate }
}

export const singToolDefinition = finalizeTool({
  name: 'anyaudio_sing',
  description:
    'Synthesise singing locally: notes with lyrics in → a sung WAV on its own track in the clip bay project. ' +
    'This is real singing synthesis (DiffSinger), not composing or narration. ' +
    'Call it whenever the user wants a song, a melody sung, lyrics set to notes, or a vocal line — no need to name this tool explicitly. ' +
    'Pass projectId (create one with anyaudio_project first); the sung voice is added as material on a separate ' +
    'human-voice track (kind: sing, same mixing class as narration) so the person can open, play and adjust it. ' +
    'Note format — each note is [startSec, durSec, midi, lyric]: startSec = absolute seconds on the song timeline, ' +
    'durSec = length in seconds, midi = MIDI pitch (use null for a rest), lyric = the lyric syllable. ' +
    'A dragged syllable (melisma, one character over several notes) is ONE note with the character plus following notes with an empty lyric "" — ' +
    'never write the character on every note. Notes are automatically split at rests into phrases, each phrase\'s timeline is zeroed, ' +
    'and the phrases are sung in sequence; this is the only mode (no whole-song-in-one-pass switch). ' +
    'The engine corrects polyphonic characters by reading the whole lyric line (e.g. 银行 → h ang). ' +
    'Regenerating one line is the core strength: sing a four-line song, then only re-run this tool with the 3rd line\'s notes to replace just that line ' +
    '(change the score / voicebank / melody), and use the clip bay\'s split-and-replace to cut the old line and drop in the new — ' +
    'no need to regenerate the whole song. The first call may take a while (the runtime and voicebank must be installed).',
  parameters: {
    type: 'object',
    properties: {
      notes: {
        type: 'array',
        description: 'Song notes in four-field form: [startSec, durSec, midi|null, lyric]. Empty lyric = melisma continuing the previous character; midi null = rest (also the phrase separator). Absolutely positioned in seconds; the tool zeroes each phrase before sending it to the engine.',
        items: {
          type: 'array',
          minItems: 3,
          items: [
            { type: 'number' },
            { type: 'number' },
            { oneOf: [{ type: 'integer' }, { type: 'null' }] },
            { type: 'string' },
          ],
        },
      },
      projectId: { type: 'string', description: 'The clip bay project this singing belongs to. Required: run anyaudio_project mode:"create" first when the task has no project yet.' },
      voicebank: { type: 'string', description: 'Optional voicebank name or directory; defaults to the configured/installed voicebank.' },
      device: { type: 'string', enum: ['auto', 'cpu', 'cuda'], description: 'Optional inference device; defaults to the configured device. A device change recycles the singing process.' },
      trackName: { type: 'string', description: 'Optional name for the vocal track, default 演唱.' },
      startSec: { type: 'number', description: 'Where the sung voice starts on the project timeline, default 0.' },
      output: { type: 'string', description: 'Optional extra copy of the sung WAV. The project\'s own copy is always written under the project folder.' },
      maxSeconds: { type: 'number', description: 'Safety cap on total audio length in seconds, default 300.' },
    },
    required: ['notes', 'projectId'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        projectId: { type: 'string' },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        delivered: { type: 'string' },
        deliveredAbsolutePath: { type: 'string' },
        attached: { type: 'object', additionalProperties: true },
        phrases: { type: 'array', items: { type: 'object', additionalProperties: true } },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        peakDb: { type: 'number' },
        rmsDb: { type: 'number' },
        device: { type: 'string' },
        voicebank: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: textRenderer((args, value) => {
      const lines = [
        `Sung ${value.durationSec.toFixed(2)}s @ ${value.sampleRate} Hz → ${value.file}`,
        `peak ${Number(value.peakDb).toFixed(1)} dBFS, RMS ${Number(value.rmsDb).toFixed(1)} dBFS`,
        `${value.phrases?.length ?? 0} phrase(s), device ${value.device ?? '?'}`,
        `Voice track: ${value.attached?.trackName ?? '?'} in project ${value.projectId}`,
      ]
      if (value.phrases?.length) {
        lines.push('Phrases:')
        for (const phrase of value.phrases) {
          lines.push(`- ${phrase.text || '(no lyric)'}: ${phrase.seconds}s, ${phrase.notes} notes`)
        }
      }
      for (const warning of value.warnings ?? []) lines.push(`Warning: ${warning}`)
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const projectId = requireProjectId(args, 'anyaudio_sing')
    if (!Array.isArray(args.notes) || args.notes.length === 0) {
      throw new Error('anyaudio_sing needs a non-empty "notes" array of [startSec, durSec, midi|null, lyric]')
    }
    const notes = args.notes.map((note, index) => parseNote(note, index))
    const phrases = splitNotes(notes)
    if (phrases.length === 0) throw new Error('anyaudio_sing: no sung notes (all notes were rests)')

    const maxSeconds = Number.isFinite(Number(args.maxSeconds)) && Number(args.maxSeconds) > 0
      ? Number(args.maxSeconds) : 300
    const { config } = await readConfig()
    const device = args.device ?? config.singing?.device ?? 'auto'
    const voicebank = args.voicebank ?? config.singing?.voicebank ?? undefined
    const startSec = Number.isFinite(Number(args.startSec)) && Number(args.startSec) >= 0 ? Number(args.startSec) : 0

    const stamp = nowStamp()
    const scratchDir = scratchPath(workspaceRoot, `singing-${stamp}`)
    await mkdir(scratchDir, { recursive: true })
    const manager = processFactory({ device, voicebank })

    const chunks = []
    const phraseInfo = []
    let sampleRate = 44100
    let usedDevice = device
    try {
      // Phrases go through ONE process sequentially (M1 serialises + pins device).
      for (let index = 0; index < phrases.length; index++) {
        const phrase = phrases[index]
        const out = join(scratchDir, `phrase-${index + 1}.wav`)
        let result
        try {
          result = await manager.sing({
            notes: phrase,
            out,
            maxSeconds,
            ...(args.speaker ? { speaker: args.speaker } : {}),
          })
        } catch (error) {
          throw new Error(`phrase ${index + 1} (${phrase.map((n) => n[3]).filter(Boolean).join('') || 'melisma'}) failed: ${error.message}`)
        }
        const { mono, sampleRate: sr } = await readWavMono(out)
        sampleRate = sr
        usedDevice = result.device ?? usedDevice
        chunks.push(mono)
        phraseInfo.push({
          index: index + 1,
          text: result.text ?? phrase.map((n) => n[3]).filter(Boolean).join(''),
          seconds: result.seconds ?? Number((mono.length / sr).toFixed(3)),
          notes: result.notes ?? phrase.length,
        })
      }
    } finally {
      await manager.stop().catch(() => {})
    }

    const totalFrames = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Float32Array(totalFrames)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
    const pcm = [merged]
    const durationSec = Number((totalFrames / sampleRate).toFixed(3))
    const peakDb = Number(toDb(peakOf(pcm)).toFixed(1))
    const rmsDb = Number(toDb(rmsOf(pcm)).toFixed(1))

    const target = join(scratchDir, `sing-${stamp}.wav`)
    await writeWavFile(target, pcm, sampleRate, 16)
    const trackName = (typeof args.trackName === 'string' && args.trackName.trim()) ? args.trackName.trim() : '演唱'
    const attached = await attachMaterialFile(workspaceRoot, projectId, target, {
      kind: 'sing',
      trackName,
      category: 'tts',
      snapshot: { text: phraseInfo.map((p) => p.text).join(''), device: usedDevice },
      snapshotKind: 'sing',
      tool: 'anyaudio_sing',
      label: (phraseInfo.map((p) => p.text).join('') || '演唱').slice(0, 24),
      startSec,
      autoStart: true,
      allowOverlap: false,
      peakDb,
      rmsDb,
      signal: exec?.signal,
    })
    const delivered = await deliverCopy(target, deliveryPath({
      workspaceRoot,
      outputDir: config.output?.dir,
      requested: args.output,
      stagedPath: target,
    }))
    const projectCopy = join(projectDir(workspaceRoot, projectId), attached.file)
    await rm(scratchDir, { recursive: true, force: true })

    return {
      ok: true,
      projectId,
      file: relativeToWorkspace(workspaceRoot, projectCopy),
      absolutePath: projectCopy,
      ...(delivered ? { delivered: relativeToWorkspace(workspaceRoot, delivered), deliveredAbsolutePath: delivered } : {}),
      attached,
      phrases: phraseInfo,
      durationSec,
      sampleRate,
      peakDb,
      rmsDb,
      device: usedDevice,
      voicebank,
      warnings: [],
    }
  },
})

export function registerSingTool(ctx) {
  ctx.tools.register(singToolDefinition)
}
