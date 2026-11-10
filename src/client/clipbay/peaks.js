/**
 * Peak loading (plan M5.2).
 *
 * One JSON file per material, generated at import time. The editor needs it the
 * moment a clip is visible, so results are cached per material id and the
 * in-flight request is shared — two clips of the same material must not fetch it
 * twice.
 */
import { useEffect, useState } from 'react'
import { API } from '../api.js'

const cache = new Map()

export function peaksUrl(root, projectId, materialId) {
  return `${API}/clipbay/peaks?root=${encodeURIComponent(root)}&project=${encodeURIComponent(projectId)}&id=${encodeURIComponent(materialId)}`
}

/** Fetch one material's peaks, memoised. Resolves to null when the file is absent. */
export function loadPeaks(url) {
  const existing = cache.get(url)
  if (existing) return existing
  const pending = fetch(url)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
  cache.set(url, pending)
  return pending
}

/** Drop everything, for a workspace switch or a test. */
export function clearPeakCache() {
  cache.clear()
}

/**
 * Load every material a project shows. Returns a Map of material id to series;
 * a material whose peaks are missing simply has no entry, and the clip draws its
 * centre line instead of failing.
 */
export function usePeaks(root, projectId, materials) {
  const [series, setSeries] = useState(() => new Map())

  useEffect(() => {
    if (!root || !projectId || materials.length === 0) return undefined
    let cancelled = false
    const wanted = materials.filter((material) => material?.id)
    Promise.all(wanted.map((material) => loadPeaks(peaksUrl(root, projectId, material.id))))
      .then((results) => {
        if (cancelled) return
        const next = new Map()
        wanted.forEach((material, index) => {
          if (results[index]) next.set(material.id, results[index])
        })
        setSeries(next)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [root, projectId, materials])

  return series
}
