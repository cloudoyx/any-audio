// VST3 rendering kernel, shared by the music renderer.
//
// This used to be the anyaudio_instrument tool. The tool is gone: a VST3
// instrument is now just another source a score track can name, so the kernel
// lives here and the music renderer calls it per track. It never touches a
// project — the caller decides where the stem goes.

import { createVst3Process } from '../audio/vst3-process.js'

/**
 * Render one VST3 stem to `out`.
 *
 * Pass `manager` to reuse one process across a whole score (the plugin cache
 * then survives between tracks); without it a private process is started and
 * shut down around this render.
 */
export async function renderVst3Stem({ plugin, notes, duration, out, manager, keyswitches }) {
  const own = manager ?? createVst3Process()
  try {
    return await own.render({
      plugin,
      notes,
      duration,
      out,
      ...(keyswitches?.length ? { keyswitches } : {}),
    })
  } finally {
    if (!manager) await own.shutdown().catch(() => {})
  }
}
