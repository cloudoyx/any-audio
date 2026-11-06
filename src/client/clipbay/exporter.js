/**
 * Export (spec §10.1–10.3).
 *
 * The render runs on the host as a job, because it is minutes of CPU and has to
 * be cancellable; this module only starts it, polls it and shows where it got to.
 * Cancelling sends the host an abort, which reaches the ffmpeg child — the UI
 * never pretends to have stopped something that is still running.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'

const POLL_MS = 400

export const EXPORT_FORMATS = ['wav', 'mp3', 'mp4']

/** Default file name for a format, matching what the export writes. */
export function exportName(project, format) {
  const base = String(project?.name ?? 'mix')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'mix'
  return `${base}.${format}`
}

export function availableFormats(project) {
  return project?.video ? ['mp4', 'wav', 'mp3'] : ['wav', 'mp3']
}

/** A one-line summary of a job, in the state the host reports. */
export function describeJob(job) {
  if (!job) return ''
  if (job.status === 'running') {
    if (job.phase === 'encode') return t('正在编码 {0}…', job.message?.replace('encoding ', '') ?? '')
    if (job.track && job.tracks) return t('正在渲染第 {0} / {1} 轨…', job.track, job.tracks)
    return t('正在渲染…')
  }
  if (job.status === 'cancelled') return t('已取消。')
  if (job.status === 'error') return `${t('导出失败')}：${job.error}`
  return t('导出完成：{0}', job.file)
}

/**
 * `name` is the project name, used for the exported file. `beforeStart` flushes
 * the pending autosave: the renderer reads project.json from disk, so a debounced
 * save still in flight would export the arrangement from a moment ago.
 */
export function useExport(root, projectId, { name, beforeStart } = {}) {
  const [job, setJob] = useState(null)
  const [error, setError] = useState('')
  const timerRef = useRef(null)
  const stoppedRef = useRef(true)

  const stopPolling = useCallback(() => {
    stoppedRef.current = true
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const poll = useCallback((jobId) => {
    if (stoppedRef.current) return
    timerRef.current = setTimeout(async () => {
      try {
        const data = await api(`/clipbay/render?root=${encodeURIComponent(root)}&project=${encodeURIComponent(projectId)}&job=${encodeURIComponent(jobId)}`)
        setJob(data.job)
        if (data.job.status === 'running') poll(jobId)
        else stopPolling()
      } catch (caught) {
        setError(caught.message)
        stopPolling()
      }
    }, POLL_MS)
  }, [root, projectId, stopPolling])

  const start = useCallback(async (format, { normalize = false } = {}) => {
    setError('')
    try {
      if (beforeStart) await beforeStart()
      const data = await api(`/clipbay/render?root=${encodeURIComponent(root)}&project=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        body: { format, output: exportName({ name }, format), normalize },
      })
      setJob(data.job)
      stoppedRef.current = false
      poll(data.job.id)
      return data.job
    } catch (caught) {
      setError(caught.message)
      return null
    }
  }, [root, projectId, name, beforeStart, poll])

  const cancel = useCallback(async () => {
    stopPolling()
    if (!job?.id) return
    try {
      const data = await api('/clipbay/render/cancel', { method: 'POST', body: { jobId: job.id } })
      setJob(data.job)
    } catch (caught) {
      setError(caught.message)
    }
  }, [job, stopPolling])

  return { job, error, start, cancel, running: job?.status === 'running' }
}
