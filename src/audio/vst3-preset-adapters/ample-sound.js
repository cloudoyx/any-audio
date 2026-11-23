/**
 * Ample Sound 预设适配器。
 *
 * 预设目录：<Documents>/Ample Sound/<插件名>/Presets4/，每个预设是一个 XML
 * 文件（扩展名以 state 结尾，如 .state / .abplstate / .agmlstate），根元素
 * 属性带 Name / Category / Type / Lib。文件名与 Name 不一定相同（厂商自己的
 * 数据），所以 name 一律读 XML，不读文件名。
 *
 * 厂商名只允许出现在适配器模块里；核心 vst3-presets.js 只认抽象接口。
 */
import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

const VENDOR_DIR = 'Ample Sound'
const PRESET_DIR = 'Presets4'
// The root element and its attributes sit in the first few hundred bytes; 16 KB
// leaves room for a long attribute list without reading a whole preset file.
const HEAD_BYTES = 16 * 1024
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Documents may be redirected (OneDrive); the vendor writes to the shell's folder. */
function documentsDirs() {
  const dirs = [join(homedir(), 'Documents')]
  if (process.env.OneDrive) dirs.push(join(process.env.OneDrive, 'Documents'))
  return dirs
}

function pluginStem(pluginPath) {
  return basename(String(pluginPath ?? '')).replace(/\.vst3$/i, '')
}

/** The preset folder for this plugin, or null when the vendor has none for it. */
async function presetDirFor(pluginPath) {
  const stem = pluginStem(pluginPath)
  if (!stem) return null
  for (const documents of documentsDirs()) {
    const dir = join(documents, VENDOR_DIR, stem, PRESET_DIR)
    try {
      if ((await stat(dir)).isDirectory()) return dir
    } catch {
      // Not under this Documents folder; try the next candidate.
    }
  }
  return null
}

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Read the root element's attributes; null when the file is unreadable or not XML. */
async function readHeader(statePath) {
  let text
  try {
    const handle = await open(statePath, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  // Skip the XML declaration / comments / DOCTYPE: the first real element is the root.
  const start = text.search(/<[A-Za-z_]/)
  if (start < 0) return null
  const end = text.indexOf('>', start)
  if (end < 0) return null
  const attributes = {}
  for (const match of text.slice(start, end + 1).matchAll(ATTRIBUTE)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '')
  }
  return attributes
}

/** Stable id: the state file path is the identity, the hash keeps the id short. */
function presetIdOf(statePath) {
  return `preset-${createHash('sha1').update(String(statePath).toLowerCase()).digest('hex').slice(0, 10)}`
}

export const ampleSoundAdapter = {
  id: 'ample-sound',

  async matches(pluginPath) {
    return Boolean(await presetDirFor(pluginPath))
  },

  presetDir(pluginPath) {
    return presetDirFor(pluginPath)
  },

  async scan(presetDir) {
    let entries
    try {
      entries = await readdir(presetDir, { withFileTypes: true })
    } catch {
      return []
    }
    const timbres = []
    for (const entry of entries) {
      if (!entry.isFile() || !extname(entry.name).toLowerCase().endsWith('state')) continue
      const statePath = join(presetDir, entry.name)
      const header = await readHeader(statePath)
      // A broken preset is skipped, not fatal: the rest of the folder still counts.
      if (!header) continue
      const fallback = basename(entry.name, extname(entry.name))
      timbres.push({
        presetId: presetIdOf(statePath),
        name: header.Name || fallback,
        category: header.Category ?? '',
        type: header.Type ?? '',
        statePath,
      })
    }
    timbres.sort((left, right) => left.name.localeCompare(right.name) || left.statePath.localeCompare(right.statePath))
    return timbres
  },
}
