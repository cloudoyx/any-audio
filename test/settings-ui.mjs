// Settings page and first-run guide: render the real components with a stand-in
// React and read the resulting tree. The point is the structure a person sees —
// which cards exist, which buttons exist, what the guide does when it is already
// finished — none of which the bundle-shape test can see.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
const reactDom = { createPortal: (node, container) => ({ type: 'portal', props: { node, container }, children: [] }) }

let entry
new Function('window', source)({ __ModuleLoader__: { load: (value) => { entry = value } } })
const mod = entry.factory((id) => {
  if (id === 'react') return react
  if (id === 'react-dom') return reactDom
  throw new Error(`unexpected require(${JSON.stringify(id)})`)
})

const { FontsTab, FxLibTab, Guide, ONBOARDING_VERSION, onboardedVersion, primeOnboardingConfig } = mod.__test

function strings(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) strings(child, out); return out }
  if (typeof node === 'object' && node.children) strings(node.children, out)
  return out
}

function text(node) {
  return strings(node).join(' ')
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  visit(node)
  if (node.children) walk(node.children, visit)
}

/** The first element carrying `onClick` whose visible text is exactly `label`. */
function findClickable(node, label) {
  let found = null
  walk(node, (element) => {
    if (found) return
    if (typeof element.props?.onClick !== 'function') return
    if (strings(element.children).join('') === label) found = element
  })
  return found
}

/** The card titles, in the order the page renders them. */
function titles(node, out = []) {
  walk(node, (element) => {
    if (typeof element.props?.title === 'string' && element.props.title) out.push(element.props.title)
  })
  return out
}

let passed = 0
function step(name, fn) {
  try {
    fn()
    passed++
    console.log('PASS', name)
  } catch (error) {
    console.log('FAIL', name, '—', error.message)
    process.exitCode = 1
  }
}

const fontState = {
  rows: [
    {
      name: 'GeneralUser GS.sf2',
      path: 'C:\\Users\\x\\.dsh\\anyaudio\\fonts\\GeneralUser GS.sf2',
      bytes: 32 * 1024 * 1024,
      recommendedId: 'generaluser',
      status: 'ok',
      sha256: 'a'.repeat(64),
    },
  ],
  available: [
    {
      id: 'generaluser',
      name: 'GeneralUser GS',
      bytes: 32 * 1024 * 1024,
      license: 'CC0-1.0',
      note: 'General MIDI, 32 MB',
      tagline: '通用音色，配乐够用',
      default: true,
      suggested: false,
    },
  ],
  configured: '',
  fallbackPath: 'C:\\Users\\x\\.dsh\\anyaudio\\fonts\\GeneralUser GS.sf2',
  directories: ['C:\\Users\\x\\.dsh\\anyaudio\\fonts'],
}

const fontsTree = FontsTab({ state: { fonts: fontState }, reload: () => {}, notify: () => {} })
const fontsText = text(fontsTree)

step('the sound-source page has the four sections in order', () => {
  assert.deepEqual(titles(fontsTree), ['推荐音源', '已安装', '安装音源', '音源目录'])
})

step('the sound-source page no longer offers a URL install', () => {
  assert.ok(!fontsText.includes('从网址安装'), 'the URL install block must be gone')
  assert.ok(!fontsText.includes('https://example.com/bank.sf2'), 'the URL placeholder must be gone')
})

step('the installed sound sources use the same card as the packs', () => {
  const installed = fontsTree.children.find((card) => card?.props?.title === '已安装')
  assert.ok(installed, 'the installed card is missing')
  const items = []
  walk(installed, (element) => {
    if (element.props?.style?.borderRadius === 8 && element.props?.style?.flexDirection === 'column') items.push(element)
  })
  assert.ok(items.length >= 1, 'the installed list must use the shared item card')
})

step('a fully installed recommendation list collapses to one line', () => {
  assert.ok(fontsText.includes('推荐音源已全部安装'), 'the collapsed line is missing')
  assert.ok(findClickable(fontsTree, '查看'), 'the way back into the list is missing')
  assert.ok(!fontsText.includes('下载安装'), 'nothing should still be offered for download')
})

step('a missing recommendation is offered with its one-line purpose', () => {
  const partial = {
    ...fontState,
    rows: [],
  }
  const tree = FontsTab({ state: { fonts: partial }, reload: () => {}, notify: () => {} })
  const body = text(tree)
  assert.ok(body.includes('GeneralUser GS'), 'the recommendation is missing')
  assert.ok(body.includes('通用音色，配乐够用'), 'the one-line purpose is missing')
  assert.ok(findClickable(tree, '下载安装'), 'the download button is missing')
  assert.ok(!body.includes('许可证'), 'the licence must stay behind Details')
})

