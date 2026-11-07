#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileScore, parsePitch } from '../src/audio/score.js'
import { encodeWav, parseWav, peakOf, rmsOf, toDb } from '../src/audio/wav.js'
import { synthesizeSfx } from '../src/audio/sfx.js'
import { buildDuckCurve, buildEnvelope } from '../src/audio/mix.js'
import { planOffset, pickProgram } from '../src/audio/banks.js'
import { categoryOfProgram, fontScore, rankFonts } from '../src/audio/scoring.js'
import { registerAllTools } from '../src/tools/index.js'
import { findFfmpeg, runFfmpeg } from '../src/tools/shared.js'

const repoRoot = resolve('.')
const anyaudioDir = join(repoRoot, '.anyaudio')
const hadAnyAudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp')
// Generating tools stage their output in `.anyaudio/out` and put material into
// `.anyaudio/projects` (improvement 01 / I-10), both outside `test-tmp`. Record
// what was already there so the run can put the tree back exactly as it found
// it instead of leaving dozens of scratch projects behind.
const outDirPath = join(anyaudioDir, 'out')
const projectsDirPath = join(anyaudioDir, 'projects')
async function listing(path) {
  return new Set(await readdir(path).catch(() => []))
}
const preexistingOut = await listing(outDirPath)
const preexistingProjects = await listing(projectsDirPath)
// The font bookkeeping lives in a machine-wide state file, and the config file
// sits next to it by default: point both at the scratch folder before anything
// reads them, or a test that deletes a font would rewrite the user's own state.
const realStatePath = join(homedir(), '.dsh', 'anyaudio', 'state.json')
async function snapshot(path) {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, content: await readFile(path, 'utf8') }
  } catch {
    return null
  }
}
const realStateBefore = await snapshot(realStatePath)
process.env.ANYAUDIO_STATE = join(tmpDir, 'state.json')
process.env.ANYAUDIO_CONFIG = join(tmpDir, 'config.json')
const exec = { agent: { workspaceRoot: repoRoot } }
const tools = new Map()
registerAllTools({
  tools: { register: (definition) => tools.set(definition.name, definition) },
  logger: { info: () => {} },
  get: () => undefined,
})
const { createProject, readProject } = await import('../src/project/store.js')

// Improvement 01 / I-10: the three generating tools refuse to run without a
// project, because audio a person cannot adjust is the failure this suite is
// guarding against. Each call gets a fresh project, so the 20-track limit never
// leaks between tests.
let attachProjectSeq = 0
async function freshAttach() {
  attachProjectSeq++
  const project = await createProject(repoRoot, { name: `verify-attach-${attachProjectSeq}` })
  return project.id
}

let passed = 0
let failed = 0

async function test(name, run) {
  try {
    await run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function near(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} ±${tolerance}, got ${actual}`)
}

// The host validates every tool result against the declared output schema and
// throws away the whole value when it does not match (ToolOutputError), so a
// schema that disagrees with the real return type silently breaks a tool for
// every caller. Mirror the host's subset here and check real returns.
function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function schemaProblems(schema, value, path = 'value') {
  const problems = []
  if (!schema || typeof schema !== 'object') return problems
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((option) => schemaProblems(option, value, path).length === 0)) {
      problems.push(`${path} matches none of anyOf`)
    }
    return problems
  }
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    const ok = allowed.some((type) => type === actual || (type === 'integer' && Number.isInteger(value)) || (type === 'number' && actual === 'number'))
    if (!ok) return [`"${path}" must be a ${allowed.join('/')}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`${path} is not one of the enum`)
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => problems.push(...schemaProblems(schema.items, item, `${path}[${index}]`)))
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`"${path}.${key}" is required`)
    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!(key in value)) continue
        problems.push(...schemaProblems(child, value[key], `${path}.${key}`))
      }
    }
  }
  return problems
}

function assertMatchesOutputSchema(definition, value) {
  const problems = schemaProblems(definition.output?.schema, value)
  assert(problems.length === 0, `${definition.name} output violates its own schema: ${problems.join('; ')}`)
}

function windowRms(channels, sampleRate, startSec, endSec) {
  const start = Math.floor(startSec * sampleRate)
  const end = Math.min(channels[0].length, Math.floor(endSec * sampleRate))
  let sum = 0
  for (let i = start; i < end; i++) sum += channels[0][i] * channels[0][i] + channels[1][i] * channels[1][i]
  return Math.sqrt(sum / Math.max(1, (end - start) * 2))
}

async function writeWav(path, channels, sampleRate = 48000) {
  await writeFile(path, encodeWav({ sampleRate, channels, bitDepth: 16 }))
  return path
}

function tone(seconds, sampleRate, { from = 0, to = seconds, frequency = 220, amplitude = 0.4 } = {}) {
  const frames = Math.ceil(seconds * sampleRate)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = Math.floor(from * sampleRate); i < Math.min(frames, Math.floor(to * sampleRate)); i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude
    left[i] = value
    right[i] = value * 0.96
  }
  return [left, right]
}

await mkdir(tmpDir, { recursive: true })

