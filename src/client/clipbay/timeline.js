/**
 * The timeline surface (plan M5.2).
 *
 * This step draws the real waveform of every clip: track heads on the left, a
 * time ruler on top, one canvas per clip. Editing (drag, trim, split) is M5.4, so
 * the pointer handlers are not here yet.
 *
 * Geometry: seconds map to pixels through one `scale`. Every clip canvas is
 * positioned with `left = (startSec - scrollSec) * scale` and sized
 * `lengthSec * scale`; zoom only changes `scale`, which is why zooming never
 * re-reads a peak file — the same buckets are aggregated onto a new pixel width.
 */
import { useEffect, useRef, useState } from 'react'
import { h, S, Btn, C } from '../ui.js'
import { t } from '../i18n.js'
import { itemLengthSec, contentEndSec } from './serialize.js'
import { drawClipWaveform } from './waveform.js'
import { usePeaks } from './peaks.js'

const TRACK_HEIGHT = 54
const TRACK_HEIGHT_ACTIVE = 78
const HEAD_WIDTH = 150
const RULER_HEIGHT = 22

const CATEGORY_COLOR = {
  music: '#4f7cff',
  'music-stem': '#6d8cff',
  tts: '#2ea36b',
  ambience: '#3aa0a8',
  foley: '#c9822a',
  'video-audio': '#a06cc0',
  other: '#7a7a7a',
}

/** Pick a ruler step that keeps labels at least ~70 px apart. */
export function rulerStep(scale) {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  for (const step of candidates) {
    if (step * scale >= 70) return step
  }
  return 600
}

/** m:ss.d, the shape a timeline ruler wants. */
export function rulerLabel(seconds, step) {
  const total = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  const decimals = step < 1 ? 1 : 0
  return `${minutes}:${rest.toFixed(decimals).padStart(decimals ? 4 : 2, '0')}`
}

function ClipCanvas({ peaks, inSec, outSec, width, height, color }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ratio = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1))
    canvas.width = Math.max(1, Math.round(width * ratio))
    canvas.height = Math.max(1, Math.round(height * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    drawClipWaveform(ctx, { peaks, inSec, outSec, width, height, color })
  }, [peaks, inSec, outSec, width, height, color])
  return h('canvas', {
    ref,
    style: { position: 'absolute', left: 0, top: 0, width, height, display: 'block' },
  })
}

function Ruler({ scale, durationSec, scrollSec }) {
  const step = rulerStep(scale)
  const first = Math.floor(scrollSec / step) * step
  const marks = []
  for (let at = first; at <= scrollSec + durationSec; at += step) {
    const x = (at - scrollSec) * scale
    if (x < -1) continue
    marks.push(h('div', {
      key: at,
      style: { position: 'absolute', left: x, top: 0, width: 1, height: RULER_HEIGHT, background: C.border },
    }, h('span', {
      style: { position: 'absolute', left: 4, top: 2, fontSize: 10, color: C.muted, whiteSpace: 'nowrap' },
    }, rulerLabel(at, step))))
  }
  return h('div', { style: { position: 'relative', height: RULER_HEIGHT, overflow: 'hidden', borderBottom: `1px solid ${C.border}` } }, marks)
}

