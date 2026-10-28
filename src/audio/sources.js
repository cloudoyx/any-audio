const SOURCE_KINDS = new Map()

function define(kind) {
  SOURCE_KINDS.set(kind.id, { status: 'stable', extensions: [], redistributable: false, ...kind })
}

define({
  id: 'soundfont',
  label: 'SoundFont bank',
  extensions: ['.sf2', '.sf3', '.dls'],
  renderer: 'spessasynth_core',
  description: 'Sampled instruments in one file. Drums live on bank 128, channel 10.',
})

define({
  id: 'procedural',
  label: 'Procedural sound',
  renderer: 'built-in',
  redistributable: true,
  description: 'Synthesised at render time from noise, filters and envelopes; no samples on disk.',
})

define({
  id: 'sample-pack',
  label: 'Sample pack',
  status: 'planned',
  extensions: ['.wav', '.flac', '.ogg'],
  description: 'One-shots and loops for sound design and percussion; needs a sampler layer.',
})

define({
  id: 'voice',
  label: 'Voice / narration renderer',
  status: 'planned',
  extensions: ['.wav', '.mp3'],
  description: 'TTS or recorded narration as a first-class timeline source instead of a file path.',
})

export function listSourceKinds() {
  return [...SOURCE_KINDS.values()].map((kind) => ({ ...kind, extensions: [...kind.extensions] }))
}

export function getSourceKind(id) {
  return SOURCE_KINDS.get(id) ?? null
}

export function registerSourceKind(kind) {
  if (!kind?.id) throw new Error('source kind needs an id')
  define({ status: 'planned', ...kind })
}

export function sourceKindsByStatus(status) {
  return listSourceKinds().filter((kind) => kind.status === status)
}