await test('WAV 16-bit roundtrip keeps rate, channels and length', async () => {
  const sampleRate = 44100
  const frames = 22050
  const sine = new Float32Array(frames)
  for (let i = 0; i < frames; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5
  const parsed = parseWav(encodeWav({ sampleRate, channels: [sine, sine], bitDepth: 16 }))
  assert(parsed.sampleRate === sampleRate, 'sample rate changed')
  assert(parsed.channels.length === 2, 'channel count changed')
  near(parsed.durationSec, 0.5, 0.001, 'duration')
  near(peakOf(parsed.channels), 0.5, 0.01, 'peak')
})

await test('WAV float32 roundtrip keeps precision', async () => {
  const left = Float32Array.from([0.1, -0.25, 0.75, 0])
  const parsed = parseWav(encodeWav({ sampleRate: 48000, channels: [left, left], bitDepth: 32 }))
  for (let i = 0; i < left.length; i++) near(parsed.channels[0][i], left[i], 1e-6, `sample ${i}`)
})

await test('parsePitch understands names and MIDI numbers', async () => {
  assert(parsePitch('A4') === 69, 'A4 should be 69')
  assert(parsePitch('D3') === 50, 'D3 should be 50')
  assert(parsePitch('F#4') === 66, 'F#4 should be 66')
  assert(parsePitch('Bb2') === 46, 'Bb2 should be 46')
  assert(parsePitch(60) === 60, 'MIDI 60')
  let threw = false
  try {
    parsePitch('H2')
  } catch {
    threw = true
  }
  assert(threw, 'invalid pitch name should throw')
})

await test('compileScore builds timed events, chords, humanise and automation', async () => {
  const compiled = compileScore(
    {
      tracks: [
        {
          name: 'lead',
          instrument: 'koto',
          humanize: { timingMs: 6, velocity: 4, seed: 3 },
          notes: [
            [0, 1, 'D4', 80],
            [1, 2, ['D3', 'A3'], 90],
            { t: 2.5, d: 1, p: 'F#4', v: 110 },
          ],
        },
      ],
      automation: [{ track: 'lead', controller: 'volume', points: [[0, 100], [4, 40]] }],
    },
    { sampleRate: 48000 },
  )
  assert(compiled.tracks.length === 1, 'one track')
  const on = compiled.tracks[0].events.filter((event) => event.type === 'on')
  const off = compiled.tracks[0].events.filter((event) => event.type === 'off')
  assert(on.length === 4, `expected 4 note-ons (3 notes + 1 chord extra), got ${on.length}`)
  assert(off.length === 4, `expected 4 note-offs, got ${off.length}`)
  const ccs = compiled.tracks[0].events.filter((event) => event.type === 'cc' && event.controller === 7)
  assert(ccs.length >= 40, `automation should interpolate volume CC7 points, got ${ccs.length}`)
  assert(compiled.tracks[0].endSec >= 3.48, `track end should cover the last note (got ${compiled.tracks[0].endSec.toFixed(3)})`)
})

await test('compileScore rejects impossible pitches with a clear message', async () => {
  let message = ''
  try {
    compileScore({ tracks: [{ name: 'x', instrument: 'koto', notes: [[0, 1, 'C99']] }] })
  } catch (error) {
    message = error.message
  }
  assert(message.includes('pitch'), `error should mention pitch, got "${message}"`)
})

await test('drum tracks accept drum-kit names as pitches', async () => {
  const compiled = compileScore({
    tracks: [{ name: 'perc', instrument: 'drums', drums: true, notes: [[0, 0.2, 'kick'], [0.5, 0.2, 'taiko'], [1, 0.2, 'gong']] }],
  })
  const pitches = compiled.tracks[0].notes.map((note) => note.midi)
  assert(pitches.length === 3, `expected 3 drum notes, got ${pitches.length}`)
  assert(pitches[0] === 36 && pitches[1] === 41 && pitches[2] === 52, `unexpected drum pitches ${pitches.join(',')}`)
})

const font = (await tools.get('anyaudio_sources').execute({ action: 'list' }, exec)).fonts[0]
assert(font, 'a SoundFont must be installed for the engine tests (run node scripts/fetch-font.mjs)')

await test('per-track gainDb is the real relative level of each track', async () => {
  const levels = async (gains) => {
    const result = await tools.get('anyaudio_music').execute(
      {
        projectId: await freshAttach(),
        score: {
          tracks: gains.map((gainDb, index) => ({
            name: `t${index}`,
            instrument: 'strings',
            gainDb,
            reverb: 0,
            notes: [[0.2, 0.8, 'C4', 100], [0.2, 0.9, 'G4', 100]],
          })),
        },
        durationSec: 1.5,
        peakDb: null,
        analyze: true,
        output: `.anyaudio/test-tmp/gain-${gains.join('_').replace(/-/g, 'm')}.wav`,
      },
      exec,
    )
    const loudest = Math.max(...result.tracks.map((track) => track.rmsDb))
    return result.tracks.map((track) => track.rmsDb - loudest)
  }
  const pair = await levels([0, -6])
  near(pair[1], -6, 0.6, 'gainDb 0 vs -6 should be 6 dB apart')
  const positive = await levels([3, -2])
  near(positive[1], -5, 0.6, 'gainDb +3 vs -2 should be 5 dB apart')
  assert(positive[0] > -0.1, `the loudest track must sit at the top of the range, got ${positive[0].toFixed(2)}`)
  const single = await levels([0])
  near(single[0], 0, 0.001, 'a single track is the reference')
  const three = await levels([0, -3, -16])
  near(three[1], -3, 0.6, 'second track of [0,-3,-16]')
  near(three[2], -16, 0.8, 'third track of [0,-3,-16]')
})

await test('a narration-only mix does not crash and skips pointless ducking', async () => {
  const sampleRate = 48000
  const narrationPath = await writeWav(join(tmpDir, 'solo-narration.wav'), tone(3, sampleRate, { amplitude: 0.4 }), sampleRate)
  const result = await tools.get('anyaudio_mix').execute(
    { tracks: [{ role: 'narration', path: narrationPath }], durationSec: 3, output: '.anyaudio/test-tmp/solo-narration-mix.wav' },
    exec,
  )
  assert(result.ok === true, 'a narration-only mix must succeed')
  assert(result.ducking.enabled === false, 'ducking must be skipped when there is no bed')
  assert(result.warnings.some((warning) => /ducking skipped/i.test(warning)), `expected a ducking-skipped warning, got ${JSON.stringify(result.warnings)}`)
  const wav = parseWav(await readFile(result.absolutePath))
  near(wav.durationSec, 3, 0.01, 'narration-only length')
  assert(peakOf(wav.channels) > 0.01, 'the narration must still be audible')
})


await test('the font library is one shared directory, not per project', async () => {
  const { fontSearchDirs, userFontDir, listFonts } = await import('../src/audio/fonts.js')
  const dirs = fontSearchDirs()
  assert(dirs.includes(userFontDir()), 'the shared library must be searched')
  assert(dirs.every((dir) => !dir.includes('.anyaudio')), `no project-level font folder may be scanned, got ${dirs.join(' | ')}`)
  const first = await listFonts()
  const second = await listFonts()
  assert(JSON.stringify(first.map((entry) => entry.path)) === JSON.stringify(second.map((entry) => entry.path)), 'listing must not depend on the caller')
})

await test('deleting a font cannot escape the shared library', async () => {
  const { deleteFont } = await import('../src/audio/font-state.js')
  const libraryDir = join(tmpDir, 'font-library')
  const outsideDir = join(tmpDir, 'font-outside')
  await mkdir(libraryDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  const inside = join(libraryDir, 'allowed.sf2')
  const outside = join(outsideDir, 'secret.sf2')
  await writeFile(inside, 'allowed')
  await writeFile(outside, 'secret')

  const ok = await deleteFont(inside, { dirs: [libraryDir] })
  assert(ok.deleted.toLowerCase().endsWith('allowed.sf2'), `a file inside the library must be deletable, got ${JSON.stringify(ok)}`)

  await writeFile(join(outsideDir, 'dd.sf2'), 'secret')
  let message = ''
  try {
    await deleteFont(join(libraryDir, '..', 'font-outside', 'dd.sf2'), { dirs: [libraryDir] })
  } catch (error) {
    message = error.message
  }
  assert(/refusing/i.test(message), `".." must be refused, got "${message}"`)
  assert(existsSync(join(outsideDir, 'dd.sf2')), 'a refused ".." path must not delete anything')

  // A junction (the Windows equivalent of a symlink that needs no admin) that
  // points outside the library must be refused as well.
  const link = join(libraryDir, 'escape')
  let linked = true
  try {
    await symlink(outsideDir, link, 'junction')
  } catch {
    linked = false
  }
  if (linked) {
    let linkMessage = ''
    try {
      await deleteFont(join(link, 'dd.sf2'), { dirs: [libraryDir] })
    } catch (error) {
      linkMessage = error.message
    }
    assert(/refusing/i.test(linkMessage), `a link pointing outside must be refused, got "${linkMessage}"`)
    assert(existsSync(join(outsideDir, 'dd.sf2')), 'a refused link must not delete anything')
  }
})

await test('sources action "use" really persists the default bank', async () => {
  const { readConfig } = await import('../src/config.js')
  const general = (await tools.get('anyaudio_sources').execute({ action: 'list' }, exec)).fonts.find((entry) => entry.id === 'generaluser') ?? font
  const previous = process.env.ANYAUDIO_CONFIG
  const configPath = join(tmpDir, 'use-config.json')
  process.env.ANYAUDIO_CONFIG = configPath
  try {
    const before = (await readConfig()).config.music.font
    const used = await tools.get('anyaudio_sources').execute({ action: 'use', font: general.name }, exec)
    assert(used.ok === true, 'use must succeed')
    const after = (await readConfig()).config.music.font
    assert(after && after !== before, `config.music.font must change, was "${before}", now "${after}"`)
    const rendered = await tools.get('anyaudio_music').execute(
      { projectId: await freshAttach(), score: { tracks: [{ name: 'a', instrument: 'strings', notes: [[0, 0.6, 'C4', 90]] }] }, durationSec: 1, output: '.anyaudio/test-tmp/use-default.wav' },
      exec,
    )
    assert(rendered.font && rendered.font.toLowerCase().endsWith(general.name.toLowerCase()), `the render must use the new default, got ${rendered.font}`)
  } finally {
    if (previous === undefined) delete process.env.ANYAUDIO_CONFIG
    else process.env.ANYAUDIO_CONFIG = previous
  }
})

await test('render produces audio with the requested exact duration', async () => {
  const result = await tools.get('anyaudio_music').execute(
    {
      projectId: await freshAttach(),
      score: { tracks: [{ name: 'lead', instrument: 'koto', notes: [[0, 1, 'D4', 80], [1, 1, 'A4', 90]] }] },
      durationSec: 2,
      output: '.anyaudio/test-tmp/render-exact.wav',
    },
    exec,
  )
  near(result.durationSec, 2, 0.001, 'duration')
  const wav = parseWav(await readFile(result.absolutePath))
  near(wav.durationSec, 2, 0.001, 'file duration')
  assert(wav.channels.length === 2, 'stereo output')
  assert(result.peakDb <= -2.9 && result.peakDb >= -3.1, `peak should be normalised to -3 dBFS, got ${result.peakDb}`)
})

await test('different instruments produce audibly different spectra', async () => {
  const render = async (instrument, file) => {
    const result = await tools.get('anyaudio_music').execute(
      { projectId: await freshAttach(), score: { tracks: [{ name: 'a', instrument, notes: [[0, 1.2, 'D4', 90]] }] }, durationSec: 1.5, output: file },
      exec,
    )
    return parseWav(await readFile(result.absolutePath))
  }
  const koto = await render('koto', '.anyaudio/test-tmp/koto.wav')
  const cello = await render('cello', '.anyaudio/test-tmp/cello.wav')
  const kotoRms = rmsOf(koto.channels)
  const celloRms = rmsOf(cello.channels)
  assert(kotoRms > 0.001 && celloRms > 0.001, 'both instruments must produce sound')
  let difference = 0
  let energy = 0
  for (let i = 0; i < koto.channels[0].length; i += 7) {
    difference += Math.abs(koto.channels[0][i] - cello.channels[0][i])
    energy += Math.abs(koto.channels[0][i])
  }
  assert(difference / energy > 0.2, `koto and cello should differ (relative difference ${(difference / energy).toFixed(2)})`)
})

await test('velocity controls loudness (dynamic response)', async () => {
  const render = async (velocity, file) => {
    const result = await tools.get('anyaudio_music').execute(
      { projectId: await freshAttach(), score: { tracks: [{ name: 'a', instrument: 'piano', notes: [[0, 1, 'C4', velocity]] }] }, durationSec: 1.2, peakDb: null, output: file },
      exec,
    )
    return parseWav(await readFile(result.absolutePath))
  }
  const soft = await render(30, '.anyaudio/test-tmp/vel-soft.wav')
  const loud = await render(120, '.anyaudio/test-tmp/vel-loud.wav')
  const ratio = toDb(rmsOf(loud.channels) / Math.max(1e-9, rmsOf(soft.channels)))
  assert(ratio > 8, `velocity 120 should be much louder than 30, measured ${ratio.toFixed(1)} dB`)
})

await test('sfx renderer is deterministic', async () => {
  const a = synthesizeSfx({ type: 'wind', durationSec: 1.5, sampleRate: 48000, params: { intensity: 0.6 }, seed: 42 })
  const b = synthesizeSfx({ type: 'wind', durationSec: 1.5, sampleRate: 48000, params: { intensity: 0.6 }, seed: 42 })
  assert(a[0].length === b[0].length && a[0].length === 72000, 'expected 1.5s at 48kHz')
  let maxDiff = 0
  for (let i = 0; i < a[0].length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[0][i] - b[0][i]))
  assert(maxDiff === 0, `same seed must give identical audio, max difference ${maxDiff}`)
  // A different seed has to give different audio, or "deterministic" would also
  // be satisfied by a generator that ignores its seed entirely.
  const c = synthesizeSfx({ type: 'wind', durationSec: 1.5, sampleRate: 48000, params: { intensity: 0.6 }, seed: 43 })
  let different = 0
  for (let i = 0; i < a[0].length; i += 97) different = Math.max(different, Math.abs(a[0][i] - c[0][i]))
  assert(different > 1e-6, 'a different seed must give different audio')
})

await test('ducking lowers the music bed while narration is present', async () => {
  const sampleRate = 48000
  const music = tone(6, sampleRate, { amplitude: 0.18 })
  const narration = tone(6, sampleRate, { from: 2, to: 3.5, frequency: 300, amplitude: 0.5 })
  const musicPath = await writeWav(join(tmpDir, 'duck-music.wav'), music, sampleRate)
  const narrationPath = await writeWav(join(tmpDir, 'duck-narration.wav'), narration, sampleRate)
  const result = await tools.get('anyaudio_mix').execute(
    {
      tracks: [
        { role: 'music', path: musicPath, gainDb: 0 },
        { role: 'narration', path: narrationPath, gainDb: 0 },
      ],
      durationSec: 6,
      masterPeakDb: null,
      output: '.anyaudio/test-tmp/duck-mix.wav',
    },
    exec,
  )
  assert(result.ducking.enabled, 'ducking should be active')
  assert(result.ducking.measuredDropDb < -3, `music should drop at least 3 dB under narration, measured ${result.ducking.measuredDropDb} dB`)
  const wav = parseWav(await readFile(result.absolutePath))
  near(wav.durationSec, 6, 0.001, 'mixed length')
  const before = windowRms(wav.channels, sampleRate, 0.2, 1.8)
  const during = windowRms(wav.channels, sampleRate, 2.2, 3.3)
  assert(during > before * 1.4, `narration window should be louder overall (before ${before.toFixed(3)}, during ${during.toFixed(3)})`)
})

await test('duck curve follows the narration envelope with slow attack/release', async () => {
  const sampleRate = 48000
  const frames = sampleRate * 2
  const env = new Float32Array(frames)
  for (let i = sampleRate * 0.5; i < sampleRate; i++) env[i] = 0.5
  const curve = buildDuckCurve(env, sampleRate, { targetDb: -12, thresholdDb: -42, attackSec: 0.1, releaseSec: 0.3 })
  assert(curve[0] > 0.99, 'curve should start at unity')
  assert(curve[sampleRate] < 0.45, `curve should be ducked by the end of the speech (got ${curve[sampleRate].toFixed(2)})`)
  assert(curve[curve.length - 1] > 0.9, 'curve should recover after speech ends')
  const slow = buildEnvelope(tone(1, sampleRate, { amplitude: 0.5 }), sampleRate)
  assert(slow[slow.length - 1] > 0.1, 'envelope should track a sustained tone')
})

await test('fades silence the head and tail of the mix', async () => {
  const sampleRate = 48000
  const music = tone(3, sampleRate, { amplitude: 0.3 })
  const path = await writeWav(join(tmpDir, 'fade-source.wav'), music, sampleRate)
  const result = await tools.get('anyaudio_mix').execute(
    { tracks: [{ role: 'music', path, gainDb: 0, fadeInSec: 1, fadeOutSec: 1 }], durationSec: 3, masterPeakDb: null, output: '.anyaudio/test-tmp/fade-mix.wav' },
    exec,
  )
  const wav = parseWav(await readFile(result.absolutePath))
  const head = windowRms(wav.channels, sampleRate, 0, 0.05)
  const middle = windowRms(wav.channels, sampleRate, 1.4, 1.6)
  const tail = windowRms(wav.channels, sampleRate, 2.95, 3)
  assert(head < middle * 0.15, `head should be faded (head ${head.toFixed(4)} vs middle ${middle.toFixed(4)})`)
  assert(tail < middle * 0.15, `tail should be faded (tail ${tail.toFixed(4)} vs middle ${middle.toFixed(4)})`)
})

await test('a failed mux fails the whole mix instead of reporting success', async () => {
  const sampleRate = 48000
  const path = await writeWav(join(tmpDir, 'mux-source.wav'), tone(2, sampleRate, { amplitude: 0.2 }), sampleRate)
  await writeFile(join(tmpDir, 'fake.mp4'), Buffer.from('not a real video'))
  const result = await tools.get('anyaudio_mix').execute(
    {
      tracks: [{ role: 'music', path, gainDb: 0 }],
      durationSec: 2,
      video: join(tmpDir, 'fake.mp4'),
      videoOutput: '.anyaudio/test-tmp/mux-out.mp4',
      output: '.anyaudio/test-tmp/mux.wav',
    },
    exec,
  )
  assert(result.mux && result.mux.ok === false, 'mux should report failure')
  assert(result.ok === false, 'the structured result must not claim success when the video could not be written')
  assert(typeof result.mux.error === 'string' && result.mux.error.length > 0, 'the mux error must be explained')
})

await test('muxing keeps the video length when the audio is shorter or longer', async () => {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) return
  const sampleRate = 48000
  const videoPath = join(tmpDir, 'five-seconds.mp4')
  await runFfmpeg(ffmpeg.command, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=5', '-pix_fmt', 'yuv420p', videoPath])
  const short = await writeWav(join(tmpDir, 'short.wav'), tone(2, sampleRate, { amplitude: 0.2 }), sampleRate)
  const nearlyEqual = await writeWav(join(tmpDir, 'near.wav'), tone(4.8, sampleRate, { amplitude: 0.2 }), sampleRate)
  const long = await writeWav(join(tmpDir, 'long.wav'), tone(8, sampleRate, { amplitude: 0.2 }), sampleRate)

  const nearly = await tools.get('anyaudio_mix').execute(
    { tracks: [{ role: 'music', path: nearlyEqual }], durationSec: 4.8, video: videoPath, videoOutput: '.anyaudio/test-tmp/mux-near.mp4', output: '.anyaudio/test-tmp/mux-near.wav' },
    exec,
  )
  assert(nearly.ok === true, `near-length mux failed: ${nearly.mux?.error ?? ''}`)
  near(nearly.mux.durationSec, 5, 0.15, 'a 4.8s mix into a 5s video must still be 5s')

  const shorter = await tools.get('anyaudio_mix').execute(
    { tracks: [{ role: 'music', path: short }], durationSec: 2, video: videoPath, videoOutput: '.anyaudio/test-tmp/mux-short.mp4', output: '.anyaudio/test-tmp/mux-short.wav' },
    exec,
  )
  assert(shorter.ok === true, `short audio mux failed: ${shorter.mux?.error ?? ''}`)
  near(shorter.mux.durationSec, 5, 0.15, 'a 2s mix into a 5s video must keep 5s of picture')

  const longer = await tools.get('anyaudio_mix').execute(
    { tracks: [{ role: 'music', path: long }], durationSec: 8, video: videoPath, videoOutput: '.anyaudio/test-tmp/mux-long.mp4', output: '.anyaudio/test-tmp/mux-long.wav' },
    exec,
  )
  assert(longer.ok === true, `long audio mux failed: ${longer.mux?.error ?? ''}`)
  near(longer.mux.durationSec, 5, 0.15, 'an 8s mix into a 5s video must be cut at the picture end')
})

await test('tool definitions are complete and discoverable', async () => {
  assert(tools.size === 6, `expected 6 tools, got ${tools.size}: ${[...tools.keys()].join(', ')}`)
  for (const definition of tools.values()) {
    assert(typeof definition.name === 'string' && definition.name.startsWith('anyaudio_'), `bad tool name ${definition.name}`)
    assert(definition.description.length > 80, `${definition.name} needs a descriptive description`)
    assert(definition.parameters && definition.parameters.type === 'object', `${definition.name} needs object parameters`)
    assert(typeof definition.output?.render === 'function', `${definition.name} needs output.render`)
    assert(definition.output?.schema?.type === 'object', `${definition.name} needs an object output schema`)
  }
})

await test('every tool return value matches its declared output schema', async () => {
  // Regression: `defaultSource: config.music.font || null` shipped a null where
  // the schema promised a string, and the host threw the whole list result away.
  const emptyConfigPath = join(tmpDir, 'schema-config.json')
  const previous = process.env.ANYAUDIO_CONFIG
  process.env.ANYAUDIO_CONFIG = emptyConfigPath
  try {
    const listed = await tools.get('anyaudio_sources').execute({ action: 'list' }, exec)
    assertMatchesOutputSchema(tools.get('anyaudio_sources'), listed)
    assert(!('defaultSource' in listed), 'an unset default source must be omitted, not null')
    const used = await tools.get('anyaudio_sources').execute({ action: 'use', font: 'generaluser' }, exec)
    assertMatchesOutputSchema(tools.get('anyaudio_sources'), used)
    const relisted = await tools.get('anyaudio_sources').execute({ action: 'list' }, exec)
    assertMatchesOutputSchema(tools.get('anyaudio_sources'), relisted)
    assert(typeof relisted.defaultSource === 'string' && relisted.defaultSource.length > 0, 'a saved default should come back as a string')
  } finally {
    if (previous === undefined) delete process.env.ANYAUDIO_CONFIG
    else process.env.ANYAUDIO_CONFIG = previous
  }

  assertMatchesOutputSchema(tools.get('anyaudio_sources'), await tools.get('anyaudio_sources').execute({ action: 'instruments' }, exec))
  assertMatchesOutputSchema(tools.get('anyaudio_sources'), await tools.get('anyaudio_sources').execute({ action: 'kinds' }, exec))
  assertMatchesOutputSchema(tools.get('anyaudio_sources'), await tools.get('anyaudio_sources').execute({ action: 'presets', query: 'koto', limit: 5 }, exec))

  const scorePath = join(tmpDir, 'schema-score.json')
  await writeFile(scorePath, JSON.stringify({ tracks: [{ name: 'lead', instrument: 'koto', notes: [[0, 0.4, 'D4', 80]] }] }))
  const music = await tools.get('anyaudio_music').execute({ projectId: await freshAttach(), score: scorePath, output: '.anyaudio/test-tmp/schema-music.wav', tailSec: 0.2 }, exec)
  assertMatchesOutputSchema(tools.get('anyaudio_music'), music)
  assert(music.ok === true, 'a score given as a file path should render')

  const sfx = await tools.get('anyaudio_sfx').execute({ action: 'catalog' }, exec)
  assertMatchesOutputSchema(tools.get('anyaudio_sfx'), sfx)
  const sfxItems = await tools.get('anyaudio_sfx').execute(
    { projectId: await freshAttach(), items: [{ type: 'impact', startSec: 0, durationSec: 0.4 }], durationSec: 0.5, output: '.anyaudio/test-tmp/schema-sfx.wav' },
    exec,
  )
  assertMatchesOutputSchema(tools.get('anyaudio_sfx'), sfxItems)

  const mixed = await tools.get('anyaudio_mix').execute(
    { tracks: [{ role: 'music', path: music.absolutePath }], durationSec: 0.6, output: '.anyaudio/test-tmp/schema-mix.wav' },
    exec,
  )
  assertMatchesOutputSchema(tools.get('anyaudio_mix'), mixed)
})

await test('missing files fail with actionable messages', async () => {
  let message = ''
  try {
    await tools.get('anyaudio_mix').execute({ tracks: [{ role: 'music', path: join(tmpDir, 'nope.wav') }] }, exec)
  } catch (error) {
    message = error.message
  }
  assert(message.length > 0, 'mix should fail on a missing track')
})

await test('sources tool lists real instruments and presets', async () => {
  const instruments = await tools.get('anyaudio_sources').execute({ action: 'instruments' }, exec)
  const names = instruments.instruments.flatMap((group) => group.instruments.map((entry) => entry.name))
  for (const expected of ['guzheng', 'erhu', 'dizi', 'xiao', 'taiko', 'cello']) assert(names.includes(expected), `missing instrument alias ${expected}`)
  const presets = await tools.get('anyaudio_sources').execute({ action: 'presets', query: 'koto', limit: 10 }, exec)
  assert(presets.presets.length > 0, 'expected at least one koto preset')
})

await test('sources tool exposes extensible source kinds', async () => {
  const kinds = (await tools.get('anyaudio_sources').execute({ action: 'kinds' }, exec)).kinds
  const ids = kinds.map((kind) => kind.id)
  for (const expected of ['soundfont', 'procedural', 'sample-pack', 'voice']) assert(ids.includes(expected), `missing source kind ${expected}`)
  assert(kinds.find((kind) => kind.id === 'soundfont').status === 'stable', 'soundfont should be stable')
  assert(kinds.find((kind) => kind.id === 'sample-pack').status === 'planned', 'sample packs are not implemented yet')
})

await test('GM programs map to instrument families and scores respect overrides', async () => {
  assert(categoryOfProgram(0) === 'piano', `program 0 → piano, got ${categoryOfProgram(0)}`)
  assert(categoryOfProgram(24) === 'guitar', `program 24 → guitar, got ${categoryOfProgram(24)}`)
  assert(categoryOfProgram(40) === 'strings', `program 40 → strings, got ${categoryOfProgram(40)}`)
  assert(categoryOfProgram(112) === 'percussive', `program 112 → percussive, got ${categoryOfProgram(112)}`)
  const font = { id: 'a', presetScores: [{ bank: 0, program: 24, score: 9 }], scores: { guitar: 4, default: 5 } }
  assert(fontScore(font, 'guitar', 24) === 9, 'preset score should win')
  assert(fontScore(font, 'guitar', 25) === 4, 'category score should apply to other programs')
  assert(fontScore({ id: 'b', scores: {} }, 'strings', 40) === 5, 'default score is 5')
  const ranked = rankFonts([{ id: 'x', scores: { piano: 3 } }, { id: 'y', scores: { piano: 8 } }], 'piano', 0)
  assert(ranked[0].id === 'y' && ranked[1].id === 'x', 'fonts should rank by family score')
})

await test('bank offsets skip collisions and never overflow bank 127', async () => {
  const bankB = { presets: [{ bankMSB: 0, program: 0 }] }
  assert(planOffset(new Set(['0:0', '0:24']), bankB) === 1, 'offset 0 collides, so offset 1 is the smallest safe one')
  assert(planOffset(new Set(), bankB) === 0, 'an empty bank space starts at 0')
  const topBank = { presets: [{ bankMSB: 127, program: 0 }] }
  assert(planOffset(new Set(['127:0']), topBank) === null, 'no offset can keep a bank-127 preset out of collision/overflow')
})

await test('a single-instrument bank plays its own program; ambiguous banks refuse', async () => {
  const solo = { presets: [{ bankMSB: 0, program: 40 }] }
  assert(pickProgram(solo, 24) === 40, 'a one-preset bank should map any request to its preset')
  const exact = { presets: [{ bankMSB: 0, program: 24 }, { bankMSB: 0, program: 40 }] }
  assert(pickProgram(exact, 24) === 24, 'an exact program match wins')
  assert(pickProgram(exact, 56) === null, 'no matching program in a multi-preset bank means refuse')
})

await test('score tracks carry an optional source and unknown sources fail clearly', async () => {
  const compiled = compileScore({ tracks: [{ name: 'g', instrument: 'guitar', source: 'generaluser', notes: [[0, 0.5, 'E3', 80]] }] })
  assert(compiled.tracks[0].source === 'generaluser', 'compileScore should pass source through')
  let message = ''
  try {
    await tools.get('anyaudio_music').execute(
      {
        projectId: await freshAttach(),
        score: { tracks: [{ name: 'g', instrument: 'guitar', source: 'no-such-font', notes: [[0, 0.5, 'E3', 80]] }] },
        durationSec: 0.6,
        output: '.anyaudio/test-tmp/bad-source.wav',
      },
      exec,
    )
  } catch (error) {
    message = error.message
  }
  assert(/not installed|unknown sound source/.test(message), `expected an actionable source error, got "${message}"`)
})

await test('per-track source and auto both render and report the plan', async () => {
  const result = await tools.get('anyaudio_music').execute(
    {
      projectId: await freshAttach(),
      score: {
        tracks: [
          { name: 'explicit', instrument: 'koto', source: 'generaluser', notes: [[0, 1, 'D4', 80]] },
          { name: 'auto', instrument: 'flute', source: 'auto', notes: [[0, 1, 'A4', 70]] },
        ],
      },
      durationSec: 1.2,
      output: '.anyaudio/test-tmp/multi-source.wav',
    },
    exec,
  )
  assert(result.fonts.length >= 1, `explicit source should load at least its bank, got ${result.fonts.length}`)
  assert(result.fonts.some((font) => font.id === 'generaluser'), 'generaluser should be in the plan')
  assert(result.tracks.find((track) => track.name === 'explicit').source === 'generaluser', 'explicit source should be reported')
  const auto = result.tracks.find((track) => track.name === 'auto')
  assert(auto?.source, 'auto should resolve to an installed source')
  if (auto.source !== 'generaluser') {
    assert(
      result.warnings.some((line) => line.includes('auto-picked')),
      `auto should explain a non-default pick, warnings: ${result.warnings.join(' | ')}`,
    )
  }
})

await test('stems keep the authored balance instead of being re-normalised', async () => {
  const result = await tools.get('anyaudio_music').execute(
    {
      projectId: await freshAttach(),
      score: {
        title: 'balance',
        tracks: [
          { name: 'lead', instrument: 'koto', gainDb: -3, notes: [[0, 1, 'D5', 110], [1, 1, 'A5', 110]] },
          { name: 'pad', instrument: 'slow-strings', gainDb: -24, notes: [[0, 2.4, ['D4', 'A4'], 70]] },
        ],
      },
      durationSec: 2.5,
      stems: true,
      output: '.anyaudio/test-tmp/balance.wav',
    },
    exec,
  )
  const byName = new Map(result.tracks.map((track) => [track.name, track]))
  const drop = byName.get('lead').rmsDb - byName.get('pad').rmsDb
  assert(drop > 8, `the lead should sit clearly above the pad, measured ${drop.toFixed(1)} dB`)
  assert(result.stemsNormalized === false, 'stems must be reported as not normalised')
  assert(result.warnings.some((warning) => warning.includes('below the loudest')), 'a buried part must raise a balance warning')
  // Stems are written next to the staged score (they are project material, not
  // deliverables), so read them from the paths the tool reports.
  const stemPath = (name) => result.stems.find((entry) => entry.includes(`-${name}.wav`))
  const lead = parseWav(await readFile(join(repoRoot, stemPath('lead'))))
  const pad = parseWav(await readFile(join(repoRoot, stemPath('pad'))))
  const fileRatio = toDb(rmsOf(lead.channels) / Math.max(1e-9, rmsOf(pad.channels)))
  assert(fileRatio > 8, `stem files must preserve the authored difference, measured ${fileRatio.toFixed(1)} dB`)
  // Each stem is its own clip on its own track, so a person can rebalance them.
  assert(result.attached.length === 2, `both stems must land in the project, got ${result.attached.length}`)
  assert(result.attached.every((entry) => entry.trackName && entry.clipId), 'each stem needs its own track and clip')
})

await test('workspace comes from the working-directory service, not process.cwd()', async () => {
  const shared = await import('../src/tools/shared.js')
  const fakeRoot = join(repoRoot, '.anyaudio/test-tmp/fake-ws')
  shared.setWorkingDirectoryService({ ensure: async () => fakeRoot })
  const resolved = await shared.workspaceRootOf({ agent: {} })
  assert(resolved === resolve(fakeRoot), `workingDirectory should win, got ${resolved}`)
  const relative = shared.resolveOutputPath({ workspaceRoot: resolved, requested: 'assets/x.wav', defaultName: 'y.wav' })
  assert(relative === resolve(fakeRoot, 'assets/x.wav'), 'relative output resolves against the project')
  shared.setWorkingDirectoryService(null)
  const none = await shared.workspaceRootOf({ agent: {} })
  assert(none === null, `without the service the workspace must be null, got ${none}`)
  let threw = false
  try {
    shared.resolveOutputPath({ workspaceRoot: null, requested: 'x.wav', defaultName: 'y.wav' })
  } catch {
    threw = true
  }
  assert(threw, 'relative output without a workspace must fail instead of writing into the profile folder')
  assert(
    shared.resolveOutputPath({ workspaceRoot: null, requested: 'C:/tmp/x.wav', defaultName: 'y.wav' }) === 'C:/tmp/x.wav',
    'absolute output must work without a workspace',
  )
})

await test('the runtime skill declares a string source for the dsh-skill contract', async () => {
  const { apply } = await import('../src/index.js')
  let payload = null
  const ctx = {
    get: (id) => (id === 'skills' ? { register: (value) => { payload = value } } : undefined),
    tools: { register: () => {} },
    logger: { info: () => {} },
  }
  apply(ctx, { routes: false })
  for (let attempt = 0; attempt < 40 && !payload; attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert(payload, 'skill was not registered')
  assert(typeof payload.source === 'string' && payload.source.length > 0, `skill source must be a string, got ${JSON.stringify(payload.source)}`)
  assert(typeof payload.whenToUse === 'string' && payload.whenToUse.length > 0, 'skill should advertise whenToUse')
})

await test('tts tool exposes edge and mimo providers', async () => {
  const definition = tools.get('anyaudio_tts')
  assert(definition, 'anyaudio_tts should be registered')
  assert(definition.description.includes('MiMo'), 'description should name the second engine')
  assert(/edge/i.test(definition.description), 'description should name the default engine')
  assert(definition.parameters.properties.text, 'text should be a single-shot input')
  assert(definition.parameters.properties.voice, 'voice should be selectable')
  assert(definition.parameters.properties.provider, 'provider should be selectable')
  assert(typeof definition.output?.render === 'function', 'tts needs a render summary')
})

await test('mimo requests go over node:https and honour a per-engine proxy', async () => {
  const { buildMimoRequest } = await import('../src/audio/tts-providers.js')
  const body = buildMimoRequest({ text: '你好', voice: 'mimo_default', style: '温柔地' })
  assert(body.messages.length === 2 && body.messages[1].role === 'assistant', 'text must stay in the assistant role')
  const { DEFAULTS } = await import('../src/config.js')
  assert(DEFAULTS.tts.mimo.proxy === '', 'MiMo must default to a direct connection')
  assert(DEFAULTS.tts.edge.proxy === '', 'Edge keeps its own proxy field')
  const parsed = JSON.parse(JSON.stringify(body))
  assert(parsed.audio.format === 'wav' && parsed.stream === false, 'MiMo still asks for a non-streaming WAV')
})

await test('sfx catalog lists default-bank presets by scene', async () => {
  const catalog = await tools.get('anyaudio_sfx').execute({ action: 'catalog' }, exec)
  assert(catalog.action === 'catalog', 'catalog action should be echoed')
  assert(catalog.presets.length >= 40, `expected a full catalog, got ${catalog.presets.length}`)
  const rain = catalog.presets.find((entry) => entry.id === 'rain')
  assert(rain && rain.zh === '雨' && rain.program === 122 && rain.bank === 1, 'rain should map to program 122 / bank 1')
  assert(rain.shape === 'sustained' && rain.lengthSec === null, 'rain is a sustained bed')
  const shot = catalog.presets.find((entry) => entry.id === 'gun-shot')
  assert(shot && shot.shape === 'one-shot' && shot.lengthSec > 0, 'gun shot is a one-shot with a natural tail')
  const weather = await tools.get('anyaudio_sfx').execute({ action: 'catalog', group: 'weather' }, exec)
  assert(weather.presets.every((entry) => entry.group === 'weather'), 'group filter should be applied')
  assert(weather.presets.some((entry) => entry.id === 'seashore'), 'seashore belongs to weather')
})

await test('sfx preset renders real audio, one file per effect', async () => {
  const output = join(tmpDir, 'sfx-preset')
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      items: [
        { preset: 'rain', startSec: 0.5, durationSec: 2.5, gainDb: -6 },
        { preset: 'gun-shot', startSec: 0, gainDb: -8 },
      ],
      peakDb: null,
      output,
    },
    exec,
  )
  // Each effect is its own file now, so there is no shared bed length to check:
  // the material length is what the clip plays, and it has to be real audio.
  assert(result.materials.length === 2, `expected 2 materials, got ${result.materials.length}`)
  for (const entry of result.materials) {
    const wav = parseWav(await readFile(entry.absolutePath))
    assert(peakOf(wav.channels) > 0.001, `${entry.file} must not be silent`)
    assert(Math.abs(wav.durationSec - entry.durationSec) < 0.05, `${entry.file}: report says ${entry.durationSec}s, file is ${wav.durationSec}s`)
  }
  const rain = result.materials.find((entry) => entry.preset === 'rain')
  assert(rain, 'the report should name the rain preset')
  assert(rain.presetName.includes('雨'), 'report should use the Chinese name')
  assert(Math.abs(rain.durationSec - 2.5) < 0.05, `rain should be cut at 2.5s, got ${rain.durationSec}`)
  assert(result.materials.every((entry) => entry.attached?.clipId), 'both effects must land as clips')
})