step('an installed recommendation moves out of the offer list', () => {
  const second = {
    id: 'musescore-general',
    name: 'MuseScore General',
    bytes: 40 * 1024 * 1024,
    license: 'MIT',
    note: '',
    tagline: '管弦乐更完整',
    default: false,
    suggested: true,
  }
  const state = {
    ...fontState,
    available: [fontState.available[0], second],
  }
  const tree = FontsTab({ state: { fonts: state }, reload: () => {}, notify: () => {} })
  const offer = tree.children.find((card) => card?.props?.title === '推荐音源')
  const body = text(offer)
  assert.ok(!body.includes('GeneralUser GS'), 'an installed bank must not be offered again')
  assert.ok(body.includes('MuseScore General'), 'the bank that is still missing must be offered')
  assert.ok(!body.includes('全部安装'), 'the card must stay expanded while something is missing')
})

step('the licence and the checksum live behind Details', () => {
  const installed = fontsTree.children.find((card) => card?.props?.title === '已安装')
  assert.ok(!text(installed).includes('许可证'), 'the licence must not be on the card')
  assert.ok(!text(installed).includes('SHA-256'), 'the checksum must not be on the card')
  assert.ok(!text(installed).includes('校验'), 'verify must not be on the card')
  assert.ok(findClickable(installed, '详情'), 'the Details toggle is missing')
})

const fxTree = FxLibTab({ state: {}, reload: () => {}, notify: () => {} })
const fxText = text(fxTree)

step('the sound-pack page recommends BaseSFX with a download button', () => {
  assert.ok(fxText.includes('基础音效包 BaseSFX'), 'the recommended pack is missing')
  assert.ok(fxText.includes('237'), 'the sound count is missing')
  assert.ok(fxText.includes('161 MB'), 'the download size is missing')
  assert.ok(fxText.includes('CC0-1.0'), 'the licence is missing')
  assert.ok(findClickable(fxTree, '去下载'), 'the download button is missing')
})

step('the sound-pack page has the four sections in order', () => {
  assert.deepEqual(titles(fxTree), ['推荐音效包', '已安装', '安装音效包', '音效包目录'])
})

step('the sound-pack folder comes from the host, not from a literal', () => {
  const card = fxTree.children.find((element) => element?.props?.title === '音效包目录')
  assert.ok(card, 'the folder card is missing')
  // Nothing has loaded yet, so the card must say so rather than print a path the
  // frontend invented.
  assert.ok(text(card).includes('正在读取'), `the folder card must wait for the host, got "${text(card)}"`)
})

step('the guide stays closed once the version is current', () => {
  primeOnboardingConfig({ ui: { onboardedVersion: ONBOARDING_VERSION } })
  assert.equal(Guide({ complete: () => {} }), null)
})

step('the guide opens on a fresh install', () => {
  primeOnboardingConfig({ ui: { onboardedVersion: 0 } })
  const tree = Guide()
  assert.ok(tree, 'the guide must render when it has not been seen')
  assert.equal(tree.props.title, 'AnyAudio')
  assert.ok(String(tree.props.hero).endsWith('/assets/hero.webp'), `the welcome step needs its banner, got ${tree.props.hero}`)
  assert.ok(findClickable(tree, '开始'), 'the welcome step must offer a start')
  assert.ok(findClickable(tree, '跳过'), 'the welcome step must offer a skip')
})

step('skipping the guide records the version', async () => {
  primeOnboardingConfig({ ui: { onboardedVersion: 0 } })
  const calls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  try {
    const tree = Guide()
    const skip = findClickable(tree, '跳过')
    assert.ok(skip, 'the skip button is missing')
    await skip.props.onClick()
    assert.equal(calls.length, 1, `expected one config write, got ${calls.length}`)
    assert.ok(calls[0].url.endsWith('/config'), `unexpected url ${calls[0].url}`)
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.patch.ui.onboardedVersion, ONBOARDING_VERSION, 'the version must be written')
  } finally {
    globalThis.fetch = previousFetch
  }
})

step('the diagnostics tab is gone and its actions live under Advanced', () => {
  assert.ok(!source.includes('诊断'), 'the diagnostics tab must be gone')
  assert.ok(source.includes('重新播放引导'), 'replay must still be reachable')
  assert.ok(source.includes('音源搜索目录'), 'the font folders must still be reachable')
})

step('a missing or malformed version reads as zero', () => {
  assert.equal(onboardedVersion({}), 0)
  assert.equal(onboardedVersion(null), 0)
  assert.equal(onboardedVersion({ ui: { onboardedVersion: 'nope' } }), 0)
  assert.equal(onboardedVersion({ ui: { onboardedVersion: 2 } }), 2)
})

console.log(`\n${passed} steps passed`)
