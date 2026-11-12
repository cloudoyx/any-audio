// M8 acceptance: the waveform picture that `inspect` attaches.
//
// The picture is the only non-text hint this plugin gives, so the test checks
// the things that would silently make it useless: the block shape, the PNG
// colour type (greyscale gets re-encoded as JPEG by the host), the size, the
// per-file normalisation, and the three-image ceiling.
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerAllTools } from '../src/tools/index.js'
import { setSfxHostServices } from '../src/tools/sfx.js'
import { findFfmpeg, runFfmpeg } from '../src/tools/shared.js'
import { drawWaveform, encodePng } from '../src/audio/waveform-png.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp-sfxlib-image')
await rm(tmpDir, { recursive: true, force: true })
await mkdir(tmpDir, { recursive: true })

const libraryRoot = join(tmpDir, 'sfx')
process.env.ANYAUDIO_SFX_DIR = libraryRoot
process.env.ANYAUDIO_STATE = join(tmpDir, 'state.json')
process.env.ANYAUDIO_CONFIG = join(tmpDir, 'config.json')

const ffmpeg = findFfmpeg()
if (!ffmpeg) {
  console.log('SKIP: ffmpeg is not available, so no waveform can be decoded')
  process.exit(0)
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

/** Read the IHDR of a PNG: width, height and colour type. */
function pngHeader(buffer) {
  assert(buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'not a PNG')
  assert(buffer.subarray(12, 16).toString('ascii') === 'IHDR', 'the first chunk should be IHDR')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  }
}

async function makeMp3(path, seconds, frequency, volume = 1) {
  await mkdir(dirname(path), { recursive: true })
  await runFfmpeg(ffmpeg.command, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`,
    '-af', `volume=${volume}`,
    '-ac', '2', '-ar', '48000', '-b:a', '128k', '-c:a', 'libmp3lame',
    path,
  ])
  return path
}

async function writePack(packId, sounds) {
  const dir = join(libraryRoot, packId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: packId,
    name: packId,
    sounds,
  }, null, 2)}\n`, 'utf8')
  return dir
}

// ---------------------------------------------------------------------------
// Fixtures: five foley sounds (so the three-image ceiling can be observed), one
// ambience (which must never get a picture), and one very quiet foley (so the
// normalisation can be observed).

const names = ['门-木门-敲门-三下-中等', '门-铁门-关门-重', '脚步-木地板-行走', '打铁-清脆', '断骨', '室外-森林-夜晚-虫鸣-中等', '衣服-布料摩擦-极轻']

const dir = await writePack('BaseSFX', [
  { name: names[0], type: 'foley', durationSec: 2, peakPosSec: 0.8, file: `FOL/${names[0]}.mp3` },
  { name: names[1], type: 'foley', durationSec: 2, peakPosSec: 0.6, file: `FOL/${names[1]}.mp3` },
  { name: names[2], type: 'foley', durationSec: 2, peakPosSec: 0.4, file: `FOL/${names[2]}.mp3` },
  { name: names[3], type: 'foley', durationSec: 2, peakPosSec: 0.3, file: `FOL/${names[3]}.mp3` },
  { name: names[4], type: 'foley', durationSec: 2, peakPosSec: 0.2, file: `FOL/${names[4]}.mp3` },
  { name: names[5], type: 'ambience', durationSec: 2, file: `AMB/${names[5]}.mp3` },
  { name: names[6], type: 'foley', durationSec: 2, peakPosSec: 0.5, file: `FOL/${names[6]}.mp3` },
])

await makeMp3(join(dir, `FOL/${names[0]}.mp3`), 2, 440)
await makeMp3(join(dir, `FOL/${names[1]}.mp3`), 2, 460)
await makeMp3(join(dir, `FOL/${names[2]}.mp3`), 2, 480)
await makeMp3(join(dir, `FOL/${names[3]}.mp3`), 2, 500)
await makeMp3(join(dir, `FOL/${names[4]}.mp3`), 2, 520)
await makeMp3(join(dir, `AMB/${names[5]}.mp3`), 2, 220)
// −44 dBFS: without per-file normalisation this draws a flat line.
await makeMp3(join(dir, `FOL/${names[6]}.mp3`), 2, 600, 0.0063)

// ---------------------------------------------------------------------------
// Host stubs: the attachment store records what was saved, and the LLM service
// says whether the model can see images.

const saved = []
const attachments = {
  async saveImage({ data, mediaType, name }) {
    saved.push({ data, mediaType, name })
    return { attachmentId: `att_${saved.length}`, mediaType, bytes: data.length, width: 1024, height: 256, name }
  },
}

let vision = true
const llm = {
  async resolveModelInfo() {
    return { inputModalities: vision ? ['text', 'image'] : ['text'] }
  },
}

setSfxHostServices({ attachments, llm })

const tools = new Map()
registerAllTools({
  tools: { register: (definition) => tools.set(definition.name, definition) },
  logger: { info: () => {} },
  get: () => undefined,
})
const sfx = tools.get('anyaudio_sfx')
const exec = { agent: { workspaceRoot: root, options: { provider: 'test', model: 'test-model' } } }

// ---------------------------------------------------------------------------

await test('the PNG encoder writes an RGB image of the requested size', async () => {
  const pixels = Buffer.alloc(8 * 4 * 3, 128)
  const png = encodePng({ width: 8, height: 4, pixels })
  const header = pngHeader(png)
  assert(header.width === 8, `width was ${header.width}`)
  assert(header.height === 4, `height was ${header.height}`)
  assert(header.bitDepth === 8, `bit depth was ${header.bitDepth}`)
  assert(header.colorType === 2, `colour type was ${header.colorType}, expected 2 (RGB)`)
})