await test('unknown sfx preset points at the catalog', async () => {
  let error = null
  try {
    await tools.get('anyaudio_sfx').execute({ projectId: await freshAttach(), items: [{ preset: 'dragon-roar', startSec: 0 }], durationSec: 1 }, exec)
  } catch (caught) {
    error = caught
  }
  assert(error, 'unknown preset should fail')
  assert(/action:"catalog"/.test(error.message), 'error should point at the catalog')
})

await test('sfx materials mode writes one file per item, each from t=0', async () => {
  const dir = join(tmpDir, 'sfx-materials')
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      mode: 'materials',
      items: [
        { type: 'impact', durationSec: 0.8, params: { weight: 0.8 } },
        { preset: 'rain', durationSec: 1.5, gainDb: -6 },
        { type: 'whoosh', durationSec: 0.6 },
      ],
      output: dir,
      peakDb: null,
    },
    exec,
  )
  assert(result.mode === 'materials', 'the mode should be echoed')
  assert(result.materials.length === 3, `expected 3 materials, got ${result.materials.length}`)
  // Every material also becomes its own clip, so one effect can be moved without
  // re-rendering the others (improvement 01 / I-10).
  assert(result.materials.every((entry) => entry.attached?.clipId), 'every material must land as a clip')
  const categories = result.materials.map((entry) => entry.attached.trackName)
  assert(new Set(categories).size >= 2, `effects of different categories should not share a track, got ${categories.join(' | ')}`)
  // One file per entry, and every file starts at t=0: that is the whole point of
  // the materials split — placement belongs to the project, not the tool.
  for (const entry of result.materials) {
    const wav = parseWav(await readFile(entry.absolutePath))
    assert(wav.channels[0][0] !== undefined, `${entry.file} must exist and decode`)
    assert(peakOf(wav.channels) > 0.0005, `${entry.file} must not be silent`)
    assert(Math.abs(wav.durationSec - entry.durationSec) < 0.05, `${entry.file}: report says ${entry.durationSec}s, file is ${wav.durationSec}s`)
  }
  assert(result.materials[0].category === '动效', `impact is 动效, got ${result.materials[0].category}`)
  assert(result.materials[1].category === '环境音', `rain is 环境音, got ${result.materials[1].category}`)
  assert(result.materials[2].category === '其他', `whoosh is 其他, got ${result.materials[2].category}`)
  // The per-item length is honoured, not the preset's natural tail.
  assert(Math.abs(result.materials[1].durationSec - 1.5) < 0.02, `rain should be cut at 1.5s, got ${result.materials[1].durationSec}`)
  const manifestRaw = await readFile(join(dir, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestRaw)
  assert(manifest.materials.length === 3, 'the manifest must list every material')
  assert(manifest.materials.every((entry) => typeof entry.category === 'string'), 'each manifest row carries a category')
})