function Clip({ item, track, peaks, scale, scrollSec, height }) {
  const lengthSec = itemLengthSec(item)
  const left = (item.startSec - scrollSec) * scale
  const width = Math.max(2, lengthSec * scale)
  if (left + width < 0) return null

  const color = CATEGORY_COLOR[track.category] || CATEGORY_COLOR.other
  const fadeIn = Math.min(width / 2, (Number(item.fadeInSec) || 0) * scale)
  const fadeOut = Math.min(width / 2, (Number(item.fadeOutSec) || 0) * scale)

  return h('div', {
    style: {
      position: 'absolute',
      left,
      top: 2,
      width,
      height: height - 4,
      borderRadius: 4,
      border: `1px solid ${track.muted ? C.border : color}`,
      background: track.muted || item.muted ? 'rgba(128,128,128,0.10)' : `${color}22`,
      overflow: 'hidden',
      opacity: item.muted ? 0.45 : 1,
    },
  },
    h(ClipCanvas, { peaks, inSec: item.inSec, outSec: item.outSec, width, height: height - 4, color: `${color}` }),
    fadeIn > 0
      ? h('div', { style: { position: 'absolute', left: 0, top: 0, width: fadeIn, height: '100%', background: 'linear-gradient(to right, rgba(0,0,0,0.55), transparent)' } })
      : null,
    fadeOut > 0
      ? h('div', { style: { position: 'absolute', right: 0, top: 0, width: fadeOut, height: '100%', background: 'linear-gradient(to left, rgba(0,0,0,0.55), transparent)' } })
      : null,
    h('span', {
      style: {
        position: 'absolute', left: 5, top: 1, fontSize: 10, color: 'inherit',
        maxWidth: Math.max(0, width - 10), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        opacity: 0.85,
      },
    }, item.label || item.id),
  )
}

function TrackRow({ track, peaksById, scale, scrollSec, active, onSelect }) {
  const height = active ? TRACK_HEIGHT_ACTIVE : TRACK_HEIGHT
  return h('div', {
    onClick: onSelect,
    style: { display: 'flex', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' },
  },
    h('div', {
      style: {
        width: HEAD_WIDTH, flex: '0 0 auto', padding: '4px 8px', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', gap: 2, justifyContent: 'center',
        borderRight: `1px solid ${C.border}`, background: active ? C.soft : 'transparent',
      },
    },
      h('span', { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, track.name),
      h('span', { style: { ...S.desc, fontSize: 10 } },
        `${track.items.length} ${t('段')} · ${track.volumeDb} dB${track.muted ? ` · ${t('已静音')}` : ''}${track.solo ? ` · ${t('独奏')}` : ''}`),
    ),
    h('div', { style: { position: 'relative', height, flex: 1, overflow: 'hidden' } },
      track.items.map((item) => h(Clip, {
        key: item.id,
        item,
        track,
        peaks: peaksById.get(item.material),
        scale,
        scrollSec,
        height,
      })),
    ),
  )
}

export function Timeline({ root, projectId, project, materials }) {
  const [scale, setScale] = useState(60)
  const [activeTrackId, setActiveTrackId] = useState(project.tracks[0]?.id ?? null)
  const peaksById = usePeaks(root, projectId, materials)
  const duration = Math.max(contentEndSec(project), 1)

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('span', { style: S.desc }, t('缩放')),
      h(Btn, { onClick: () => setScale((value) => Math.max(10, value / 1.5)) }, '−'),
      h('span', { style: { ...S.mono, minWidth: 56, textAlign: 'center' } }, `${Math.round(scale)} px/s`),
      h(Btn, { onClick: () => setScale((value) => Math.min(600, value * 1.5)) }, '+'),
      h('span', { style: { flex: 1 } }),
      h('span', { style: S.chip }, `${project.tracks.length} ${t('轨')}`),
      h('span', { style: S.chip }, `${materials.length} ${t('个素材')}`),
    ),
    h('div', {
      style: {
        border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'auto',
        maxHeight: '60vh', background: C.softer,
      },
    },
      h('div', { style: { width: HEAD_WIDTH + duration * scale, minWidth: '100%' } },
        h('div', { style: { display: 'flex' } },
          h('div', { style: { width: HEAD_WIDTH, flex: '0 0 auto', borderRight: `1px solid ${C.border}` } }),
          h('div', { style: { flex: 1, position: 'relative' } },
            h(Ruler, { scale, durationSec: duration, scrollSec: 0 }),
          ),
        ),
        project.tracks.length === 0
          ? h('p', { style: { ...S.desc, padding: '16px 12px' } }, t('这个工程还没有轨道。'))
          : project.tracks.map((track) => h(TrackRow, {
            key: track.id,
            track,
            peaksById,
            scale,
            scrollSec: 0,
            active: track.id === activeTrackId,
            onSelect: () => setActiveTrackId(track.id),
          })),
      ),
    ),
  )
}
