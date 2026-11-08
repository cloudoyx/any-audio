import { basename } from 'node:path'
import { planFonts, resolveConfiguredDefault } from '../audio/banks.js'
import { compileScore } from '../audio/score.js'
import { renderCompiled } from '../audio/synth.js'
import { readConfig } from '../config.js'
import { attachMaterialFile } from '../project/attach.js'
import { deliverCopy, deliveryPath, finalizeTool, nowStamp, readJsonParam, relativeToWorkspace, requireProjectId, seconds as clampSeconds, stagePath, textRenderer, workspaceRootOf, writeWavFile } from './shared.js'

function describeTracks(tracks) {
  return tracks
    .map((track) => {
      const source = track.source ? ` [source: ${track.source}]` : ''
      const level = Number.isFinite(track.rmsDb) ? `, ${track.rmsDb.toFixed(1)} dBFS RMS` : ''
      return `- ${track.name}: ${track.instrument}${track.drums ? ' (drum kit)' : ''}${source}, ${track.notes} notes, ${track.endSec.toFixed(2)}s${level}`
    })
    .join('\n')
}

export const musicToolDefinition = finalizeTool({
  name: 'anyaudio_music',
  description:
    'Render a note score to a WAV file with real SoundFont instruments (MIDI-style notes, per-track gain/pan/reverb, optional automation). ' +
    'The rendered music goes into a clip bay project: pass projectId, and it is added as material and placed on its own track (one track per score track when stems:true), so the person can open, hear and adjust it. ' +
    'Call it whenever you are making or editing a video that should have a soundtrack, and prefer it over hand-writing numpy synthesis: acoustic timbres, several instruments, humanised timing. ' +
    'Each track may name a "source" (font id from anyaudio_sources, a .sf2 path, or "auto" to pick the best-scored installed font for that instrument). ' +
    'Different tracks in one score may use different fonts; they are loaded into one synth and kept on non-overlapping bank offsets. ' +
    'Drum kits always come from the default font (the first loaded bank) — pass another kit as "font" if you need it. ' +
    'Score format (seconds on the video timeline): {title, tracks:[{name, instrument, source, gainDb, pan, reverb, drums, humanize:{timingMs,velocity}, notes:[[startSec, durSec, pitch|pitches, velocity]]}], automation:[{track, controller, points:[[sec,value]]}]}. ' +
    'Pitch accepts MIDI numbers or names (D3, F#4, Bb2); instruments accept GM names (piano, cello, strings, koto, shakuhachi, erhu, guzheng) or GM program numbers. ' +
    'Each track\'s gainDb is its real share of the music bus: the master is peak-normalised, which does not rebalance parts, so a melody at -3 dB against accompaniment at -16 dB will bury them. Positive values lift a track above the loudest one (the whole score is shifted instead of clipping). Render with analyze:true (or stems:true) to see per-track RMS and get a warning when a part sits more than 12 dB under the loudest one. ' +
    'Read the anyaudio-scoring skill for arrangement technique and mixing workflow.',
  parameters: {
    type: 'object',
    properties: {
      score: { oneOf: [{ type: 'object' }, { type: 'string' }], description: 'Score object as described above. A path to a .json file holding the same object is also accepted and is the better choice for long scores — keep the notes in a file and pass the path instead of inlining thousands of numbers.' },
      projectId: { type: 'string', description: 'The clip bay project this music belongs to. Required: run anyaudio_project mode:"create" first when the task has no project yet. The rendered music is added to the project as material and placed on its own track.' },
      trackName: { type: 'string', description: 'Name of the track to create for this music, default the score title. Ignored with stems:true, where each score track gets its own project track named after it.' },
      startSec: { type: 'number', description: 'Where the music starts on the project timeline, default 0.' },
      output: { type: 'string', description: "Optional extra copy of the rendered WAV at this path. Relative paths resolve against the user's project. The project's own copy is always written under the project folder." },
      font: { type: 'string', description: 'Default SoundFont path or id (.sf2/.sf3/.dls). Tracks without "source" use it; drum kits always come from it. Defaults to the installed font.' },
      sampleRate: { type: 'number', description: 'Sample rate, default 48000.' },
      durationSec: { type: 'number', description: 'Exact output length. Defaults to last note end + tailSec.' },
      tailSec: { type: 'number', description: 'Extra seconds after the last note for release and reverb, default 2.' },
      peakDb: { type: 'number', description: 'Normalisation peak in dBFS, default -3. Pass null to keep the raw level.' },
      stems: { type: 'boolean', description: 'Also write one WAV per track next to the mix. Stems keep the master\'s relative levels (they are not peak-normalised), so they can be inspected or re-balanced later.' },
      analyze: { type: 'boolean', description: 'Render every track separately only to report its peak/RMS level (no stem files). Use this to check the balance between melody and accompaniment.' },
      replace: { type: 'boolean', description: 'Replace instead of append. When this music is a second pass at a score the project already holds (you rebalanced the parts and are rendering again), pass true: the track family named after this score is cleared first, so the project keeps one set of stems rather than gaining a second. Without it a re-render appends, which is how a project ends up with "钟琴旋律" and "钟琴旋律 2" side by side.' },
    },
    required: ['score', 'projectId'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        delivered: { type: 'string' },
        deliveredAbsolutePath: { type: 'string' },
        projectId: { type: 'string' },
        attached: { type: 'array', items: { type: 'object', additionalProperties: true } },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        peakDb: { type: 'number' },
        rmsDb: { type: 'number' },
        font: { type: 'string' },
        fonts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        tracks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        stems: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: textRenderer((args, value) => {
      const fonts = value.fonts?.length ? value.fonts.map((font) => `${font.id}@+${font.offset} (${font.file})`).join(', ') : basename(value.font ?? '')
      const lines = [
        `Rendered ${value.durationSec.toFixed(2)}s @ ${value.sampleRate} Hz → ${value.file}`,
        `peak ${value.peakDb.toFixed(1)} dBFS, RMS ${value.rmsDb.toFixed(1)} dBFS`,
        `Fonts: ${fonts}`,
        'Tracks:',
        describeTracks(value.tracks ?? []),
      ]
      if (value.stems?.length) lines.push(`Stems (relative levels kept): ${value.stems.join(', ')}`)
      if (value.warnings?.length) lines.push(`Warnings:\n${value.warnings.map((warning) => `- ${warning}`).join('\n')}`)
      const placed = value.attached ?? []
      lines.push(placed.length
        ? `In project ${value.projectId}: ${placed.map((entry) => `${entry.clipId} "${entry.trackName}" @ ${Number(entry.startSec).toFixed(2)}s`).join(', ')}`
        : `In project ${value.projectId}.`)
      if (value.delivered) lines.push(`Delivered copy: ${value.delivered}`)
      lines.push('Next: the project holds this music now — add narration and effects with their own projectId, then render the project for the finished file.')
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const projectId = requireProjectId(args, 'anyaudio_music')
    const { config } = await readConfig()
    const score = await readJsonParam(args.score, 'score', { workspaceRoot })
    const sampleRate = Math.round(clampSeconds(args.sampleRate ?? config.music.sampleRate, config.music.sampleRate)) || config.music.sampleRate
    const compiled = compileScore(score, { sampleRate })
    const tailSec = clampSeconds(args.tailSec ?? config.music.tailSec, config.music.tailSec)
    const durationSec = clampSeconds(args.durationSec, compiled.durationSec + tailSec)
    const explicitFont = typeof args.font === 'string' && args.font.trim() ? args.font.trim() : ''
    let fontPath = explicitFont || undefined
    let defaultNote = null
    if (!explicitFont && config.music.font) {
      // A saved default whose file is gone must not break every render: fall
      // back to the installed default and say so.
      const resolved = await resolveConfiguredDefault(config.music.font, { workspaceRoot })
      fontPath = resolved.path
      if (resolved.stale) {
        defaultNote = `the saved default sound source "${resolved.configured}" is no longer installed; used ${basename(resolved.path)} instead — pick another default with anyaudio_sources action "use"`
      }
    }
    const plan = await planFonts(compiled, { workspaceRoot, fontPath })
    const peakSetting = args.peakDb === undefined ? config.music.peakDb : args.peakDb
    const peakDb = peakSetting === null ? undefined : Number(peakSetting)
    const normalize = peakSetting !== null

    // Render into `.anyaudio/out/` first: this file is not the deliverable, it is
    // the material that is about to join the project. `output` only says where a
    // delivered copy goes once the project owns the material (I-10).
    const target = stagePath(workspaceRoot, `score-${nowStamp()}.wav`)
    const rendered = await renderCompiled(compiled, { banks: plan.banks, layout: plan.layout, sampleRate, durationSec, peakDb, normalize })
    const written = await writeWavFile(target, rendered.channels, sampleRate)
    // Replace or append, decided before anything is written.
    //
    // Re-rendering a score to fix its balance is the ordinary case, and it used
    // to append: `freeTrack` found the family busy on the same span, opened
    // `钟琴旋律 2`, and the project gained a second set of stems beside the
    // first. Eight tracks where four were meant, from one rebalance. `replace`
    // is the intended path; without it the append still happens (a person may
    // genuinely want a second take side by side) but the reply says so.
    const wantedNames = args.stems === true
      ? compiled.tracks.map((entry) => entry.name)
      : [args.trackName || String(score.title ?? '').trim() || '音乐']
    const layoutNotes = []
    {
      const { readProject, saveProject } = await import('../project/store.js')
      const { trackFamily, removeTrackFamily } = await import('../project/attach.js')
      const project = await readProject(workspaceRoot, projectId)
      const occupied = wantedNames.filter((name) => trackFamily(project, name).length > 0)
      if (occupied.length > 0 && args.replace === true) {
        const removed = []
        for (const name of occupied) removed.push(...removeTrackFamily(project, name))
        await saveProject(workspaceRoot, project, { by: 'agent', note: `替换配乐：移除旧轨道 ${removed.join('、')}` })
        layoutNotes.push(`replace: removed the previous ${removed.length} track(s) — ${removed.join('、')} — before adding this render.`)
      } else if (occupied.length > 0) {
        layoutNotes.push(
          `this project already had ${occupied.join('、')}; this call APPENDED a second copy, so the timeline now holds both. `
          + 'If this render was meant to replace the old one, remove the old tracks (anyaudio_project mode:"update", target:"track", field:"delete") '
          + 'or pass replace:true next time.',
        )
      }
    }

    const stems = []
    const stemFiles = []
    const levels = new Map()
    if (args.stems === true || args.analyze === true) {
      const base = target.replace(/\.wav$/i, '')
      for (const track of compiled.tracks) {
        const stem = await renderCompiled(compiled, { banks: plan.banks, layout: plan.layout, sampleRate, durationSec, normalize: false, onlyTrack: track.name })
        // Apply the master's normalisation gain to every stem equally: the parts
        // keep their authored balance and still sum back to the master.
        const gain = Number.isFinite(rendered.appliedGain) ? rendered.appliedGain : 1
        const channels = gain === 1 ? stem.channels : stem.channels.map((channel) => channel.map((sample) => sample * gain))
        levels.set(track.name, { peakDb: stem.peakDb + 20 * Math.log10(gain || 1), rmsDb: stem.rmsDb + 20 * Math.log10(gain || 1) })
        if (args.stems === true) {
          const stemPath = `${base}-${track.name.replace(/[^\w.-]+/g, '_')}.wav`
          await writeWavFile(stemPath, channels, sampleRate)
          stems.push(relativeToWorkspace(workspaceRoot, stemPath))
          const attached = await attachMaterialFile(workspaceRoot, projectId, stemPath, {
            kind: 'music-stem',
            trackName: track.name,
            category: 'music',
            snapshot: score,
            snapshotKind: 'score',
            tool: 'anyaudio_music',
            label: track.name,
            exec,
          })
          stemFiles.push(attached)
        }
      }
    }

    // A score with stems goes into the project stem by stem (spec §5.3), so a
    // person can rebalance the instruments. A plain render is one track.
    const attached = args.stems === true
      ? stemFiles
      : [await attachMaterialFile(workspaceRoot, projectId, written.path, {
        kind: 'music',
        trackName: args.trackName || String(score.title ?? '').trim() || '音乐',
        category: 'music',
        snapshot: score,
        snapshotKind: 'score',
        tool: 'anyaudio_music',
        label: String(score.title ?? '').trim() || '音乐',
        startSec: args.startSec,
        exec,
      })]

    const delivered = await deliverCopy(written.path, deliveryPath({
      workspaceRoot,
      outputDir: config.output.dir,
      requested: args.output,
      stagedPath: written.path,
    }))

    const tracks = compiled.tracks.map((track) => {
      const assignment = plan.layout.get(track.name)
      const level = levels.get(track.name)
      return {
        name: track.name,
        instrument: track.instrument,
        program: assignment?.program ?? track.program,
        source: assignment?.source,
        gainDb: track.gainDb,
        notes: track.notes.length,
        endSec: Number(track.endSec.toFixed(2)),
        ...(level ? { peakDb: Number(level.peakDb.toFixed(2)), rmsDb: Number(level.rmsDb.toFixed(2)) } : {}),
      }
    })
    const warnings = [...compiled.warnings, ...plan.warnings, ...layoutNotes]
    if (defaultNote) warnings.push(defaultNote)
    if (args.durationSec !== undefined && compiled.durationSec > durationSec + 0.001) {
      warnings.push(`score runs to ${compiled.durationSec.toFixed(2)}s but durationSec is ${durationSec.toFixed(2)}s — notes past the end are cut; add tail or end the music earlier`)
    }
    if (rendered.brokenSamples > 0) warnings.push(`${rendered.brokenSamples} non-finite samples were zeroed`)
    const leveled = [...levels.entries()].filter(([trackName]) => {
      const track = compiled.tracks.find((candidate) => candidate.name === trackName)
      return track && track.notes.length > 0
    })
    if (leveled.length > 1) {
      const loudest = Math.max(...leveled.map(([, level]) => level.rmsDb))
      for (const [trackName, level] of leveled) {
        const drop = loudest - level.rmsDb
        if (drop > 12) {
          warnings.push(`track "${trackName}" sits ${drop.toFixed(1)} dB below the loudest track — per-track gainDb is the balance knob (master normalisation does not rebalance); check whether the melody is drowning this part`)
        }
      }
    }

    return {
      ok: true,
      projectId,
      file: relativeToWorkspace(workspaceRoot, written.path),
      absolutePath: written.path,
      ...(delivered ? { delivered: relativeToWorkspace(workspaceRoot, delivered), deliveredAbsolutePath: delivered } : {}),
      bytes: written.bytes,
      durationSec: Number(rendered.durationSec.toFixed(3)),
      sampleRate,
      peakDb: Number(rendered.peakDb.toFixed(2)),
      rmsDb: Number(rendered.rmsDb.toFixed(2)),
      font: plan.banks[0]?.path,
      fonts: plan.fonts,
      tracks,
      stems,
      stemsNormalized: false,
      attached,
      warnings,
    }
  },
})

export function registerMusicTool(ctx) {
  ctx.tools.register(musicToolDefinition)
}
