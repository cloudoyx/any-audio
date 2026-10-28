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
mod.apply({
  slots: {
    inject: (name, fn) => {
      assert.equal(name, 'settings.section')
      fn()
    },
    register: (spec, component) => {
      sections.push({ spec, component })
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
assert.equal(mod.__test.bytes(1536), '2 KB')
assert.equal(mod.__test.bytes(42), '42 B')
assert.equal(mod.__test.bytes(1.5 * 1024 * 1024), '1.5 MB')
assert.equal(mod.__test.detectLanguage({ ui: { language: 'auto' } }), 'zh')
assert.equal(mod.__test.detectLanguage({ ui: { language: 'en' } }), 'en')
assert.equal(mod.__test.detectLanguage({ ui: { language: 'zh' } }), 'zh')

console.log('Client bundle: load, register and helpers OK')
