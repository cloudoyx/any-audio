/**
 * First-run guide.
 *
 * DSH owns the trigger: a `settings.onboarding` step is mounted on a blank new
 * conversation, in `order`, until the shell has seen it. That "seen" set lives in
 * the page, so it resets the moment the person types — which is why the guide
 * keeps its own `ui.onboardedVersion` in the plugin config and closes itself when
 * that number is already current.
 *
 * The step draws its own modal: the shell's modal primitive is not part of the
 * plugin API, and the guide has to be dismissable (Esc, click outside) rather
 * than a wall the person cannot get past.
 */
import { h, Fragment, useState, useEffect, useCallback, C, S, Btn, Select, TextInput, Notice, useSurface } from './ui.js'
import { t, jobFailure } from './i18n.js'
import { api, API } from './api.js'
import { BASE_PACK, DownloadLinks } from './base-pack.js'
import { createPortal } from 'react-dom'

/** Bump this to show the guide again after a release that adds steps. */
export const ONBOARDING_VERSION = 2

// The slot mounts before any request has finished, so the config read at plugin
// load is primed here: without it the first render would flash the guide for
// someone who finished it months ago.
let primed = null

export function primeOnboardingConfig(config) {
  primed = config ?? null
}

// The engine list arrives with the same `/state` read as the config. Priming it
// is what lets a test render the narration step without a request; in the app it
// stays null until the read lands.
let primedTts = null

export function primeOnboardingTts(tts) {
  primedTts = tts ?? null
}

export function onboardedVersion(config) {
  const value = Number(config?.ui?.onboardedVersion)
  return Number.isFinite(value) ? value : 0
}

const OVERLAY = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
}

// The dialog is portalled to `document.body`, so it inherits nothing from the
// app: a theme token guessed here is how the title and the secondary button
// ended up light-on-white in dark mode. The shell's own dialog token is used
// first, and the surface read from the DOM is the fallback for a theme that does
// not define it.
// The banner ships with the plugin and is served by the host, so the bundle
// stays small and the browser caches it like any other picture.
const HERO = `${API}/assets/hero.webp`

function dialogStyle(surface) {
  return {
    width: 'min(520px, 100%)',
    maxHeight: 'calc(100vh - 40px)',
    overflow: 'auto',
    background: `var(--dsw-alias-bg-layer-2, ${surface})`,
    border: `1px solid var(--dsw-alias-border-l2, ${C.border})`,
    borderRadius: 12,
    boxShadow: '0 18px 48px rgba(0,0,0,0.35)',
    fontSize: 13,
    lineHeight: 1.6,
  }
}

function Modal({ title, step, hero, children, onClose }) {
  const surface = useSurface()

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const root = document.getElementById('root')
    const previous = root ? root.inert : undefined
    if (root) root.inert = true
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => {
      if (root) root.inert = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    h('div', {
      style: OVERLAY,
      onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
    },
      h('div', { style: dialogStyle(surface), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        hero ? h('img', { src: hero, alt: '', style: { width: '100%', display: 'block' } }) : null,
        h('div', { style: { padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            // The banner already carries the wordmark, so the title would be the
            // same word twice in a row.
            hero ? null : h('span', { style: { fontSize: 16, fontWeight: 600 } }, title),
            h('span', { style: { ...S.mono, marginLeft: 'auto' } }, `${step} / 5`),
          ),
          children,
        ),
      ),
    ),
    document.body,
  )
}

function Actions({ children }) {
  return h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4, flexWrap: 'wrap' } }, children)
}

/**
 * Step 4: pick the narration engine.
 *
 * Separate from `Guide` so the choice can be exercised on its own. The engine is
 * saved the moment it is picked — that is the point of the page, and a person
 * who closes the dialog after choosing must not find Edge still selected.
 */
export function NarrationStep({ tts, engine, note, busy, keyInput, onPick, onKeyInput, onSaveKey, onClose, onNext }) {
  const engines = tts?.providers ?? []
  const mimoReady = Boolean(tts?.mimoConfigured)
  const deepseekReady = Boolean(tts?.deepseekConfigured)
  return h(Modal, { title: t('配音引擎'), step: 4, onClose },
    h('p', { style: S.desc }, t('给视频或有声书配旁白的引擎。现在就选好，之后不用再找我。')),
    engines.length
      ? h(Select, {
        value: engine,
        onChange: onPick,
        options: engines.map(item => ({ value: item.id, label: item.label })),
      })
      : null,
    engine === 'edge'
      ? h('p', { style: S.desc }, t('免费，不需要账号，中文旁白够用。'))
      : null,
    engine === 'deepseek'
      ? h('p', { style: S.desc }, deepseekReady
        ? t('使用本机 DeepSeek 账号，无需配置。只有两个音色，不能调语速。')
        : t('未检测到 DeepSeek 账号，登录 DSH 之后才能用；也可以先用别的引擎。'))
      : null,
    engine === 'mimo'
      ? h(Fragment, null,
        h('p', { style: S.desc }, mimoReady
          ? t('Key 已配置，可以直接用。')
          : t('MiMo 需要一个 API Key。不填也能继续，但 agent 到时候会改用别的引擎。')),
        mimoReady
          ? null
          : h('div', { style: S.row },
            h(TextInput, { value: keyInput, placeholder: t('粘贴 Open Platform API Key'), onChange: onKeyInput, type: 'password' }),
            h(Btn, { kind: 'primary', disabled: !String(keyInput ?? '').trim() || busy === 'key', onClick: onSaveKey }, t('保存')),
          ),
      )
      : null,
    note ? h(Notice, null, note) : null,
    h(Actions, null,
      h(Btn, { onClick: onNext }, t('下一步')),
    ),
  )
}

