#!/usr/bin/env node
import { RECOMMENDED_FONTS, installFont, listFonts, userFontDir } from '../src/audio/fonts.js'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] ?? true : fallback
}

const workspaceRoot = resolve(flag('workspace', '.'))

if (args.includes('--list') || args.includes('--help')) {
  const fonts = await listFonts()
  console.log(fonts.length ? 'Installed fonts:' : 'No font installed yet.')
  for (const font of fonts) console.log(`- ${font.path} (${font.bytes} bytes, ${font.source})`)
  console.log(`\nUser font directory: ${userFontDir()}`)
  console.log('Recommended:')
  for (const preset of RECOMMENDED_FONTS) {
    console.log(`- ${preset.id}: ${preset.url}`)
    console.log(`  ${preset.bytes} bytes, license: ${preset.license}`)
  }
  process.exit(0)
}

try {
  const explicitId = flag('id', undefined)
  const explicitUrl = flag('url', undefined)
  const fromPath = flag('from', undefined)
  const targets = explicitId || explicitUrl || fromPath ? [String(explicitId ?? 'generaluser')] : RECOMMENDED_FONTS.filter((font) => font.suggested).map((font) => font.id)
  for (const id of targets) {
    const result = await installFont({ id, url: explicitUrl, fromPath, workspaceRoot })
    console.log(`Font ready: ${result.path}`)
    console.log(`Size: ${result.bytes} bytes`)
    console.log(`SHA-256: ${result.sha256}`)
    console.log(`License: ${result.license}`)
    if (result.alreadyInstalled) console.log('(already installed)')
  }
} catch (error) {
  console.error(`Font install failed: ${error.message}`)
  console.error('If the download is blocked, fetch the file with a proxy and rerun with --from <path-to-sf2>.')
  process.exit(1)
}
