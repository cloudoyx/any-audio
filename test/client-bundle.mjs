import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')

assert.ok(!/^\s*import\s/m.test(source), 'lib/client.js must stay a plain ModuleLoader bundle (no ESM imports)')
assert.ok(!/^\s*export\s/m.test(source), 'lib/client.js must stay a plain ModuleLoader bundle (no ESM exports)')
assert.equal(source.match(/__ModuleLoader__\.load\(/g)?.length, 1, 'expected exactly one __ModuleLoader__.load call')

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

let entry
const windowStub = { __ModuleLoader__: { load: (value) => { entry = value } } }
// `document` is touched only when the page renders in English; the bundle module
// itself must still evaluate without a DOM.
new Function('window', source)(windowStub)

assert.ok(entry, 'bundle did not call __ModuleLoader__.load')
assert.equal(entry.id, 'dsh-any-audio')

const mod = entry.factory((id) => {
  if (id === 'react') return react
  throw new Error(`unexpected require(${JSON.stringify(id)})`)
})
assert.equal(mod.name, 'any-audio')
assert.deepEqual(mod.inject, ['slots', 'locale'])

const sections = []
const views = []
mod.apply({
  slots: {
    inject: (name, fn) => { fn() },
    register: (spec, component) => {
      if (spec.name === 'settings.section') sections.push({ spec, component })
      else if (spec.name === 'conversation.view') views.push({ spec, component })
      return () => {}
    },
  },
})

assert.equal(sections.length, 1, 'expected one settings section')
const [section] = sections
assert.equal(section.spec.name, 'settings.section')
assert.equal(section.spec.id, 'any-audio')
assert.equal(section.spec.order, 210)
assert.equal(typeof section.spec.label, 'function')
assert.equal(section.spec.label(), 'AnyAudio')
assert.equal(typeof section.component, 'function', 'section must render a component')

// The clip bay lives in the same tab row as 对话 / 轨迹 / 画廊 / 上下文 / 编队 /
// 记忆系统, which is the session-scoped `conversation.view` list slot.
assert.equal(views.length, 1, 'expected one clip bay view')
assert.equal(views[0].spec.id, 'clip-bay')
assert.equal(typeof views[0].component, 'function', 'the view must render a component')
assert.equal(typeof views[0].spec.label, 'function', 'the tab label must be a thunk so it follows the locale')
assert.equal(views[0].spec.label(), '剪辑台')
assert.ok(Number.isFinite(views[0].spec.order), 'the view needs an order to sit at a stable place in the row')

assert.equal(mod.__test.bytes(1536), '2 KB')
assert.equal(mod.__test.bytes(42), '42 B')
assert.equal(mod.__test.bytes(1.5 * 1024 * 1024), '1.5 MB')
assert.equal(mod.__test.detectLanguage({ ui: { language: 'auto' } }), 'zh')
assert.equal(mod.__test.detectLanguage({ ui: { language: 'en' } }), 'en')
assert.equal(mod.__test.detectLanguage({ ui: { language: 'zh' } }), 'zh')

console.log('Client bundle: load, register and helpers OK')
