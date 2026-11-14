// Settings page and first-run guide: render the real components with a stand-in
// React and read the resulting tree. The point is the structure a person sees —
// which cards exist, which buttons exist, what the guide does when it is already
// finished — none of which the bundle-shape test can see.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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

const { FontsTab, FxLibTab, TtsTab, Guide, NarrationStep, ONBOARDING_VERSION, onboardedVersion, primeOnboardingConfig, primeOnboardingTts } = mod.__test
const { jobFailure, setLanguage } = mod.__test

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
  defaultPath: 'C:\\Users\\x\\.dsh\\anyaudio\\fonts\\GeneralUser GS.sf2',
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

step('the bank a render lands on is marked, even when nobody chose one', () => {
  const installed = fontsTree.children.find((card) => card?.props?.title === '已安装')
  assert.ok(text(installed).includes('当前默认'), 'the effective default must be marked')
  assert.ok(!findClickable(installed, '设为默认'), 'a row that already is the default needs no button')
  assert.ok(text(fontsTree).includes('自动选择'), 'the folder card must say the default was picked automatically')
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

step('the version was raised so an upgrade replays the guide once', () => {
  // 0.2 shipped no guide at all; anyone upgrading from it still has version 0 or
  // 1 on disk. Version 2 makes every one of them see the new narration step.
  assert.ok(ONBOARDING_VERSION >= 2, `an upgrade must be picked up, got version ${ONBOARDING_VERSION}`)
  assert.equal(onboardedVersion({ ui: { onboardedVersion: 1 } }) >= ONBOARDING_VERSION, false, 'a v1 record must not count as done')
})

step('the narration step saves the engine as soon as it is picked', async () => {
  // The page exists to settle the engine; choosing it and then closing must not
  // leave Edge in the config.
  const written = []
  const state = {
    providers: [
      { id: 'edge', label: 'Edge TTS', voices: ['zh-CN-YunjianNeural'] },
      { id: 'mimo', label: 'MiMo-V2.5-TTS', voices: ['mimo_default'] },
      { id: 'deepseek', label: 'DeepSeek TTS', voices: ['stella'] },
    ],
    mimoConfigured: false,
    deepseekConfigured: true,
  }
  const tree = NarrationStep({
    tts: state, engine: 'edge', note: '', busy: '', keyInput: '',
    onPick: (value) => { written.push(value) },
    onKeyInput: () => {}, onSaveKey: () => {}, onClose: () => {}, onNext: () => {},
  })
  const selects = []
  walk(tree, (element) => { if (Array.isArray(element.props?.options)) selects.push(element) })
  assert.equal(selects.length, 1, 'the engine list should be one dropdown')
  selects[0].props.onChange('deepseek')
  assert.deepEqual(written, ['deepseek'], `picking an engine must call back at once, got ${JSON.stringify(written)}`)
})

step('the narration step tells the truth about each engine', () => {
  const base = (overrides = {}) => ({
    providers: [
      { id: 'edge', label: 'Edge TTS', voices: ['zh-CN-YunjianNeural'] },
      { id: 'mimo', label: 'MiMo-V2.5-TTS', voices: ['mimo_default'] },
      { id: 'deepseek', label: 'DeepSeek TTS', voices: ['stella'] },
    ],
    mimoConfigured: false,
    deepseekConfigured: true,
    ...overrides,
  })
  const render = (engine, tts) => text(NarrationStep({
    tts, engine, note: '', busy: '', keyInput: '',
    onPick: () => {}, onKeyInput: () => {}, onSaveKey: () => {}, onClose: () => {}, onNext: () => {},
  }))

  // The consequence, not the requirement: a missing key is allowed to continue,
  // and the copy has to say what happens instead.
  const mimoMissing = render('mimo', base())
  assert.ok(mimoMissing.includes('不填也能继续'), `a missing key must not read as a blocker, got "${mimoMissing}"`)
  assert.ok(mimoMissing.includes('改用别的引擎'), 'the fallback must be spelled out')
  assert.ok(!mimoMissing.includes('必须'), 'no copy may turn the key into a hard requirement')

  const mimoSaved = render('mimo', base({ mimoConfigured: true }))
  assert.ok(mimoSaved.includes('Key 已配置'), `a saved key must be confirmed, got "${mimoSaved}"`)
  assert.ok(!mimoSaved.includes('粘贴'), 'a saved key must not show the field again')

  const deepseekMissing = render('deepseek', base({ deepseekConfigured: false }))
  assert.ok(deepseekMissing.includes('未检测到 DeepSeek 账号'), 'a missing account must be reported')
  assert.ok(deepseekMissing.includes('也可以先用别的引擎'), 'and it must not block')

  assert.ok(render('edge', base()).includes('免费'), 'Edge should say it is free')
})

step('the guide runs five steps', () => {
  primeOnboardingConfig({ ui: { onboardedVersion: 0 } })
  const welcome = Guide()
  assert.equal(welcome.props.step, 1, 'the welcome step should be step 1')
  // The counter lives inside the dialog component, so it is read from the built
  // bundle rather than from the element tree.
  assert.ok(source.includes('${step} / 5'), 'the counter should say five steps')
  // Every step must be reachable: the narration step sits between the pack and
  // the finish, and each one names the step it is.
  const onboarding = readFileSync(join(root, 'src', 'client', 'onboarding.js'), 'utf8')
  for (const count of [1, 2, 3, 4, 5]) {
    assert.ok(new RegExp(`step: ${count}\\b`).test(onboarding), `step ${count} is missing its counter`)
  }
})

step('nothing still points at a tab that was renamed or removed', async () => {
  const files = [
    join(root, 'src', 'client', 'onboarding.js'),
    join(root, 'src', 'client', 'i18n.js'),
    join(root, 'src', 'skills', 'anyaudio-clipbay.md'),
    join(root, 'src', 'tools', 'sfx.js'),
    join(root, 'README.md'),
    join(root, 'README.zh-CN.md'),
  ]
  const stale = []
  for (const file of files) {
    const body = await readFile(file, 'utf8')
    for (const [line, text] of body.split('\n').entries()) {
      // The tab is "音效" (Sound effects); it was "音效包" (Sound packs) before.
      if (/AnyAudio\s*→\s*音效包|AnyAudio → Diagnostics|AnyAudio → 诊断|on the \*\*Sound packs\*\* tab/.test(text)) {
        stale.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${line + 1}`)
      }
    }
  }
  assert.deepEqual(stale, [], `these lines point at a tab that no longer exists: ${stale.join(', ')}`)
})

step('a download failure is explained in the interface language', () => {
  // The host message names the argument an agent should pass, so it stays
  // English. The page has to say the same thing in the person's own language.
  setLanguage('zh')
  const zh = jobFailure({ errorCode: 'FONT_DOWNLOAD_FAILED', error: 'download failed (fetch failed)...' })
  assert.ok(zh.startsWith('下载失败'), `the chinese message is missing, got "${zh}"`)
  assert.ok(zh.includes('代理'), 'the Chinese message must mention the proxy route')
  assert.ok(!zh.includes('fromPath'), 'jargon meant for the agent must not reach the person')

  setLanguage('en')
  const en = jobFailure({ errorCode: 'FONT_DOWNLOAD_FAILED', error: 'download failed (fetch failed)...' })
  assert.ok(en.startsWith('The download failed'), `the english message is missing, got "${en}"`)
  assert.ok(en.includes('proxy'), 'the English message must mention the proxy route')

  // An unknown reason keeps the raw text: a vague sentence would hide the cause.
  setLanguage('zh')
  const other = jobFailure({ errorCode: null, error: 'download failed with HTTP 503' })
  assert.equal(other, 'download failed with HTTP 503', 'an unknown failure must not be replaced with a generic line')
  setLanguage('zh')
})

step('the pack step leads with the download and asks for nothing', () => {
  // A fresh install has downloaded nothing, so there is no folder to paste and
  // no install to run. The step offers the three links and a skip; the folder
  // field lives in Settings, where someone returning from a slow download goes.
  const onboarding = readFileSync(join(root, 'src', 'client', 'onboarding.js'), 'utf8')
  assert.ok(onboarding.includes('建议下载基础音效包'), 'the pack step must recommend the download')
  assert.ok(onboarding.includes('现在跳过也没关系'), 'and must say skipping is fine')
  assert.ok(!onboarding.includes('把解压出来的 BaseSFX 文件夹路径粘贴到这里'), 'the guide must not ask for a folder path')
  assert.ok(!onboarding.includes("t('去下载')"), 'the two-step download reveal is gone')
  assert.ok(onboarding.includes('h(DownloadLinks, null)'), 'the three links must be on the page, not behind a button')
  // Hiding the offer once the pack is there: three download links under an
  // "已安装" notice would just be noise.
  assert.ok(/packInstalled\s*\n?\s*\?\s*null/.test(onboarding), 'the download block must hide once the pack is installed')
})

step('a failed font download still offers the button again', () => {
  // The retry condition, not the success one: a job left in the error state
  // must not hide the button the person needs to press.
  assert.ok(
    source.includes('job.status !== "error"'),
    'the guide must keep the download button after a failure',
  )
})

step('the diagnostics tab is gone and its actions live under Advanced', () => {
  assert.ok(!source.includes('诊断'), 'the diagnostics tab must be gone')
  assert.ok(source.includes('重新播放引导'), 'replay must still be reachable')
  assert.ok(source.includes('音源搜索目录'), 'the font folders must still be reachable')
})

step('the narration page is one engine picker, one voice picker and a default line', () => {
  const state = {
    config: {
      tts: {
        provider: 'edge',
        previewText: '太行、王屋二山。',
        edge: { voice: 'zh-CN-YunjianNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%', proxy: '' },
        mimo: { voice: 'mimo_default', model: 'mimo-v2.5-tts', baseUrl: 'https://api.xiaomimimo.com/v1', proxy: '', timeoutSec: 120 },
        deepseek: { voice: 'stella', baseUrl: 'https://api.deepseek.com', proxy: '', timeoutSec: 120 },
      },
    },
    tts: {
      providers: [
        { id: 'edge', label: 'Edge TTS', requiresKey: false, voices: ['zh-CN-YunjianNeural', 'zh-CN-XiaoxiaoNeural'] },
        { id: 'mimo', label: 'MiMo-V2.5-TTS', requiresKey: true, voices: ['mimo_default', '冰糖'] },
        { id: 'deepseek', label: 'DeepSeek TTS', requiresKey: true, voices: ['stella', 'tide'] },
      ],
      mimoConfigured: true,
      deepseekConfigured: true,
    },
  }
  const tree = TtsTab({ state, reload: () => {}, notify: () => {} })
  const body = text(tree)
  const labels = []
  walk(tree, (element) => { if (typeof element.props?.label === 'string') labels.push(element.props.label) })
  assert.ok(labels.includes('引擎'), `the engine picker is missing, labels were ${JSON.stringify(labels)}`)
  assert.ok(labels.includes('音色'), 'the voice picker is missing')
  assert.ok(body.includes('当前默认：Edge TTS · zh-CN-YunjianNeural'), `the current default is missing, got "${body}"`)
  assert.ok(findClickable(tree, '保存为默认配置'), 'the save button is missing')
  // The engine is a dropdown, not a radio group: a new engine must not need a
  // new control.
  const selects = []
  walk(tree, (element) => { if (Array.isArray(element.props?.options)) selects.push(element) })
  assert.equal(selects.length, 2, `expected two dropdowns, got ${selects.length}`)
  assert.deepEqual(selects[0].props.options.map((option) => option.value), ['edge', 'mimo', 'deepseek'])
  assert.deepEqual(selects[1].props.options.map((option) => option.value), ['zh-CN-YunjianNeural', 'zh-CN-XiaoxiaoNeural'])
})

step('the deepseek engine shows a readiness line and no key field', () => {
  // Its key is the DSH sign-in, so an input here would be a lie: a person who is
  // logged in already has it, and clearing it would break model access too.
  const base = (deepseekConfigured) => ({
    config: {
      tts: {
        provider: 'deepseek',
        previewText: '太行、王屋二山。',
        edge: { voice: 'zh-CN-YunjianNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%', proxy: '' },
        mimo: { voice: 'mimo_default', model: 'mimo-v2.5-tts', baseUrl: 'https://api.xiaomimimo.com/v1', proxy: '', timeoutSec: 120 },
        deepseek: { voice: 'stella', baseUrl: 'https://api.deepseek.com', proxy: '', timeoutSec: 120 },
      },
    },
    tts: {
      providers: [
        { id: 'edge', label: 'Edge TTS', requiresKey: false, voices: ['zh-CN-YunjianNeural'] },
        { id: 'mimo', label: 'MiMo-V2.5-TTS', requiresKey: true, voices: ['mimo_default'] },
        { id: 'deepseek', label: 'DeepSeek TTS', requiresKey: true, voices: ['stella', 'tide'] },
      ],
      mimoConfigured: true,
      deepseekConfigured,
    },
  })
  const ready = text(TtsTab({ state: base(true), reload: () => {}, notify: () => {} }))
  assert.ok(ready.includes('使用本机 DeepSeek 账号，无需配置'), `the readiness line is missing, got "${ready}"`)
  assert.ok(!ready.includes('粘贴 Open Platform API Key'), 'the deepseek page must not offer a key field')
  assert.ok(!ready.includes('Key 未配置'), 'the deepseek page must not show the mimo key state')
  const missing = text(TtsTab({ state: base(false), reload: () => {}, notify: () => {} }))
  assert.ok(missing.includes('未检测到 DeepSeek 账号'), `a missing account is not reported, got "${missing}"`)
  assert.ok(missing.includes('先登录 DSH 才能试听 DeepSeek'), 'the preview hint is missing when there is no account')
})

step('every dropdown goes through the shared Select', () => {
  // A raw <select> is drawn by the browser, so its list stays white while the
  // text stays light: the voice list and the preset list both shipped that way.
  // One component owns the fix; nothing else may build a dropdown.
  const files = []
  const walkDir = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walkDir(full)
      else if (entry.name.endsWith('.js')) files.push(full)
    }
  }
  walkDir(join(root, 'src', 'client'))
  const offenders = files
    .filter((file) => !file.endsWith(join('client', 'ui.js')))
    .filter((file) => /h\('select'/.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(root.length + 1))
  assert.deepEqual(offenders, [], `a raw <select> bypasses the theme fix: ${offenders.join(', ')}`)
})

step('every t() key has an English translation', () => {
  // A key with no EN entry silently stays Chinese in English mode, which is
  // invisible to anyone testing in Chinese.
  const files = []
  const walkDir = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walkDir(full)
      else if (entry.name.endsWith('.js')) files.push(full)
    }
  }
  walkDir(join(root, 'src', 'client'))
  const used = new Set()
  for (const file of files) {
    const body = readFileSync(file, 'utf8')
    for (const match of body.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) used.add(match[1].replace(/\\'/g, "'"))
  }
  const i18n = readFileSync(join(root, 'src', 'client', 'i18n.js'), 'utf8')
  const start = i18n.indexOf('export const EN = {')
  const end = i18n.indexOf('\n}', start)
  const en = new Set()
  for (const match of i18n.slice(start, end).matchAll(/^\s*'((?:[^'\\]|\\.)*)':\s*'(?:[^'\\]|\\.)*',?\s*$/gm)) {
    en.add(match[1].replace(/\\'/g, "'"))
  }
  const missing = [...used].filter((key) => !en.has(key))
  assert.deepEqual(missing, [], `these keys have no English translation: ${missing.join(' | ')}`)
})

step('a missing or malformed version reads as zero', () => {
  assert.equal(onboardedVersion({}), 0)
  assert.equal(onboardedVersion(null), 0)
  assert.equal(onboardedVersion({ ui: { onboardedVersion: 'nope' } }), 0)
  assert.equal(onboardedVersion({ ui: { onboardedVersion: 2 } }), 2)
})

console.log(`\n${passed} steps passed`)
