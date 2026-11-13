/**
 * Every function a browser module calls has to come from somewhere.
 *
 * `applyDuckCurve` was called in `clipbay/audio.js` for months while its import
 * was missing: the bundler treats an unknown name as a global, the build stayed
 * green, and the only symptom was a ReferenceError thrown mid-schedule — the
 * preview went silent from the first clip with a duck effect, the playhead
 * froze, and the export was fine because it is a different code path.
 *
 * This test is the one that would have caught it: a name exported by a sibling
 * module and *called* here, but neither imported nor declared here, is a bug.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const dirs = [
  join(root, 'src', 'client'),
  join(root, 'src', 'client', 'clipbay'),
  join(root, 'src', 'audio'),
]

const files = []
for (const dir of dirs) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js')) continue
    files.push(join(dir, name))
  }
}

/** `export function x` and `export const x =` in one file. */
function exportedNames(source) {
  const names = new Set()
  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1])
  for (const match of source.matchAll(/^export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1])
  // `export { a, b as c }` — the exported name is what follows `as`.
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const pieces = part.trim().split(/\s+as\s+/)
      const name = (pieces[1] ?? pieces[0] ?? '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  return names
}

/** Names bound locally: imports, declarations, parameters we cannot see. */
function localNames(source) {
  const names = new Set()
  for (const match of source.matchAll(/^import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/gm)) {
    if (match[1]) names.add(match[1])
    for (const part of (match[2] ?? '').split(',')) {
      const pieces = part.trim().split(/\s+as\s+/)
      const name = (pieces[1] ?? pieces[0] ?? '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  for (const match of source.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  for (const match of source.matchAll(/(?:^|\s)(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  return names
}

const exported = new Map()
for (const file of files) {
  for (const name of exportedNames(readFileSync(file, 'utf8'))) {
    if (!exported.has(name)) exported.set(name, [])
    exported.get(name).push(file)
  }
}

/** Strip comments so a name mentioned in prose is not mistaken for a call. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const problems = []
for (const file of files) {
  const source = stripComments(readFileSync(file, 'utf8'))
  const local = localNames(source)
  const seen = new Set()
  // A call site, not a definition, not a property of something else.
  for (const match of source.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]
    if (local.has(name) || seen.has(name)) continue
    const owners = exported.get(name)
    if (!owners) continue
    // A same-file export is also a local declaration, caught above.
    if (owners.every((owner) => owner === file)) continue
    seen.add(name)
    const line = source.slice(0, match.index).split('\n').length
    problems.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${line} calls ${name}(), which is exported by ${owners.map((owner) => owner.split(/[\\/]/).slice(-2).join('/')).join(', ')} but not imported here`)
  }
}

assert.deepEqual(problems, [], `calls to names this module never imports:\n  ${problems.join('\n  ')}`)

console.log('ok   every exported name a module calls is imported by it')