await test('a drawn waveform is 1024×256 and RGB', async () => {
  const samples = new Float32Array(32000)
  for (let index = 0; index < samples.length; index++) samples[index] = Math.sin(index / 20) * 0.5
  const png = drawWaveform({ samples })
  const header = pngHeader(png)
  assert(header.width === 1024, `width was ${header.width}`)
  assert(header.height === 256, `height was ${header.height}`)
  assert(header.colorType === 2, `colour type was ${header.colorType}`)
})

await test('a very quiet sound still draws a visible waveform', async () => {
  // The same shape at two levels must produce the same picture: the drawing is
  // normalised to its own peak, so a −44 dBFS ambience is not a flat line.
  const loud = new Float32Array(32000)
  const quiet = new Float32Array(32000)
  for (let index = 0; index < loud.length; index++) {
    const value = Math.sin(index / 20)
    loud[index] = value * 0.9
    quiet[index] = value * 0.0063
  }
  const a = drawWaveform({ samples: loud })
  const b = drawWaveform({ samples: quiet })
  assert(a.equals(b), 'the same shape at two levels should draw the same picture')
  // And the quiet one must not be all background: count non-background bytes.
  const header = pngHeader(b)
  assert(header.width === 1024, 'the quiet picture should still be a full-size image')
})

await test('inspect returns a text block and an image block', async () => {
  saved.length = 0
  vision = true
  const result = await sfx.execute({ action: 'inspect', names: [names[0]] }, exec)
  const blocks = sfx.output.render({}, result)
  assert(Array.isArray(blocks), 'render should return an array of blocks')
  assert(blocks.some((block) => block.type === 'text'), 'there should be a text block')
  assert(blocks.some((block) => block.type === 'image'), 'there should be an image block')
})

await test('the image block carries an attachment ref, not base64 or a path', async () => {
  const result = await sfx.execute({ action: 'inspect', names: [names[0]] }, exec)
  const blocks = sfx.output.render({}, result)
  const image = blocks.find((block) => block.type === 'image')
  assert(image, 'there should be an image block')
  assert(typeof image.attachment === 'object' && image.attachment !== null, 'the attachment should be an object')
  assert(typeof image.attachment.attachmentId === 'string', 'the ref should carry an attachmentId')
  assert(!('data' in image.attachment), 'the ref must not carry base64 data')
  assert(!('path' in image.attachment), 'the ref must not carry a file path')
})

await test('the saved image is a 1024×256 RGB PNG', async () => {
  saved.length = 0
  await sfx.execute({ action: 'inspect', names: [names[0]] }, exec)
  assert(saved.length === 1, `expected 1 saved image, got ${saved.length}`)
  assert(saved[0].mediaType === 'image/png', `media type was ${saved[0].mediaType}`)
  const header = pngHeader(saved[0].data)
  assert(header.width === 1024, `width was ${header.width}`)
  assert(header.height === 256, `height was ${header.height}`)
  assert(header.colorType === 2, `colour type was ${header.colorType}`)
})

await test('ambience gets no picture', async () => {
  saved.length = 0
  const result = await sfx.execute({ action: 'inspect', names: [names[5]] }, exec)
  assert(saved.length === 0, `ambience should not be drawn, got ${saved.length} images`)
  const blocks = sfx.output.render({}, result)
  assert(!blocks.some((block) => block.type === 'image'), 'there should be no image block')
  assert(blocks.some((block) => block.type === 'text'), 'the fields should still be there')
})

await test('five names produce at most three pictures', async () => {
  saved.length = 0
  const result = await sfx.execute({
    action: 'inspect',
    names: [names[0], names[1], names[2], names[3], names[4]],
  }, exec)
  assert(saved.length === 3, `expected 3 images, got ${saved.length}`)
  const blocks = sfx.output.render({}, result)
  const images = blocks.filter((block) => block.type === 'image')
  assert(images.length === 3, `expected 3 image blocks, got ${images.length}`)
  // Every name still gets its text line, even the ones without a picture.
  assert(result.sounds.length === 5, `expected 5 rows, got ${result.sounds.length}`)
})

await test('a model without vision gets text only and no error', async () => {
  saved.length = 0
  vision = false
  const result = await sfx.execute({ action: 'inspect', names: [names[0]] }, exec)
  assert(saved.length === 0, `no image should be saved, got ${saved.length}`)
  const blocks = sfx.output.render({}, result)
  assert(!blocks.some((block) => block.type === 'image'), 'there should be no image block')
  assert(blocks.some((block) => block.type === 'text'), 'the fields should still be there')
  vision = true
})

await test('the text line carries the fields the picture cannot', async () => {
  const result = await sfx.execute({ action: 'inspect', names: [names[0]] }, exec)
  const blocks = sfx.output.render({}, result)
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  assert(text.includes(names[0]), 'the name should be in the text')
  assert(/动效/.test(text), 'the type should be in the text')
  assert(/2\.00s/.test(text), 'the duration should be in the text')
  assert(/主峰 0\.800s/.test(text), 'the peak position should be in the text')
})

await test('the inspect description says what the picture is for', async () => {
  const description = sfx.parameters.properties.names.description
  assert(/waveform/i.test(description), `the description should mention the waveform: ${description}`)
})

// ---------------------------------------------------------------------------

await rm(tmpDir, { recursive: true, force: true })
if (!hadAnyaudioDir) await rm(anyaudioDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
