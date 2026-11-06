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
import { Page } from './settings.js'
import { ClipBayPanel, ClipBayIcon, CLIP_BAY_ID } from './clipbay/panel.js'
import { detectLanguage } from './i18n.js'
import { bytes } from './ui.js'

export const name = 'any-audio'
export const inject = ['slots', 'locale']

function apply(ctx) {
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

  // The tab icon and the panel body are two slots joined by one id: the sidebar
  // owns the button and dispatches `main` with this same key.
  try {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: CLIP_BAY_ID,
      order: 40,
      label: () => '剪辑台',
    }, ClipBayIcon))
  } catch (error) {
    console.error('[any-audio] clip bay tab failed', error)
  }

  try {
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: CLIP_BAY_ID,
    }, ClipBayPanel))
  } catch (error) {
    console.error('[any-audio] clip bay panel failed', error)
  }
}

export { apply }

export const __test = { bytes, detectLanguage }