await test('sfx materials mode refuses an item without a length', async () => {
  let error = null
  try {
    await tools.get('anyaudio_sfx').execute({ projectId: await freshAttach(), mode: 'materials', items: [{ type: 'wind' }], output: join(tmpDir, 'sfx-materials-2') }, exec)
  } catch (caught) {
    error = caught
  }
  assert(error, 'an unbounded material should fail')
  assert(/needs durationSec/.test(error.message), `message should name the missing length, got: ${error.message}`)
})

await test('sfx has a single mode and it places events as clips', async () => {
  // Improvement plan 02, I-01. "timeline" mode used to bake every effect into one
  // full-length clip, so nothing inside it could be moved or rebalanced — the
  // exact shape a clip bay exists to prevent. It is gone, and the default with it.
  const output = join(tmpDir, 'sfx-default')
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      items: [
        { type: 'impact', startSec: 0.3, durationSec: 0.4 },
        { type: 'whoosh', durationSec: 0.4 },
      ],
      output,
      peakDb: null,
    },
    exec,
  )
  assert(result.mode === 'materials', `the only mode is materials, got ${result.mode}`)
  assert(result.materials.length === 2, `one file per effect, got ${result.materials.length}`)
  assert(result.materials.every((entry) => entry.attached?.clipId), 'each effect lands as its own clip')
  assert(result.materials.every((entry) => entry.file), 'and its own file')
  const placed = await readProject(repoRoot, result.projectId)
  const clips = placed.tracks.flatMap((track) => track.items)
  assert(clips.length === 2, `the project should hold two clips, it holds ${clips.length}`)
  assert(clips.some((item) => Math.abs(item.startSec - 0.3) < 1e-6), `the explicit startSec must be honoured, got ${clips.map((item) => item.startSec).join(', ')}`)
})

