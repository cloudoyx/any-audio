/**
 * AnyAudio — browser half.
 *
 * One plugin package gets exactly one client file: DSH reads
 * `exports["./client"]` and hands that single file to the browser. Both the
 * settings page (a `settings.section`) and the clip bay (a global panel) must
 * therefore live in the same bundle, which is what scripts/build-client.mjs
 * produces from this folder.
 *
 * `inject` lists the DSH client services this plugin reads. `slots` is the
 * registration surface; `locale` is the shell's language, which the settings page
 * uses only to decide its own display language.
 */
import { h } from './ui.js'
import { Page, FontsTab, FxLibTab } from './settings.js'
import { Guide, primeOnboardingConfig, ONBOARDING_VERSION, onboardedVersion } from './onboarding.js'
import { ClipBayPanel, CLIP_BAY_ID } from './clipbay/panel.js'
import { detectLanguage, resolveLanguage, setLanguagePreference, translate } from './i18n.js'
import { api } from './api.js'
import { bytes } from './ui.js'

export const name = 'any-audio'
export const inject = ['slots', 'locale']

function apply(ctx) {
  // The shell's locale service is the live answer to "what language is the
  // interface in right now". The plugin has its own preference (`ui.language`),
  // but on "auto" it has to follow this instead of guessing from `navigator` at
  // load time: every other tab switches the moment the setting changes, and a
  // clip bay that needs a refresh looks broken next to them (2026-11-10).
  const locale = ctx.get('locale')

  // The tab label is a thunk the shell calls on its own schedule — outside any
  // component, and before the panel has ever mounted. So the preference is read
  // here, once, from the plugin's own config, and the label resolves the
  // language on every call rather than trusting a module variable a mounted
  // component happened to set. Without this the tab stayed 剪辑台 after the rest
  // of the interface had switched to English.
  api('/state')
    .then((data) => {
      setLanguagePreference(data.config?.ui?.language || 'auto')
      // The onboarding slot mounts before this request could finish, so the
      // config is handed over as soon as it arrives: without it the guide would
      // flash for someone who finished it months ago.
      primeOnboardingConfig(data.config)
    })
    .catch(() => {})

  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'any-audio',
      order: 210,
      label: () => 'AnyAudio',
    }, () => h(Page)))
  } catch (error) {
    console.error('[any-audio] settings section failed', error)
  }

  // The first-run guide is a `settings.onboarding` step, not a dialog of our own:
  // the shell mounts it on a blank new conversation and stops offering it once
  // `complete()` is called. The plugin still keeps its own version number,
  // because the shell's "seen" set is per page load.
  try {
    ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
      name: 'settings.onboarding',
      id: 'any-audio-setup',
      order: 50,
    }, Guide))
  } catch (error) {
    console.error('[any-audio] onboarding step failed', error)
  }

  // The clip bay is one of the Conversation Views — the same row of tabs as
  // 对话 / 轨迹 / 画廊 / 上下文 / 编队 / 记忆系统. The row is the session-scoped
  // `conversation.view` list slot, not `sidebar.panellist` (that one is the left
  // rail). `id` is the cell address the owner switches on; `label` is what the
  // tab shows, read on every projection so it follows the locale.
  try {
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: CLIP_BAY_ID,
      order: 40,
      label: () => translate(resolveLanguage(locale), '剪辑台'),
    }, (props) => h(ClipBayPanel, { ...props, locale })))
  } catch (error) {
    console.error('[any-audio] clip bay view failed', error)
  }
}

export { apply }

export const __test = { bytes, detectLanguage, Page, Guide, FontsTab, FxLibTab, ONBOARDING_VERSION, onboardedVersion, primeOnboardingConfig }
