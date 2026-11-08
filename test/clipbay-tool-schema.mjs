/**
 * Every tool definition, checked against the schema subset the host actually
 * enforces.
 *
 * The gap this closes: `anyaudio_project`'s output schema declared
 * `clip: { type: ['object', 'null'] }` so that importing a picture with no audio
 * stream — which legitimately returns `null` — would validate. The host does not
 * accept type arrays, so `defineTool()` threw, `registerAllTools` caught it and
 * logged one line, and the tool silently vanished: five registered, one missing.
 * A real session then failed with `unknown tool "anyaudio_project"` on its very
 * first call, and every test still passed, because they call `execute` and the
 * renderer directly and never go through `defineTool`.
 *
 * The rules below are transcribed from the host's own validator
 * (`assertSupportedJsonSchema`): the keyword allow-list, one single type string
 * per node, and the "type arrays are not supported" rule that started this.
 */
import assert from 'node:assert/strict'
import { TOOL_REGISTRARS } from '../src/tools/index.js'

let passed = 0
let failed = 0

async function test(name, run) {
  try {
    await run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

const KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default', 'examples',
])
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'])
const OBJECT_ONLY = ['properties', 'required', 'additionalProperties']
const ARRAY_ONLY = ['items']

function checkNode(node, path, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key)) out.push(`${path}.${key} is not a supported keyword`)
  }
  if (typeof node.description === 'string' === false && node.description !== undefined) {
    out.push(`${path}.description must be a string`)
  }

  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    out.push(`${path} cannot declare both type and oneOf`)
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of ['properties', 'items', ...OBJECT_ONLY, ...ARRAY_ONLY]) {
      if (Object.hasOwn(node, key)) out.push(`${path}.${key} requires type or oneOf`)
    }
    return
  }

  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      out.push(`${path}.oneOf must be an array of at least two schemas`)
    } else {
      node.oneOf.forEach((child, index) => checkNode(child, `${path}.oneOf[${index}]`, out))
    }
    return
  }

  const type = node.type
  if (Array.isArray(type)) {
    out.push(`${path}.type must be a single type string (type arrays are not supported)`)
    return
  }
  if (typeof type !== 'string' || !TYPES.has(type)) {
    out.push(`${path}.type must be one of ${[...TYPES].join('/')}`)
    return
  }

  for (const key of OBJECT_ONLY) {
    if (Object.hasOwn(node, key) && type !== 'object') out.push(`${path}.${key} only applies to object`)
  }
  for (const key of ARRAY_ONLY) {
    if (Object.hasOwn(node, key) && type !== 'array') out.push(`${path}.${key} only applies to array`)
  }

  if (Object.hasOwn(node, 'properties')) {
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      out.push(`${path}.properties must be an object`)
    } else {
      for (const [key, child] of Object.entries(node.properties)) {
        checkNode(child, `${path}.${key}`, out)
      }
    }
  }
  if (Object.hasOwn(node, 'items')) checkNode(node.items, `${path}[]`, out)
  if (Object.hasOwn(node, 'additionalProperties')) {
    const value = node.additionalProperties
    if (typeof value !== 'boolean') checkNode(value, `${path}.additionalProperties`, out)
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
      out.push(`${path}.required must be an array of strings`)
    }
  }
}

function violationsOf(definition) {
  const out = []
  checkNode(definition.parameters ?? {}, 'parameters', out)
  checkNode(definition.output?.schema ?? {}, 'output', out)
  return out
}

// Gather the definitions the same way the plugin does.
const definitions = []
const ctx = {
  inject: (_deps, run) => run(ctx),
  effect: (run) => run(),
  get: () => undefined,
  logger: () => {},
  tools: { register: (definition) => definitions.push(definition) },
}
for (const [name, register] of TOOL_REGISTRARS) {
  try {
    register(ctx)
  } catch (error) {
    failed++
    console.log(`FAIL ${name} threw while registering`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

await test('every declared tool registers', () => {
  const names = definitions.map((definition) => definition.name)
  const expected = TOOL_REGISTRARS.map(([name]) => name)
  assert.deepEqual(names.sort(), expected.sort())
})

await test('every tool schema fits the host subset', () => {
  assert.ok(definitions.length > 0)
  const problems = []
  for (const definition of definitions) {
    for (const violation of violationsOf(definition)) problems.push(`${definition.name}: ${violation}`)
  }
  assert.equal(problems.length, 0, problems.join('\n     '))
})

// The null branch is what made this worth checking: `mode:"add_material"` on a
// picture with no audio stream has no material and no clip to report, and the
// agent must still see a valid result rather than a rejected call.
await test('anyaudio_project accepts a null clip and material', () => {
  const definition = definitions.find((entry) => entry.name === 'anyaudio_project')
  assert.ok(definition, 'anyaudio_project must be registered')
  const properties = definition.output.schema.properties
  for (const key of ['clip', 'material']) {
    const branches = properties[key].oneOf.map((branch) => branch.type)
    assert.ok(branches.includes('object'), `${key} must still accept an object`)
    assert.ok(branches.includes('null'), `${key} must accept null`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