export function Guide() {
  const [config, setConfig] = useState(primed)
  const [step, setStep] = useState(0)
  const [fonts, setFonts] = useState(null)
  const [packs, setPacks] = useState(null)
  const [tts, setTts] = useState(primedTts)
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  // The engine is written to the config the moment it is picked, so the guide
  // never has to ask again; `engine` mirrors it locally to re-render.
  const [engine, setEngine] = useState(() => String(primed?.tts?.provider ?? 'edge'))
  const [keyInput, setKeyInput] = useState('')

  useEffect(() => {
    // Always re-read, even when the primed value is present: the config can
    // change while this component is mounted (the replay button in Settings
    // writes it), and a value captured at plugin load would keep the guide
    // closed for the rest of the page's life.
    let cancelled = false
    api('/state')
      .then((data) => {
        if (cancelled) return
        if (data?.config) {
          setConfig(data.config)
          setEngine(String(data.config?.tts?.provider ?? 'edge'))
        }
        if (data?.tts) setTts(data.tts)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // The replay button lives in another component, so it reaches us through an
  // event rather than a page reload.
  useEffect(() => {
    const onReset = () => setConfig(current => ({
      ...(current ?? {}),
      ui: { ...(current?.ui ?? {}), onboardedVersion: 0 },
    }))
    window.addEventListener('anyaudio:onboarding-reset', onReset)
    return () => window.removeEventListener('anyaudio:onboarding-reset', onReset)
  }, [])

  useEffect(() => {
    if (!config || onboardedVersion(config) >= ONBOARDING_VERSION) return
    api('/state').then((data) => setFonts(data.fonts)).catch(() => setFonts({ rows: [] }))
    api('/sfx/packs').then((data) => setPacks(data.packs ?? [])).catch(() => setPacks([]))
  }, [config])

  // The sound-source install runs on the host, so the guide only watches it:
  // closing the dialog must not cancel a download that is already under way.
  // The pack install no longer starts from here — that is a download the person
  // does in their browser — so only the font job has to be polled.
  useEffect(() => {
    if (!job || job.status !== 'running') return undefined
    const timer = setInterval(async () => {
      try {
        const data = await api(`/jobs?id=${encodeURIComponent(job.id)}`)
        setJob(data.job)
        if (data.job.status === 'done') {
          setNote(t('音源已安装'))
          api('/state').then((state) => setFonts(state.fonts)).catch(() => {})
        }
        if (data.job.status === 'error') setNote(jobFailure(data.job))
      } catch {
        setJob(null)
      }
    }, 700)
    return () => clearInterval(timer)
  }, [job])

  // `complete()` is deliberately not called. The shell keeps its own "seen" set
  // in page state and stops mounting a step once it is in there, which would
  // make the replay button do nothing until the page is reloaded. Leaving the
  // step mounted costs one request per blank conversation and lets this
  // component own the decision, so replay works immediately.
  const finish = useCallback(async () => {
    try {
      await api('/config', { method: 'POST', body: { patch: { ui: { onboardedVersion: ONBOARDING_VERSION } } } })
      setConfig(current => ({
        ...(current ?? {}),
        ui: { ...(current?.ui ?? {}), onboardedVersion: ONBOARDING_VERSION },
      }))
    } catch {
      // A failed write must not trap the person behind the dialog; the next
      // conversation simply offers the guide again.
    }
  }, [])

  const seen = onboardedVersion(config) >= ONBOARDING_VERSION
  if (!config || seen) return null

  async function installFont() {
    setBusy('font')
    try {
      const data = await api('/sources/install', { method: 'POST', body: { id: 'generaluser' } })
      setJob(data.job)
      setNote(t('正在下载，可以直接进入下一步'))
    } catch (error) {
      setNote(error.message)
    } finally {
      setBusy('')
    }
  }

  /**
   * Picking an engine is the whole point of the narration step, so it is saved
   * at once rather than on the way out: a person who closes the dialog after
   * choosing must not find Edge still selected in Settings. A failed write is
   * reported but does not block, because the choice can be repeated there.
   */
  async function pickEngine(next) {
    setEngine(next)
    setNote('')
    try {
      await api('/config', { method: 'POST', body: { patch: { tts: { provider: next } } } })
    } catch (error) {
      setNote(error.message)
    }
  }

  async function saveKey() {
    const value = keyInput.trim()
    if (!value) return
    setBusy('key')
    try {
      await api('/credentials/set', { method: 'POST', body: { provider: 'mimo', value } })
      setKeyInput('')
      const data = await api('/state')
      if (data?.tts) setTts(data.tts)
      setNote(t('Key 已保存'))
    } catch (error) {
      setNote(error.message)
    } finally {
      setBusy('')
    }
  }

  const fontInstalled = Boolean(fonts?.rows?.length)
  const packInstalled = Boolean(packs?.some((pack) => pack.id === BASE_PACK.id))
  const percent = job && job.total ? Math.round((job.received / job.total) * 100) : 0
  // The note belongs to the step that produced it: a download message from the
  // sound-source step must not follow the person into the pack step.
  const goTo = (next) => { setNote(''); setStep(next) }

  if (step === 0) {
    return h(Modal, { title: 'AnyAudio', step: 1, hero: HERO, onClose: finish },
      h('p', { style: S.desc }, t('让 agent 帮你写谱、配音、加音效，最后在剪辑台上试听和微调。')),
      h('p', { style: S.desc }, t('它本身不带音源和音效包，需要装一次，大概 2 分钟。')),
      h(Actions, null,
        h(Btn, { onClick: finish }, t('跳过')),
        h(Btn, { kind: 'primary', onClick: () => goTo(1) }, t('开始')),
      ),
    )
  }

  if (step === 1) {
    return h(Modal, { title: t('装音源'), step: 2, onClose: finish },
      h('p', { style: S.desc }, t('乐器声音来自这里。装一套 GeneralUser GS（32 MB）——通用音色，配乐够用。')),
      fontInstalled ? h(Notice, null, t('已安装 {0} 个音源', fonts.rows.length)) : null,
      job ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('span', { style: S.label }, job.status === 'running' ? `${t('正在安装')} ${percent}%` : job.status === 'done' ? t('完成：{0}', job.message || t('已安装')) : t('失败：{0}', job.error || '')),
        ),
        h('div', { style: S.bar }, h('div', { style: S.barFill(percent) })),
      ) : null,
      note ? h(Notice, null, note) : null,
      h(Actions, null,
        fontInstalled || (job && job.status !== 'error') ? null : h(Btn, { kind: 'primary', disabled: busy === 'font', onClick: installFont }, t('下载安装')),
        h(Btn, { onClick: () => goTo(2) }, fontInstalled || job ? t('下一步') : t('跳过')),
      ),
    )
  }

  if (step === 2) {
    // A fresh install has downloaded nothing yet, so the page leads with the
    // download and does not ask for a folder path: nobody has an unpacked folder
    // at this point, and offering the box reads as "you cannot continue without
    // one". The path lives in Settings, which is where someone returning from a
    // slow download will actually be.
    return h(Modal, { title: t('装音效包'), step: 3, onClose: finish },
      h('p', { style: S.desc }, t('真实录音的音效库。基础包 BaseSFX 有 {0} 条：{1}。', BASE_PACK.count, t(BASE_PACK.summary))),
      packInstalled ? h(Notice, null, t('已安装')) : null,
      packInstalled
        ? null
        : h(Fragment, null,
          h('p', { style: S.desc }, t('建议下载基础音效包，音效的真实感会明显提升。解压后在「设置 → AnyAudio → 音效」里把文件夹装进来即可，现在跳过也没关系。')),
          h(DownloadLinks, null),
        ),
      note ? h(Notice, null, note) : null,
      h(Actions, null,
        h(Btn, { onClick: () => goTo(3) }, packInstalled ? t('下一步') : t('跳过')),
      ),
    )
  }

  if (step === 3) {
    return h(NarrationStep, {
      tts, engine, note, busy, keyInput,
      onPick: pickEngine,
      onKeyInput: setKeyInput,
      onSaveKey: saveKey,
      onClose: finish,
      onNext: () => goTo(4),
    })
  }

  return h(Modal, { title: t('完成'), step: 5, onClose: finish },
    h('p', { style: S.desc }, t('以后在「设置 → AnyAudio」里改。')),
    h('p', { style: S.desc }, t('剪辑台在对话上方的标签栏里。')),
    h('p', { style: S.desc }, t('也可以直接对 agent 说「帮我配一段音乐」，它会自己找。')),
    h(Actions, null,
      h(Btn, { kind: 'primary', onClick: finish }, t('开始使用')),
    ),
  )
}