await test('sfx refuses mode:"timeline" and points at the alternative', async () => {
  let error = null
  try {
    await tools.get('anyaudio_sfx').execute(
      { projectId: await freshAttach(), mode: 'timeline', items: [{ type: 'wind', durationSec: 1 }] },
      exec,
    )
  } catch (caught) {
    error = caught
  }
  assert(error, 'the removed mode must fail')
  assert(/Use mode:"materials"/.test(error.message), `it must name the surviving mode, got: ${error.message}`)
  assert(/anyaudio_mix/.test(error.message), 'and where a flat bed comes from now')
})

await test('a batch of sfx without startSec chains onto one track instead of stacking at 0', async () => {
  // Improvement plan 02, I-02. Every effect used to land at 0s, so freeTrack saw
  // the track busy and opened the next one: ten effects became ten tracks and the
  // project hit its 20-track limit. The rule the person actually wants is
  // "same category that does not overlap shares a track", which needs the start
  // to advance along the category's tracks.
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      items: [
        { type: 'thunder', durationSec: 0.5 },
        { type: 'thunder', durationSec: 0.5 },
        { type: 'thunder', durationSec: 0.5 },
        { type: 'bell', durationSec: 0.5 },
      ],
      output: join(tmpDir, 'sfx-chain'),
      peakDb: null,
    },
    exec,
  )
  const placed = await readProject(repoRoot, result.projectId)
  const ambientTracks = placed.tracks.filter((track) => track.category === 'ambience')
  assert(ambientTracks.length === 1, `four ambient effects should share one track, they took ${ambientTracks.length}`)
  assert(placed.tracks.length === 2, `ambience + foley = 2 tracks, got ${placed.tracks.map((t) => `${t.name}[${t.category}]`).join(', ')}`)
  const starts = ambientTracks[0].items.map((item) => item.startSec).sort((a, b) => a - b)
  assert(starts.length === 3, `three thunder clips on the ambient track, got ${starts.length}`)
  assert(starts[0] === 0, `the first starts at 0, got ${starts[0]}`)
  for (let index = 1; index < starts.length; index++) {
    assert(starts[index] > starts[index - 1], `clips advance in time, got ${starts.join(', ')}`)
  }
  // And the fade of a clip is not what decides its place: the chain is by length.
  assert(Math.abs(starts[1] - 0.5) < 0.02, `the second starts after the first ends, got ${starts[1]}`)
})

