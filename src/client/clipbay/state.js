/**
 * The editor's view of one project (plan M5.1).
 *
 * `project` here is exactly what project.json holds — arrangement only. Playhead,
 * selection, zoom and scroll position are view state and live in the components
 * that own them, so there is no path by which they reach the file (spec §6.8).
 *
 * Saving is M5.7; this module owns loading, mutating and knowing whether the
 * in-memory copy has drifted from the file.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { contentEndSec } from './serialize.js'

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Load a project and its material index, then expose a mutate-somehow API.
 *
 * `update(mutator, note)` hands the mutator a deep copy so a component that
 * forgets to clone cannot corrupt what is on screen; `note` is the sentence the
 * file's history records, and is the only reason history grows (spec §6.7).
 */
export function useProject(root, projectId) {
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const [project, setProject] = useState(null)
  const [materials, setMaterials] = useState([])
  const [dirty, setDirty] = useState(false)

  const reload = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const data = await api(`/clipbay/project?root=${encodeURIComponent(root)}&id=${encodeURIComponent(projectId)}`)
      setProject(data.project)
      setMaterials(data.materials ?? [])
      setDirty(false)
      setStatus('ready')
    } catch (caught) {
      setError(caught.message)
      setStatus('error')
    }
  }, [root, projectId])

  useEffect(() => { void reload() }, [reload])

  const update = useCallback((mutator, note) => {
    setProject((current) => {
      if (!current) return current
      const draft = structuredClone(current)
      const next = mutator(draft) ?? draft
      next.durationSec = contentEndSec(next)
      if (note) {
        next.history = [...next.history, { at: nowIso(), by: 'user', note }]
      }
      return next
    })
    setDirty(true)
  }, [])

  return { status, error, project, materials, dirty, reload, update }
}

/** Materials by id, for the drawing code that needs duration and kind. */
export function indexMaterials(materials) {
  const map = new Map()
  for (const material of materials ?? []) map.set(material.id, material)
  return map
}
