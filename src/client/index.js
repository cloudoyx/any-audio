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
import { ClipBayPanel, CLIP_BAY_ID } from './clipbay/panel.js'
import { detectLanguage, t } from './i18n.js'
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
      label: () => t('剪辑台'),
    }, (props) => h(ClipBayPanel, { ...props, locale })))
  } catch (error) {
    console.error('[any-audio] clip bay view failed', error)
  }
}

export { apply }

export const __test = { bytes, detectLanguage }
