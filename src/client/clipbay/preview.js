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
import { useCallback, useEffect, useRef, useState } from 'react'
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
  const [seekError, setSeekError] = useState('')
  const failedSeeks = useRef(0)
  const hasVideo = Boolean(project?.video?.path)
  const positionSec = transport?.positionSec ?? 0
  const playing = Boolean(transport?.playing)

  /**
   * Seek the picture, and say so when it will not go.
   *
   * A `currentTime` assignment throws while `readyState` is still HAVE_NOTHING,
   * which is what a file with its `moov` atom after `mdat` looks like before the
   * browser has all of it. Swallowing that silently is how the picture sat on
   * frame one for a whole playback while nothing anywhere said why. Three
   * consecutive failures become a visible line, because a person who cannot see
   * the picture move needs to know it is the file's layout and not their work.
   */
  const seekTo = useCallback((node, target) => {
    try {
      node.currentTime = target
      failedSeeks.current = 0
      setSeekError('')
    } catch {
      failedSeeks.current += 1
      if (failedSeeks.current >= 3) setSeekError('画面读得比声音慢，播放时可能停住；导出完整成片后播放即可。')
    }
  }, [])

  // Follow the audio clock. While playing, a small drift is ignored so the two
  // clocks do not fight; a large one re-seeks. While paused, the picture follows
  // every seek, which is what makes scrubbing usable.
  useEffect(() => {
    const node = videoRef.current
    if (!node || !hasVideo) return
    const target = Math.max(0, positionSec)
    if (!playing) {
      if (Math.abs(node.currentTime - target) > 0.03) seekTo(node, target)
      return
    }
    if (Math.abs(node.currentTime - target) > DRIFT_LIMIT_SEC) seekTo(node, target)
    if (typeof node.play === 'function') {
      const started = node.play()
      if (started && typeof started.catch === 'function') started.catch(() => {})
    }
  }, [positionSec, playing, hasVideo, seekTo])

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
      // The box takes the height its row gives it and letterboxes the picture
      // inside (`objectFit: contain`). A fixed 16:9 box would grow on a wide
      // screen and eat the room the tracks need; letterboxing is what 剪映 does
      // too, and the user accepted the black bars.
      width: '100%', height: '100%', minHeight: 0,
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
    // The picture will not seek, so it is standing still while the sound runs.
    // Saying so is the difference between "the plugin is broken" and "this file
    // needs a full export first".
    seekError && hasVideo && !videoError
      ? h('div', { style: { ...S.notice('warn'), position: 'absolute', bottom: 8, left: 8, right: 8 } }, seekError)
      : null,
  )
}