await test('an explicit sfx startSec overlapping another effect gets its own track', async () => {
  // The other half of the same rule: overlapping effects must stay separable, so
  // asking for two sounds at the same instant has to open a second track.
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      items: [
        { type: 'bell', startSec: 0, durationSec: 1 },
        { type: 'bell', startSec: 0.2, durationSec: 1 },
      ],
      output: join(tmpDir, 'sfx-overlap'),
      peakDb: null,
    },
    exec,
  )
  const placed = await readProject(repoRoot, result.projectId)
  const foley = placed.tracks.filter((track) => track.category === 'foley')
  assert(foley.length === 2, `two overlapping bells are two tracks, got ${foley.length}`)
  assert(foley.map((track) => track.name).sort().join(' | ') === '音效 · 动效 | 音效 · 动效 2', `suffixes only appear when needed, got ${foley.map((t) => t.name).join(' | ')}`)
})

await test('both general banks are suggested, GeneralUser is the default', async () => {
  const { RECOMMENDED_FONTS } = await import('../src/audio/fonts.js')
  const suggested = RECOMMENDED_FONTS.filter((font) => font.suggested).map((font) => font.id)
  assert(suggested.includes('generaluser') && suggested.includes('musescore-general'), `suggested were ${suggested.join(',')}`)
  assert(suggested.length === 2, 'exactly two suggested banks')
  const defaults = RECOMMENDED_FONTS.filter((font) => font.default).map((font) => font.id)
  assert(defaults.length === 1 && defaults[0] === 'generaluser', `default bank should be GeneralUser only, got ${defaults.join(',')}`)
})

await test('the machine-wide state file was never touched', async () => {
  const after = await snapshot(realStatePath)
  assert(JSON.stringify(after) === JSON.stringify(realStateBefore), `real state file changed: ${realStatePath}`)
})

await rm(tmpDir, { recursive: true, force: true })
// Remove only what this run created: the scratch projects and staged files the
// generating tools wrote outside test-tmp. A project that was already in the
// workspace belongs to the user and must survive the test.
for (const name of await listing(outDirPath)) {
  if (!preexistingOut.has(name)) await rm(join(outDirPath, name), { recursive: true, force: true })
}
for (const name of await listing(projectsDirPath)) {
  if (!preexistingProjects.has(name)) await rm(join(projectsDirPath, name), { recursive: true, force: true })
}
// Restore the pre-run state of the scratch parent: when `.anyaudio` did not
// exist before the run, leave the tree exactly as it was.
if (!hadAnyAudioDir) {
  const leftover = await readdir(anyaudioDir).catch(() => [])
  if (leftover.length === 0) await rm(anyaudioDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

