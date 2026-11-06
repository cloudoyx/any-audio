/**
 * The preview area above the timeline (spec §7.2, §11.1).
 *
 * A project with a picture shows that picture; the video is a locked reference
 * frame, so it is displayed and seeked but never edited. A pure-audio project
 * gets the same transport with a silent placeholder, which keeps the layout from
 * jumping between the two kinds of project.
 *
 * Playback position follows the audio clock, not the video element: the audio is
 * what the person is editing, and `<video>` will drift from a WebAudio clock if
 * left to play on its own. The element is seeked when the difference grows past a
 * few frames and scrubbed during a paused seek.
 */
import { useEffect, useRef, useState } from 'react'
import { h, S, C } from '../ui.js'
import { t } from '../i18n.js'
import { API } from '../api.js'

const DRIFT_LIMIT_SEC = 0.2

export function previewUrl(root, projectId) {
  return `${API}/clipbay/video?root=${encodeURIComponent(root)}&project=${encodeURIComponent(projectId)}`
}

export function Preview({ root, projectId, project, transport }) {
  const videoRef = useRef(null)
  const [videoError, setVideoError] = useState('')
  const hasVideo = Boolean(project?.video?.path)
  const positionSec = transport?.positionSec ?? 0
  const playing = Boolean(transport?.playing)

  // Follow the audio clock. While playing, a small drift is ignored so the two
  // clocks do not fight; a large one re-seeks. While paused, the picture follows
  // every seek, which is what makes scrubbing usable.
  useEffect(() => {
    const node = videoRef.current
    if (!node || !hasVideo) return
    const target = Math.max(0, positionSec)
    if (!playing) {
      if (Math.abs(node.currentTime - target) > 0.03) {
        try { node.currentTime = target } catch { /* seek before metadata is harmless */ }
      }
      return
    }
    if (Math.abs(node.currentTime - target) > DRIFT_LIMIT_SEC) {
      try { node.currentTime = target } catch { /* ignore */ }
    }
    if (typeof node.play === 'function') {
      const started = node.play()
      if (started && typeof started.catch === 'function') started.catch(() => {})
    }
  }, [positionSec, playing, hasVideo])

  // Starting the audio transport should also start the picture; pausing should
  // freeze it, otherwise the two drift apart while the person reads the timeline.
  useEffect(() => {
    const node = videoRef.current
    if (!node || !hasVideo) return
    if (playing) {
      const started = node.play()
      if (started && typeof started.catch === 'function') started.catch(() => {})
    } else if (typeof node.pause === 'function') {
      node.pause()
    }
  }, [playing, hasVideo])

  return h('div', {
    style: {
      border: `1px solid ${C.border}`, borderRadius: 8, background: '#000', position: 'relative',
      overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
      aspectRatio: '16 / 9', maxHeight: '42vh', width: '100%',
    },
  },
    hasVideo
      ? h('video', {
        ref: videoRef,
        src: previewUrl(root, projectId),
        style: { width: '100%', height: '100%', objectFit: 'contain', background: '#000' },
        muted: true,
        playsInline: true,
        preload: 'auto',
        onError: () => setVideoError(t('读不出这个工程的视频，时间轴还能用。')),
      })
      : h('div', { style: { color: C.muted, fontSize: 12, textAlign: 'center', padding: 16 } },
        t('这个工程只有音频，没有画面。'),
      ),
    videoError && hasVideo
      ? h('div', { style: { ...S.notice('warn'), position: 'absolute', bottom: 8, left: 8, right: 8 } }, videoError)
      : null,
  )
}
