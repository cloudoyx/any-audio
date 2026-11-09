/**
 * Playback scheduling (plan M5.3).
 *
 * The point of testing this without a browser is that the numbers must match the
 * renderer exactly: if preview and export disagree about gain or offset, the user
 * hears one thing and exports another.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// The mix arithmetic lives in mix-params.js since improvement plan 02 (I-04), so
// both modules are concatenated into one scratch module: the preview half is
// still the real audio.js, it just gets its shared parameters from the file the
// renderer also reads.
//
// `API` is the one module-level value the stripped imports supplied — the reverb
// worklet URL is built from it, which is evaluated when the module loads even
// though no test calls the hook. Declaring it here keeps the pure helpers
// loadable without a browser.
const mixParamsSource = readFileSync(join(root, 'src', 'client', 'clipbay', 'mix-params.js'), 'utf8')
const source = readFileSync(join(root, 'src', 'client', 'clipbay', 'audio.js'), 'utf8')
  // The hooks import react, which is not needed for the pure helpers.
  .replace(/^import .*$/gm, '')
  .replace(/export function usePlayback[\s\S]*$/m, '')
const { scheduleClips, audibleTracks, dbToGain, scheduledLength, mixedGain, resolveTrackGain, itemParams, masterParams, panGains, contentEnd, playbackStart } = await import(
  `data:text/javascript;base64,${Buffer.from(`const API = '/api/dsh-any-audio'\n${mixParamsSource}\n${source}`, 'utf8').toString('base64')}`
)

let passed = 0
let failed = 0

function test(name, run) {
  try {
    run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`     ${error.message}`)
  }
}

function check(condition, message) {
  assert.ok(condition, message)
}

function close(actual, expected, message, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${message}: expected ${expected}, got ${actual}`)
}

function track(overrides = {}) {
  return { id: 'trk_1', name: 'T', category: 'other', muted: false, solo: false, items: [], ...overrides }
}

function item(overrides = {}) {
  return {
    id: 'itm_1', material: 'mat_1', startSec: 0, inSec: 0, outSec: 2,
    gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: '', ...overrides,
  }
}

test('dbToGain matches the dB definition, and 0 dB is exactly 1', () => {
  assert.equal(dbToGain(0), 1)
  close(dbToGain(-6), 0.5011872336, '-6 dB is half amplitude')
  close(dbToGain(6), 1.99526231, '+6 dB doubles')
  close(dbToGain(-120), 1e-6, 'silence floor')
})

test('audibleTracks: mute removes a track, solo wins over everything', () => {
  const plain = [track({ id: 'a' }), track({ id: 'b' })]
  assert.deepEqual(audibleTracks(plain).map((t) => t.id), ['a', 'b'])

  const muted = [track({ id: 'a' }), track({ id: 'b', muted: true })]
  assert.deepEqual(audibleTracks(muted).map((t) => t.id), ['a'])

  const solo = [track({ id: 'a' }), track({ id: 'b', solo: true }), track({ id: 'c' })]
  assert.deepEqual(audibleTracks(solo).map((t) => t.id), ['b'], 'solo silences the rest')

  const soloMuted = [track({ id: 'a', solo: true, muted: true }), track({ id: 'b', solo: true })]
  assert.deepEqual(audibleTracks(soloMuted).map((t) => t.id), ['b'], 'a muted solo track is still silent')
})

test('scheduleClips places a clip at its start time', () => {
  const project = { tracks: [track({ items: [item({ startSec: 3, inSec: 1, outSec: 4 })] })] }
  const entries = scheduleClips(project, 0)
  assert.equal(entries.length, 1)
  const entry = entries[0]
  close(entry.when, 3, 'starts at 3s')
  close(entry.inSec, 1, 'reads from the in point')
  close(entry.duration, 3, 'lasts outSec - inSec')
})

test('scheduleClips takes the gain from the clip, not from the track', () => {
  // Improvement plan 03, I-41: a track has no fader. A leftover volumeDb in an
  // old project is ignored rather than applied on top of the clip's gain.
  const project = { tracks: [track({ volumeDb: -6, items: [item({ gainDb: -3.5 })] })] }
  const entry = scheduleClips(project, 0)[0]
  close(entry.gain, dbToGain(-3.5), 'the clip gain is the whole gain', 1e-9)
})

test('scheduleClips takes the pan from the clip alone, clamped', () => {
  const project = { tracks: [track({ pan: 0.4, items: [item({ pan: 0.4 })] })] }
  close(scheduleClips(project, 0)[0].pan, 0.4, 'the track pan is gone, not added')
  const over = { tracks: [track({ items: [item({ pan: 2 })] })] }
  close(scheduleClips(over, 0)[0].pan, 1, 'and the clip value is clamped')
})

test('a muted clip or track is scheduled silent, not dropped', () => {
  // Deliberate: an unmute or a solo while the transport runs has to be heard at
  // once, and a clip that was never scheduled has no node to turn back up. The
  // mute therefore lives in the gain, not in whether the clip exists.
  const mutedItem = { tracks: [track({ items: [item({ muted: true })] })] }
  const itemEntries = scheduleClips(mutedItem, 0)
  assert.equal(itemEntries.length, 1, 'a muted clip still gets a node')
  assert.equal(itemEntries[0].gain, 0, 'but it is silent')

  const mutedTrack = { tracks: [track({ muted: true, items: [item()] })] }
  const trackEntries = scheduleClips(mutedTrack, 0)
  assert.equal(trackEntries.length, 1, 'a muted track keeps its nodes')
  assert.equal(trackEntries[0].gain, 0, 'and every clip on it is silent')

  const soloed = { tracks: [track({ id: 'a', items: [item({ id: 'i1' })] }), track({ id: 'b', solo: true, items: [item({ id: 'i2' })] })] }
  const soloEntries = scheduleClips(soloed, 0)
  assert.equal(soloEntries.length, 2, 'solo keeps the other tracks scheduled too')
  assert.equal(soloEntries.find((entry) => entry.trackId === 'a').gain, 0, 'the non-soloed track is silent')
  assert.ok(soloEntries.find((entry) => entry.trackId === 'b').gain > 0, 'the soloed one still sounds')
})

test('scheduleClips drops clips that already ended before the playhead', () => {
  const project = { tracks: [track({ items: [item({ startSec: 0, inSec: 0, outSec: 2 })] })] }
  assert.equal(scheduleClips(project, 2).length, 0, 'an ended clip is not scheduled')
  assert.equal(scheduleClips(project, 5).length, 0, 'nor one long past')
})

test('scheduleClips enters a clip mid-way when the playhead is inside it', () => {
  const project = { tracks: [track({ items: [item({ startSec: 2, inSec: 1, outSec: 5, fadeInSec: 1, fadeOutSec: 0.5 })] })] }
  const entry = scheduleClips(project, 3.5)[0]
  close(entry.when, 0, 'it starts immediately')
  close(entry.duration, 2.5, 'only the remainder plays')
  close(entry.inSec, 2.5, 'the in point advances by the skipped part')
  close(entry.fadeInSec, 0, 'the fade-in was already passed')
  close(entry.fadeOutSec, 0.5, 'the fade-out is untouched')
})

test('scheduleClips keeps the part of a fade-in that is still ahead', () => {
  const project = { tracks: [track({ items: [item({ startSec: 0, inSec: 0, outSec: 10, fadeInSec: 4 })] })] }
  const entry = scheduleClips(project, 1)[0]
  close(entry.fadeInSec, 3, 'three seconds of fade remain')
})

test('scheduleClips never fades out longer than the clip plays', () => {
  const project = { tracks: [track({ items: [item({ startSec: 0, inSec: 0, outSec: 2, fadeOutSec: 30 })] })] }
  close(scheduleClips(project, 1.5)[0].fadeOutSec, 0.5, 'the fade is clamped to what is left')
})

test('scheduleClips orders entries by start time', () => {
  const project = {
    tracks: [
      track({ id: 'a', items: [item({ id: 'late', startSec: 8, outSec: 1 })] }),
      track({ id: 'b', items: [item({ id: 'early', startSec: 1, outSec: 1 })] }),
    ],
  }
  assert.deepEqual(scheduleClips(project, 0).map((e) => e.itemId), ['early', 'late'])
})

test('scheduleClips handles a zero-length or inverted range without scheduling it', () => {
  const project = { tracks: [track({ items: [item({ inSec: 2, outSec: 2 })] })] }
  assert.equal(scheduleClips(project, 0).length, 0)
  const inverted = { tracks: [track({ items: [item({ inSec: 3, outSec: 1 })] })] }
  assert.equal(scheduleClips(inverted, 0).length, 0)
})

test('scheduleClips survives an empty project', () => {
  assert.deepEqual(scheduleClips(null, 0), [])
  assert.deepEqual(scheduleClips({ tracks: [] }, 0), [])
  assert.deepEqual(scheduleClips({ tracks: [track()] }, 0), [])
})

test('scheduledLength follows the last clip end', () => {
  const project = {
    tracks: [track({ items: [item({ id: 'a', startSec: 0, outSec: 2 }), item({ id: 'b', startSec: 5, inSec: 0, outSec: 3 })] })],
  }
  const entries = scheduleClips(project, 0)
  close(scheduledLength(entries), 8, 'the transport stops at the last tail')
  close(scheduledLength(scheduleClips(project, 6)), 2, 'and shortens when starting late')
})

test('scheduleClips agrees with a hand-computed renderer mix', () => {
  // Two clips on two tracks, one trimmed, one panned: the export mix of this
  // arrangement is what these four numbers describe. Since I-41 the tracks carry
  // no level or pan of their own, so both come from the clips.
  const project = {
    tracks: [
      track({ id: 'a', items: [item({ id: 'a1', startSec: 0, inSec: 0.5, outSec: 2.5, gainDb: -1 })] }),
      track({ id: 'b', items: [item({ id: 'b1', startSec: 1, inSec: 0, outSec: 1, pan: -1 })] }),
    ],
  }
  const entries = scheduleClips(project, 0)
  const a = entries.find((e) => e.itemId === 'a1')
  const b = entries.find((e) => e.itemId === 'b1')
  close(a.when, 0, 'a starts at 0')
  close(a.inSec, 0.5, 'a is trimmed in')
  close(a.duration, 2, 'a lasts 2s')
  close(a.gain, dbToGain(-1), 'a carries its own -1 dB')
  close(b.when, 1, 'b starts at 1')
  close(b.pan, -1, 'b is hard left')
})

test('mixedGain reads the live project, which is what makes an edit audible', () => {
  // Improvement plan 01, I-06. The value the graph is pushed must be computed
  // from the current project, not from what was true when playback started.
  const project = {
    tracks: [
      track({ id: 'a', items: [item({ id: 'a1', gainDb: 0 })] }),
      track({ id: 'b', items: [item({ id: 'b1', gainDb: -3 })] }),
    ],
  }
  close(mixedGain(project, 'a', 'a1'), 1, 'unity stays exactly 1')
  close(mixedGain(project, 'b', 'b1'), dbToGain(-3), 'the clip gain is the gain')

  project.tracks[1].items[0].gainDb = -20
  close(mixedGain(project, 'b', 'b1'), dbToGain(-20), 'a clip gain move is picked up at once')

  project.tracks[0].muted = true
  assert.equal(mixedGain(project, 'a', 'a1'), 0, 'muting the track silences its clips')
  assert.ok(mixedGain(project, 'b', 'b1') > 0, 'and leaves the others alone')

  project.tracks[0].muted = false
  close(mixedGain(project, 'a', 'a1'), 1, 'unmuting restores the level')

  project.tracks[0].items[0].muted = true
  assert.equal(mixedGain(project, 'a', 'a1'), 0, 'a muted clip is silent too')

  project.tracks[0].items[0].muted = false
  project.tracks[1].solo = true
  assert.equal(mixedGain(project, 'a', 'a1'), 0, 'solo silences the other tracks')
  close(mixedGain(project, 'b', 'b1'), dbToGain(-20), 'the soloed track keeps its level')

  project.tracks[1].solo = false
  close(mixedGain(project, 'a', 'a1'), 1, 'cancelling solo brings the others back')

  assert.equal(mixedGain(project, 'nope', 'a1'), 0, 'an unknown track is silent')
  assert.equal(mixedGain(project, 'a', 'nope'), 0, 'an unknown clip is silent')
})

test('resolveTrackGain puts mute above solo, and applies no volume', () => {
  assert.equal(resolveTrackGain({}, false), 1)
  assert.equal(resolveTrackGain({ volumeDb: -6 }, false), 1, 'a leftover volume is ignored')
  assert.equal(resolveTrackGain({ muted: true }, false), 0, 'mute wins')
  assert.equal(resolveTrackGain({ solo: false }, true), 0, 'someone else soloed')
  assert.equal(resolveTrackGain({ solo: true }, true), 1, 'this one is soloed')
  assert.equal(resolveTrackGain({ solo: true, muted: true }, true), 0, 'muted solo is still silent')
})

test('scheduleClips keeps the clip factor apart from the mute factor', () => {
  // The graph applies trackGain (now only 1 or 0: mute/solo) and itemGain on
  // separate nodes, so a track mute never overwrites a clip's own gain.
  const project = {
    tracks: [track({ id: 'a', items: [item({ id: 'a1', gainDb: -3 })] })],
  }
  const entry = scheduleClips(project, 0)[0]
  close(entry.trackGain, 1, 'an audible track imposes no level')
  close(entry.itemGain, dbToGain(-3), 'clip factor')
  close(entry.gain, dbToGain(-3), 'and their product')

  const muted = { tracks: [track({ id: 'a', muted: true, items: [item({ id: 'a1', gainDb: -3 })] })] }
  close(scheduleClips(muted, 0)[0].trackGain, 0, 'a muted track contributes zero')
})

test('the transport pushes the mix when the project changes', () => {
  // A structural check: the hook must expose applyMix and setProject must call
  // it, otherwise a clip gain move during playback is never heard.
  const raw = readFileSync(join(root, 'src', 'client', 'clipbay', 'audio.js'), 'utf8')
  assert.match(raw, /applyMix/, 'the hook exposes applyMix')
  assert.match(raw, /return \{[^}]*applyMix[^}]*\}/, 'applyMix is part of the returned transport')
  assert.match(raw, /setTargetAtTime/, 'live moves ramp instead of jumping (no click)')
  const setProjectBody = raw.slice(raw.indexOf('const setProject = useCallback'))
  assert.match(setProjectBody.slice(0, 400), /applyMix\(project\)/, 'setProject pushes the mix')
})

test('pan follows the same live path as the clip gain', () => {
  // Pan was written once when the graph was built, so turning the knob during
  // playback did nothing until the next play. It has to ramp like the gains do,
  // and it lives in one place — computed once, in mix-params.js, for both engines.
  const raw = readFileSync(join(root, 'src', 'client', 'clipbay', 'audio.js'), 'utf8')
  const shared = readFileSync(join(root, 'src', 'client', 'clipbay', 'mix-params.js'), 'utf8')
  assert.match(shared, /export function itemParams/, 'itemParams is the one place clip pan is read')
  assert.match(shared, /pan: Math\.max\(-1, Math\.min\(1, Number\(item\?\.pan\) \|\| 0\)\)/, 'the clip value is clamped once, there')
  assert.equal(/track\?\.pan/.test(shared), false, 'a track pan is not added on top (I-41)')
  // Slice the whole function, not a fixed window: applyMix grew when the effect
  // chains landed, and a char count would silently start reading past its end.
  const mixStart = raw.indexOf('const applyMix = useCallback')
  const mixEnd = raw.indexOf('const setProject = useCallback')
  assert.ok(mixStart > 0 && mixEnd > mixStart, 'applyMix is where the test expects it')
  const applyMix = raw.slice(mixStart, mixEnd)
  assert.match(applyMix, /panLeft\?\.gain\.setTargetAtTime/, 'applyMix ramps the left pan gain too')
  assert.match(applyMix, /panRight\?\.gain\.setTargetAtTime/, 'and the right one')
  assert.match(applyMix, /panGains\(/, 'using the shared law')
  const schedule = raw.slice(raw.indexOf('export function scheduleClips'), raw.indexOf('export function scheduleClips') + 3000)
  assert.match(schedule, /itemParams\(/, 'scheduleClips uses it as well')
})

test('preview and renderer take their parameters from the same module', () => {
  // Improvement plan 02, I-04. The point is not that the two chains agree today;
  // it is that neither may compute a gain, a pan or a fade on its own, or the
  // next FX added would have to be reconciled twice.
  const renderer = readFileSync(join(root, 'src', 'project', 'render.js'), 'utf8')
  const preview = readFileSync(join(root, 'src', 'client', 'clipbay', 'audio.js'), 'utf8')
  for (const [name, source] of [['render.js', renderer], ['audio.js', preview]]) {
    assert.match(source, /from '\.\.\/client\/clipbay\/mix-params\.js'|from '\.\/mix-params\.js'/, `${name} imports mix-params`)
    assert.match(source, /itemParams\(/, `${name} reads clip parameters from it`)
    assert.match(source, /masterParams\(/, `${name} reads the bus gain from it`)
    // The two offenders from the first version: a hand-rolled dB conversion and
    // a hand-rolled fader sum. Neither may come back.
    assert.doesNotMatch(source, /10 \*\* \(\s*[^)]*\/ 20\)/, `${name} must not restate dB → gain`)
    assert.doesNotMatch(source, /normalizeGainDb\)? \|\| 0\) \+ \(Number\(project\.masterFaderDb/, `${name} must not restate the fader sum`)
  }
  // The renderer must not keep a second solo/mute filter either.
  assert.match(renderer, /resolveTrackGain\(/, 'the renderer takes the track gain from the shared module')
})

test('pan is described in the labels the user reads', () => {
  // The user asked for the meaning next to the word: -1 and 1 are not obvious.
  const i18n = readFileSync(join(root, 'src', 'client', 'i18n.js'), 'utf8')
  assert.match(i18n, /'声像 \(-1=极左, 1=极右\)'/, 'the pan label spells out both ends')
})

test('contentEnd is the last clip end, and ignores the picture', () => {
  // Improvement plan 03, I-44. The transport asks one question of this number:
  // "is anything left to play from here". A 60 s video whose audio stops at 59 s
  // must not make the silent last second count as content.
  assert.equal(contentEnd({ tracks: [] }), 0, 'an empty project ends at zero')
  assert.equal(contentEnd(null), 0, 'and so does a missing one')
  const project = {
    video: { durationSec: 60 },
    tracks: [
      track({ id: 'a', items: [item({ id: 'a1', startSec: 0, inSec: 0, outSec: 50 })] }),
      track({ id: 'b', items: [item({ id: 'b1', startSec: 50, inSec: 55, outSec: 64 })] }),
    ],
  }
  close(contentEnd(project), 59, 'the last clip ends at 50 + (64 - 55)')
  const trimmed = { tracks: [track({ items: [item({ startSec: 10, inSec: 4, outSec: 4.5 })] })] }
  close(contentEnd(trimmed), 10.5, 'a short clip at 10 s ends at 10.5 s')
})

test('a press at or past the end plays from the start', () => {
  // I-44: playback ran to its end, parked the playhead there, and every later
  // press scheduled nothing — the button blinked and nothing moved.
  const project = { tracks: [track({ items: [item({ startSec: 0, inSec: 0, outSec: 59 })] })] }
  close(playbackStart(project, 0), 0, 'the start is the start')
  close(playbackStart(project, 53.3), 53.3, 'inside the content it seeks there')
  close(playbackStart(project, 59), 0, 'exactly at the end replays')
  close(playbackStart(project, 60), 0, 'past the end replays too')
  close(playbackStart(project, 59.3), 0, 'the measured stuck position replays')
  // No content at all: return what was asked and let the empty schedule speak.
  close(playbackStart({ tracks: [] }, 12), 12, 'an empty project is left alone')
  close(playbackStart(null, 3), 3, 'and a missing one too')
})

test('the picture is started once per play, not once per frame', () => {
  // Improvement plan 03, I-47. The follow-the-clock effect runs on every position
  // tick and used to call node.play() each time — measured 51 times a second on an
  // already-playing element. It bought nothing (the second effect starts the
  // picture) and it hid a real autoplay failure behind a retry storm.
  const preview = readFileSync(join(root, 'src', 'client', 'clipbay', 'preview.js'), 'utf8')
  const calls = preview.split('\n').filter((line) => line.includes('.play()') && !line.trim().startsWith('*'))
  assert.equal(calls.length, 1, `exactly one play() call may remain, found ${calls.length}`)
  const secondEffect = preview.slice(preview.indexOf('}, [playing, hasVideo])') - 400)
  assert.ok(secondEffect.includes('.play()'), 'and it lives in the effect that depends on [playing, hasVideo]')
  const firstEffect = preview.slice(preview.indexOf('}, [positionSec, playing, hasVideo, seekTo])') - 700, preview.indexOf('}, [positionSec, playing, hasVideo, seekTo])'))
  assert.ok(!firstEffect.includes('.play()'), 'the per-frame effect must only seek')
})

test('playback rewinds when it runs out, so the press is never dead', () => {
  // Both halves of I-44 are load-bearing: rewinding on natural stop removes the
  // bad state, and the guard in play() handles a playhead dragged into it.
  const raw = readFileSync(join(root, 'src', 'client', 'clipbay', 'audio.js'), 'utf8')
  assert.match(raw, /const start = wrap \? playbackStart\(project, asked\) : Math\.min\(asked, contentEnd\(project\)\)/, 'play() asks the shared helper where to start, and a seek clamps instead of wrapping')
  const tail = raw.slice(raw.indexOf('if (at >= fromRef.current + total)'))
  assert.match(tail.slice(0, 900), /fromRef\.current = 0/, 'running out resets the playhead')
  assert.match(tail.slice(0, 900), /setPositionEverywhere\(0\)/, 'and the visible position with it')
  assert.equal(/fromRef\.current = start \+ total/.test(raw), false, 'the old park-at-the-end write is gone')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
