// VST3 rendering kernel, shared by the music renderer.
//
// This used to be the anyaudio_instrument tool. The tool is gone: a VST3
// instrument is now just another source a score track can name, so the kernel
// lives here and the music renderer calls it per track. It never touches a
// project — the caller decides where the stem goes.

import { basename } from 'node:path'
import { mergedCatalog } from '../audio/vst3-catalog.js'
import { createVst3Process } from '../audio/vst3-process.js'

/**
 * Resolve a catalog id, display name or VST3 path against the merged catalog
 * (built-in entries plus the plugins the person scanned in).
 *
 * A path that is not in the catalog is returned as-is: the sidecar can still
 * load it, and the caller may be pointing at a plugin it has not added yet.
 */
export async function resolvePlugin(raw) {
  const catalog = await mergedCatalog()
  const wanted = typeof raw === 'string' ? raw.trim() : ''
  if (!wanted) throw new Error('VST3 plugin id or path is required')
  const entry = catalog.plugins.find((item) => item.id === wanted)
    ?? catalog.plugins.find((item) => item.name === wanted)
    ?? catalog.plugins.find((item) => basename(item.plugin).toLowerCase() === wanted.toLowerCase())
    ?? catalog.plugins.find((item) => item.plugin.toLowerCase() === wanted.toLowerCase())
    ?? null
  if (entry) return { entry, path: entry.plugin, label: entry.name }
  return { entry: null, path: wanted, label: basename(wanted) || wanted }
}

/**
 * Render one VST3 stem to `out`.
 *
 * Pass `manager` to reuse one process across a whole score (the plugin cache
 * then survives between tracks); without it a private process is started and
 * shut down around this render.
 *
 * `preset` is the state file of the timbre to load (the caller resolves a
 * timbre name to its file); without it the plugin renders its default state.
 * `ccs` is the track's expression curve ([{ t, controller, value }]); a plugin
 * that does not map the controller simply ignores it.
 */
export async function renderVst3Stem({ plugin, notes, duration, out, manager, keyswitches, ccs, preset }) {
  const resolved = await resolvePlugin(plugin)
  const own = manager ?? createVst3Process()
  try {
    return await own.render({
      plugin: resolved.path,
      notes,
      duration,
      out,
      ...(keyswitches?.length ? { keyswitches } : {}),
      ...(ccs?.length ? { ccs } : {}),
      ...(preset ? { preset } : {}),
    })
  } finally {
    if (!manager) await own.shutdown().catch(() => {})
  }
}
