/**
 * The timeline surface (plan M5.2–M5.4).
 *
 * Track heads on the left, a time ruler on top, one canvas per clip, a playhead
 * driven by the transport, and pointer editing: drag a clip to move it, drag an
 * edge to trim it.
 *
 * Geometry: seconds map to pixels through one `scale`. Every clip is positioned
 * with `left = (startSec - scrollSec) * scale` and sized `lengthSec * scale`;
 * zoom only changes `scale`, which is why zooming never re-reads a peak file.
 *
 * A drag previews locally (the clip follows the pointer) and commits once on
 * release, so the project and its history see one edit, not one per frame.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { h, S, Btn, C } from '../ui.js'
import { t } from '../i18n.js'
import { itemLengthSec, contentEndSec } from './serialize.js'
import { drawClipWaveform } from './waveform.js'
import { usePeaks } from './peaks.js'
import { itemLength, itemEnd } from './edit.js'

const TRACK_HEIGHT = 68
const TRACK_HEIGHT_ACTIVE = 88
const HEAD_WIDTH = 168
const RULER_HEIGHT = 22
const EDGE_GRAB = 6

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

/** m:ss.s for the transport readout. */
export function clockLabel(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`
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

function Ruler({ scale, durationSec, onSeek }) {
  const step = rulerStep(scale)
  const marks = []
  for (let at = 0; at <= durationSec; at += step) {
    const x = at * scale
    marks.push(h('div', {
      key: at,
      style: { position: 'absolute', left: x, top: 0, width: 1, height: RULER_HEIGHT, background: C.border },
    }, h('span', {
      style: { position: 'absolute', left: 4, top: 2, fontSize: 10, color: C.muted, whiteSpace: 'nowrap' },
    }, rulerLabel(at, step))))
  }
  return h('div', {
    style: { position: 'relative', height: RULER_HEIGHT, overflow: 'hidden', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' },
    onClick: (event) => {
      const box = event.currentTarget.getBoundingClientRect()
      onSeek((event.clientX - box.left) / scale)
    },
  }, marks)
}

function Clip({ item, track, peaks, scale, height, selected, preview, onPointerDown, onSelect }) {
  const lengthSec = itemLengthSec(item)
  const dragging = preview && preview.itemId === item.id && preview.trackId === track.id
  const offset = dragging ? preview.deltaSec * scale : 0
  const width = Math.max(2, lengthSec * scale)
  const left = item.startSec * scale + offset

  const color = CATEGORY_COLOR[track.category] || CATEGORY_COLOR.other
  const fadeIn = Math.min(width / 2, (Number(item.fadeInSec) || 0) * scale)
  const fadeOut = Math.min(width / 2, (Number(item.fadeOutSec) || 0) * scale)
  const dimmed = track.muted || item.muted

  return h('div', {
    onPointerDown,
    onClick: (event) => { event.stopPropagation(); onSelect() },
    style: {
      position: 'absolute',
      left,
      top: 2,
      width,
      height: height - 4,
      borderRadius: 4,
      border: `1px solid ${selected ? '#fff' : dimmed ? C.border : color}`,
      boxShadow: selected ? `0 0 0 1px ${C.accent}` : 'none',
      background: dimmed ? 'rgba(128,128,128,0.10)' : `${color}22`,
      overflow: 'hidden',
      opacity: item.muted ? 0.45 : 1,
      cursor: 'grab',
      touchAction: 'none',
    },
  },
    h(ClipCanvas, { peaks, inSec: item.inSec, outSec: item.outSec, width, height: height - 4, color }),
    fadeIn > 0
      ? h('div', { style: { position: 'absolute', left: 0, top: 0, width: fadeIn, height: '100%', background: 'linear-gradient(to right, rgba(0,0,0,0.55), transparent)' } })
      : null,
    fadeOut > 0
      ? h('div', { style: { position: 'absolute', right: 0, top: 0, width: fadeOut, height: '100%', background: 'linear-gradient(to left, rgba(0,0,0,0.55), transparent)' } })
      : null,
    h('span', {
      style: {
        position: 'absolute', left: 6, top: 1, fontSize: 10, color: 'inherit',
        maxWidth: Math.max(0, width - 12), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        opacity: 0.85, pointerEvents: 'none',
      },
    }, item.label || item.id),
    h('div', {
      'data-edge': 'start',
      style: { position: 'absolute', left: 0, top: 0, width: EDGE_GRAB, height: '100%', cursor: 'ew-resize' },
    }),
    h('div', {
      'data-edge': 'end',
      style: { position: 'absolute', right: 0, top: 0, width: EDGE_GRAB, height: '100%', cursor: 'ew-resize' },
    }),
  )
}

function TrackHead({ track, active, onSelect, onEdit }) {
  const [name, setName] = useState(track.name)
  const [editing, setEditing] = useState(false)

  useEffect(() => { setName(track.name) }, [track.name])

  const commitName = () => {
    setEditing(false)
    const value = name.trim()
    if (!value || value === track.name) { setName(track.name); return }
    onEdit({ kind: 'track-name', name: value })
  }

  return h('div', {
    onClick: onSelect,
    style: {
      width: HEAD_WIDTH, flex: '0 0 auto', padding: '4px 8px 4px 8px', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', gap: 3, justifyContent: 'center',
      borderRight: `1px solid ${C.border}`, background: active ? C.soft : 'transparent', cursor: 'pointer',
    },
  },
    editing
      ? h('input', {
        autoFocus: true,
        value: name,
        onChange: (event) => setName(event.target.value),
        onBlur: commitName,
        onKeyDown: (event) => {
          if (event.key === 'Enter') commitName()
          if (event.key === 'Escape') { setName(track.name); setEditing(false) }
          event.stopPropagation()
        },
        onClick: (event) => event.stopPropagation(),
        style: { ...S.input, fontSize: 12, padding: '1px 4px', width: '100%' },
      })
      : h('span', {
        onDoubleClick: (event) => { event.stopPropagation(); setEditing(true) },
        title: t('双击改名'),
        style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, track.name),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
      h(Btn, {
        kind: track.muted ? 'primary' : 'plain',
        onClick: (event) => { event.stopPropagation(); onEdit({ kind: 'track-mute', muted: !track.muted }) },
        title: t('静音'),
        style: { padding: '0 5px', fontSize: 10, minWidth: 18 },
      }, 'M'),
      h(Btn, {
        kind: track.solo ? 'primary' : 'plain',
        onClick: (event) => { event.stopPropagation(); onEdit({ kind: 'track-solo', solo: !track.solo }) },
        title: t('独奏'),
        style: { padding: '0 5px', fontSize: 10, minWidth: 18 },
      }, 'S'),
      h('span', { style: { ...S.desc, fontSize: 10, marginLeft: 2 } }, `${track.items.length} ${t('段')}`),
      h('span', { style: { flex: 1 } }),
      h(Btn, {
        onClick: (event) => { event.stopPropagation(); onEdit({ kind: 'track-delete' }) },
        title: t('删除轨道'),
        style: { padding: '0 4px', fontSize: 9, lineHeight: 1.3 },
      }, '✕'),
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
      h('span', { style: { ...S.mono, fontSize: 9, minWidth: 24, color: C.muted } }, t('音量')),
      h('input', {
        type: 'range',
        min: -60,
        max: 12,
        step: 0.5,
        value: track.volumeDb,
        title: `${t('音量')} ${track.volumeDb} dB`,
        onChange: (event) => onEdit({ kind: 'track-volume', volumeDb: Number(event.target.value) }),
        onClick: (event) => event.stopPropagation(),
        onPointerDown: (event) => event.stopPropagation(),
        style: { flex: 1, minWidth: 0, height: 11 },
      }),
      h('span', { style: { ...S.mono, fontSize: 9, minWidth: 30, textAlign: 'right' } }, `${track.volumeDb}`),
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
      h('span', { style: { ...S.mono, fontSize: 9, minWidth: 24, color: C.muted } }, t('声像')),
      h('input', {
        type: 'range',
        min: -1,
        max: 1,
        step: 0.05,
        value: track.pan,
        title: `${t('声像')} ${track.pan}`,
        onChange: (event) => onEdit({ kind: 'track-pan', pan: Number(event.target.value) }),
        onClick: (event) => event.stopPropagation(),
        onPointerDown: (event) => event.stopPropagation(),
        style: { flex: 1, minWidth: 0, height: 11 },
      }),
      h('span', { style: { ...S.mono, fontSize: 9, minWidth: 30, textAlign: 'right' } }, track.pan.toFixed(2)),
    ),
  )
}

function TrackRow({ track, peaksById, scale, active, onSelect, onEdit, drag, selection, onClipPointerDown, onClipSelect, range, onRangeStart }) {
  const height = active ? TRACK_HEIGHT_ACTIVE : TRACK_HEIGHT
  const band = range && range.trackId === track.id && range.toSec > range.fromSec
  return h('div', {
    style: { display: 'flex', borderBottom: `1px solid ${C.border}` },
  },
    h(TrackHead, { track, active, onSelect, onEdit }),
    h('div', { style: { position: 'relative', height, flex: 1, overflow: 'hidden' }, 'data-track-body': true },
      track.items.map((item) => h(Clip, {
        key: item.id,
        item,
        track,
        peaks: peaksById.get(item.material),
        scale,
        height,
        selected: selection?.itemId === item.id,
        preview: drag.preview,
        onSelect: () => onClipSelect(track.id, item.id),
        onPointerDown: (event) => onClipPointerDown(event, track, item),
      })),
      // The range the person dragged: drawn behind nothing, on top of the clips,
      // so it is obvious which stretch 添加到对话 will cite.
      band
        ? h('div', {
          style: {
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: range.fromSec * scale,
            width: Math.max(1, (range.toSec - range.fromSec) * scale),
            background: 'rgba(79,124,255,0.22)',
            borderLeft: `1px solid ${C.accent}`,
            borderRight: `1px solid ${C.accent}`,
            pointerEvents: 'none',
          },
        })
        : null,
      // The empty part of a track is the range-drag surface; clips keep their own
      // pointer handling above it.
      h('div', {
        style: { position: 'absolute', inset: 0, zIndex: -1 },
        onPointerDown: (event) => onRangeStart(event, track, height),
      }),
    ),
  )
}

export function Timeline({ root, projectId, project, materials, transport, onEdit, selection, onSelect, onUndo, onRedo, range, onRange }) {
  const [scale, setScale] = useState(60)
  const [activeTrackId, setActiveTrackId] = useState(project.tracks[0]?.id ?? null)
  const peaksById = usePeaks(root, projectId, materials)
  const duration = Math.max(contentEndSec(project), 1)
  const positionSec = transport?.positionSec ?? 0

  const dragRef = useRef(null)
  const rangeRef = useRef(null)
  const [rangeDrag, setRangeDrag] = useState(false)

  /**
   * Dragging across an empty stretch of a track selects a time range on that
   * track — one of the three selections spec §9.3 supports, and the one the
   * acceptance script uses ("框选鼓组 20–35 秒").
   *
   * The band is committed when the pointer is released, as one range, so moving
   * the pointer does not spam the parent with new state per frame.
   */
  const startRange = useCallback((event, track, height) => {
    const box = event.currentTarget.getBoundingClientRect()
    const at = Math.max(0, Math.min(duration, (event.clientX - box.left) / scale))
    rangeRef.current = { trackId: track.id, anchorSec: at, pointerId: event.pointerId }
    setActiveTrackId(track.id)
    setRangeDrag(true)
    onRange?.({ trackId: track.id, fromSec: at, toSec: at })
  }, [duration, scale, onRange])

  useEffect(() => {
    if (!rangeDrag) return undefined
    const move = (event) => {
      const current = rangeRef.current
      if (!current || current.pointerId !== event.pointerId) return
      const target = event.target
      const box = target?.closest?.('[data-track-body]')?.getBoundingClientRect()
      if (!box) return
      const at = Math.max(0, Math.min(duration, (event.clientX - box.left) / scale))
      onRange?.({
        trackId: current.trackId,
        fromSec: Math.min(current.anchorSec, at),
        toSec: Math.max(current.anchorSec, at),
      })
    }
    const finish = () => {
      const current = rangeRef.current
      rangeRef.current = null
      setRangeDrag(false)
      if (!current) return
      // A click without a drag clears the range instead of leaving a zero-width one.
      if (range && range.toSec - range.fromSec < 0.05) onRange?.(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [rangeDrag, scale, duration, onRange, range])

  const onCommit = useCallback((deltaSec, payload) => {
    onEdit?.({ kind: payload.kind, deltaSec, trackId: payload.trackId, itemId: payload.itemId, edge: payload.edge })
  }, [onEdit])

  const startDrag = useCallback((event, track, item) => {
    event.preventDefault()
    event.stopPropagation()
    onSelect?.(track.id, item.id)
    const edge = event.target?.dataset?.edge
    dragRef.current = {
      startX: event.clientX,
      pointerId: event.pointerId,
      payload: { kind: edge ? 'trim' : 'move', trackId: track.id, itemId: item.id, edge },
    }
    setDrag({ kind: edge ? 'trim' : 'move', trackId: track.id, itemId: item.id, edge, deltaSec: 0 })
  }, [onSelect])

  const [drag, setDrag] = useState(null)

  useEffect(() => {
    if (!drag) return undefined
    const move = (event) => {
      const current = dragRef.current
      if (!current || current.pointerId !== event.pointerId) return
      const deltaSec = (event.clientX - current.startX) / scale
      current.deltaSec = deltaSec
      current.moved = current.moved || Math.abs(event.clientX - current.startX) > 2
      setDrag({ ...current.payload, deltaSec })
    }
    const finish = (event) => {
      const current = dragRef.current
      if (!current || current.pointerId !== event.pointerId) return
      dragRef.current = null
      setDrag(null)
      if (current.moved && Math.abs(current.deltaSec) > 1e-4) {
        onCommit(current.deltaSec, current.payload)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [drag, scale, onCommit])

  // Delete / Ctrl+D act on the selection; Ctrl+Z / Ctrl+Shift+Z walk the history.
  useEffect(() => {
    const onKey = (event) => {
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault()
        if (event.shiftKey) onRedo?.()
        else onUndo?.()
        return
      }
      if (!selection?.itemId) return
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        onEdit?.({ kind: 'delete', trackId: selection.trackId, itemId: selection.itemId })
      } else if (mod && (event.key === 'd' || event.key === 'D')) {
        event.preventDefault()
        onEdit?.({ kind: 'duplicate', trackId: selection.trackId, itemId: selection.itemId })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, onEdit, onUndo, onRedo])

  const seekTo = useCallback((seconds) => {
    transport?.seek?.(Math.max(0, Math.min(duration, seconds)))
  }, [transport, duration])

  useEffect(() => {
    const onKey = (event) => {
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return
      if (event.code === 'Space') {
        event.preventDefault()
        if (transport?.playing) transport.pause()
        else transport?.play?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [transport])

  const dragPreview = drag ? { trackId: drag.trackId, itemId: drag.itemId, deltaSec: drag.deltaSec } : null
  const playheadX = positionSec * scale

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h(Btn, { onClick: () => (transport?.playing ? transport.pause() : transport?.play?.()), kind: 'primary' },
        transport?.playing ? t('暂停') : t('播放')),
      h('span', { style: { ...S.mono, minWidth: 96 } }, `${clockLabel(positionSec)} / ${clockLabel(duration)}`),
      h('span', { style: { flex: 1 } }),
      h('span', { style: S.desc }, t('缩放')),
      h(Btn, { onClick: () => setScale((value) => Math.max(10, value / 1.5)) }, '−'),
      h('span', { style: { ...S.mono, minWidth: 56, textAlign: 'center' } }, `${Math.round(scale)} px/s`),
      h(Btn, { onClick: () => setScale((value) => Math.min(600, value * 1.5)) }, '+'),
      h('span', { style: S.chip }, `${project.tracks.length} ${t('轨')}`),
    ),
    transport?.error ? h('div', { style: S.notice('error') }, transport.error) : null,
    h('div', {
      style: {
        border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'auto',
        maxHeight: '60vh', background: C.softer,
      },
    },
      h('div', { style: { width: HEAD_WIDTH + duration * scale, minWidth: '100%', position: 'relative' } },
        h('div', { style: { display: 'flex' } },
          h('div', { style: { width: HEAD_WIDTH, flex: '0 0 auto', borderRight: `1px solid ${C.border}` } }),
          h('div', { style: { flex: 1, position: 'relative' } },
            h(Ruler, { scale, durationSec: duration, onSeek: seekTo }),
          ),
        ),
        project.tracks.length === 0
          ? h('p', { style: { ...S.desc, padding: '16px 12px' } }, t('这个工程还没有轨道。'))
          : project.tracks.map((track) => h(TrackRow, {
            key: track.id,
            track,
            peaksById,
            scale,
            active: track.id === activeTrackId,
            onSelect: () => setActiveTrackId(track.id),
            onEdit: (request) => onEdit?.({ ...request, trackId: track.id }),
            drag: { preview: dragPreview },
            selection,
            onClipPointerDown: startDrag,
            onClipSelect: (trackId, itemId) => onSelect?.(trackId, itemId),
            range,
            onRangeStart: startRange,
          })),
        h('div', {
          style: {
            position: 'absolute', top: 0, bottom: 0, width: 1,
            left: HEAD_WIDTH + playheadX, background: C.accent, pointerEvents: 'none',
          },
        }),
      ),
    ),
  )
}
