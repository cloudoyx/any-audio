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
import { h, S, Btn, C, Slider, useSurface } from '../ui.js'
import { t } from '../i18n.js'
import { itemLengthSec, contentEndSec } from './serialize.js'
import { drawClipWaveform } from './waveform.js'
import { usePeaks } from './peaks.js'
import { itemLength, itemEnd } from './edit.js'

// One row height for every track, selected or not. An "active" row used to be
// 16px taller, which made the one track the person had just clicked stand out —
// that read as a bug, not as emphasis (and it fired on Alt-drag range selection
// too, so selecting a range silently changed the row height).
const TRACK_HEIGHT = 52
// The track head's starting width. It is a default, not a constant: the head
// holds a name, M/S/FX/✕ and two faders, which does not fit in 148px once the
// numbers reach two digits, and the person can drag the divider to whatever they
// want. What is fixed is the range, so a drag cannot hide the timeline or squeeze
// the head down to nothing.
const HEAD_WIDTH = 148
const HEAD_MIN = 120
const HEAD_MAX = 340
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

function Clip({ item, track, peaks, scale, height, selected, preview, audible = true, onPointerDown, onSelect }) {
  const lengthSec = itemLengthSec(item)
  const dragging = preview && preview.itemId === item.id && preview.trackId === track.id
  const offset = dragging ? preview.deltaSec * scale : 0
  const width = Math.max(2, lengthSec * scale)
  const left = item.startSec * scale + offset

  const color = CATEGORY_COLOR[track.category] || CATEGORY_COLOR.other
  const fadeIn = Math.min(width / 2, (Number(item.fadeInSec) || 0) * scale)
  const fadeOut = Math.min(width / 2, (Number(item.fadeOutSec) || 0) * scale)
  // `audible` is false when solo has silenced this track without touching its
  // mute flag. The mix has always honoured that (`resolveTrackGain`), but the
  // timeline showed every clip at full strength, so a soloed track looked
  // identical to a project where nothing was soloed — the person heard one
  // instrument and saw seven.
  const dimmed = track.muted || item.muted || !audible

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
      border: `1px solid ${selected ? C.accent : dimmed ? C.border : color}`,
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

function TrackHead({ track, active, audible = true, height, headWidth = HEAD_WIDTH, levelDb = null, surface = '#ffffff', onSelect, onEdit }) {
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
      // The head is exactly as tall as the track body. Left to itself its four
      // rows of controls grew to 81px and stretched every 52px row to 82px,
      // wasting 30px per track — the head is a header for the waveform, not a
      // mixer strip, so it must not be the tallest thing in the row.
      width: headWidth, height, flex: '0 0 auto', padding: '2px 6px', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', gap: 1, justifyContent: 'center',
      borderRight: `1px solid ${C.border}`, cursor: 'pointer',
      overflow: 'hidden',
      // Frozen against horizontal scrolling: the head names the track and holds
      // its buttons, so it has to stay readable however far the timeline is
      // scrolled. The background must be opaque or the clips slide through it,
      // and it is read from the shell rather than hard-coded so the head follows
      // a light theme instead of sitting on it as a dark patch.
      position: 'sticky', left: 0, zIndex: 2,
      background: active ? C.soft : surface,
      // A track silenced by someone else's solo greys out rather than
      // disappearing: it is still there to be clicked and un-soloed.
      opacity: audible ? 1 : 0.5,
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 } },
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
          style: { ...S.input, fontSize: 11, padding: '0 4px', flex: 1, minWidth: 0 },
        })
        : h('span', {
          onDoubleClick: (event) => { event.stopPropagation(); setEditing(true) },
          title: t('双击改名'),
          style: { fontSize: 11, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, track.name),
      h(Btn, {
        kind: track.muted ? 'primary' : 'plain',
        onClick: (event) => { event.stopPropagation(); onEdit({ kind: 'track-mute', muted: !track.muted }) },
        title: t('静音'),
        style: { padding: '0 4px', fontSize: 9, minWidth: 16, lineHeight: 1.4 },
      }, 'M'),
      h(Btn, {
        kind: track.solo ? 'primary' : 'plain',
        onClick: (event) => { event.stopPropagation(); onEdit({ kind: 'track-solo', solo: !track.solo }) },
        title: t('独奏'),
        style: { padding: '0 4px', fontSize: 9, minWidth: 16, lineHeight: 1.4 },
      }, 'S'),
      h(Btn, {
        onClick: (event) => { event.stopPropagation(); onEdit({ kind: 'track-delete' }) },
        title: t('删除轨道'),
        style: { padding: '0 3px', fontSize: 9, lineHeight: 1.4 },
      }, '✕'),
    ),
    // The measured level of what is on this track (improvement plan 03, I-38).
    // A track has no fader any more, so this row is the whole story of how loud
    // the group is — and with no number there, the only way to compare seven
    // tracks was to select each clip and read its properties.
    h('div', {
      title: levelDb === null ? t('这个轨道上的素材还没有测过电平') : t('这条轨上最响素材的实测电平'),
      style: {
        display: 'flex', alignItems: 'center', gap: 4, minWidth: 0,
        fontSize: 9, fontVariantNumeric: 'tabular-nums',
        color: levelDb === null ? C.muted : C.good,
      },
    },
      h('span', null, levelDb === null ? t('电平未知') : `${levelDb.toFixed(1)} dBFS`),
      levelDb !== null ? h('span', { style: { color: C.muted } }, t('素材')) : null,
    ),
  )
}

function TrackRow({ track, peaksById, scale, active, headWidth, audible = true, levelDb = null, surface, onSelect, onEdit, drag, selection, onClipPointerDown, onClipSelect, range, onRangeStart }) {
  const height = TRACK_HEIGHT
  const band = range && range.trackId === track.id && range.toSec > range.fromSec
  return h('div', {
    style: { display: 'flex', borderBottom: `1px solid ${C.border}` },
  },
    h(TrackHead, { track, active, audible, height, headWidth, levelDb, surface, onSelect, onEdit }),
    h('div', { style: { position: 'relative', height, flex: 1, overflow: 'hidden' }, 'data-track-body': true },
      track.items.map((item) => h(Clip, {
        key: item.id,
        item,
        track,
        peaks: peaksById.get(item.material),
        scale,
        height,
        audible,
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
        onPointerDown: (event) => onRangeStart(event, track),
      }),
    ),
  )
}

export function Timeline({ root, projectId, project, materials, transport, onEdit, selection, onSelect, onUndo, onRedo, range, onRange, onClearSelection }) {
  const [scale, setScale] = useState(60)
  const [activeTrackId, setActiveTrackId] = useState(project.tracks[0]?.id ?? null)
  const [headWidth, setHeadWidth] = useState(HEAD_WIDTH)
  const peaksById = usePeaks(root, projectId, materials)
  // Measured level per material, so a track head can show how loud its group is
  // without reading every clip (improvement plan 03, I-38).
  const levelByMaterial = new Map(
    (materials ?? []).map((material) => [material.id, typeof material.rmsDb === 'number' ? material.rmsDb : null]),
  )
  const trackLevel = (track) => {
    let loudest = null
    for (const item of track.items ?? []) {
      const value = levelByMaterial.get(item.material)
      if (typeof value === 'number' && (loudest === null || value > loudest)) loudest = value
    }
    return loudest
  }
  const duration = Math.max(contentEndSec(project), 1)
  const positionSec = transport?.positionSec ?? 0

  // The track heads and the sticky ruler must be opaque, and their colour has
  // to come from the shell's own background instead of a hard-coded dark value:
  // a dark strip on a light page is what made the timeline look broken
  // (2026-11-10).
  const surface = useSurface()

  const dragRef = useRef(null)
  const rangeRef = useRef(null)
  const [rangeDrag, setRangeDrag] = useState(false)
  const headDragRef = useRef(null)
  const [headDragging, setHeadDragging] = useState(false)

  // Which tracks can actually be heard. Solo is exclusive once anything is
  // soloed, and mute wins over solo — the same rule `resolveTrackGain` applies to
  // the mixer and the renderer. The timeline has to say so too: soloing a track
  // silently gagged every other one while their clips still looked healthy, so
  // the picture disagreed with the sound.
  const anySolo = project.tracks.some((track) => track.solo === true)
  const audibleByTrack = new Map(project.tracks.map((track) => [
    track.id,
    !(track.muted === true || (anySolo && track.solo !== true)),
  ]))

  /**
   * Dragging across a track selects a time range on that track — one of the three
   * selections spec §9.3 supports, and the one the acceptance script uses
   * ("框选鼓组 20–35 秒").
   *
   * The gesture is reachable two ways: pressing on an empty stretch of the track,
   * or Shift/Alt-dragging a clip, which is the only option when one clip covers
   * the whole track. Both resolve the coordinates against the track body, so the
   * range means the same thing either way.
   *
   * The band is committed when the pointer is released, as one range, so moving
   * the pointer does not spam the parent with new state per frame.
   */
  const startRange = useCallback((event, track) => {
    const box = event.target?.closest?.('[data-track-body]')?.getBoundingClientRect()
      ?? event.currentTarget?.getBoundingClientRect?.()
    if (!box) return
    const at = Math.max(0, Math.min(duration, (event.clientX - box.left) / scale))
    rangeRef.current = { trackId: track.id, anchorSec: at, pointerId: event.pointerId }
    setRangeDrag(true)
    onRange?.({ trackId: track.id, fromSec: at, toSec: at })
  }, [duration, scale, onRange])

  /**
   * Dragging the divider between a track head and its waveform changes how wide
   * the heads are.
   *
   * The heads were a fixed 148px, which is enough for a short name but not for
   * `M/S/FX/✕` plus two faders once the numbers grow — and the user asked for it,
   * having found the `↔` cursor there. That cursor was a clip's trim handle: a
   * clip starting at 0s has its left edge exactly against the head, so the handle
   * sat where a divider would be. Giving the divider its own hit area above the
   * tracks (the ruler corner) makes the gesture honest instead of a misfire.
   */
  const startHeadDrag = useCallback((event) => {
    event.preventDefault()
    event.stopPropagation()
    headDragRef.current = { startX: event.clientX, startWidth: headWidth }
    setHeadDragging(true)
  }, [headWidth])

  useEffect(() => {
    if (!headDragging) return undefined
    const move = (event) => {
      const head = headDragRef.current
      if (!head) return
      const next = Math.max(HEAD_MIN, Math.min(HEAD_MAX, head.startWidth + (event.clientX - head.startX)))
      setHeadWidth(next)
    }
    const finish = () => {
      headDragRef.current = null
      setHeadDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [headDragging])

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
      // A click on empty track space clears the range and the clip selection
      // rather than leaving a zero-width one: clicking away from a clip is the
      // mouse equivalent of Escape.
      if (range && range.toSec - range.fromSec < 0.05) {
        onRange?.(null)
        onClearSelection?.()
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
  }, [rangeDrag, scale, duration, onRange, range, onClearSelection])

  const onCommit = useCallback((deltaSec, payload) => {
    onEdit?.({ kind: payload.kind, deltaSec, trackId: payload.trackId, itemId: payload.itemId, edge: payload.edge })
  }, [onEdit])

  const startDrag = useCallback((event, track, item) => {
    event.preventDefault()
    event.stopPropagation()
    // Shift or Alt turns the same gesture into a range selection. A track that is
    // covered by one long clip has no empty stretch to press on, so the modifier
    // is the only way to cite a range there (spec §8.1, §15 step 6).
    if (event.shiftKey || event.altKey) {
      startRange(event, track)
      return
    }
    onSelect?.(track.id, item.id)
    const edge = event.target?.dataset?.edge
    dragRef.current = {
      startX: event.clientX,
      pointerId: event.pointerId,
      payload: { kind: edge ? 'trim' : 'move', trackId: track.id, itemId: item.id, edge },
    }
    setDrag({ kind: edge ? 'trim' : 'move', trackId: track.id, itemId: item.id, edge, deltaSec: 0 })
  }, [onSelect, startRange])

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

  // Delete / Ctrl+D act on the selection; Ctrl+Z / Ctrl+Shift+Z walk the history;
  // Escape clears the selection and any dragged range.
  useEffect(() => {
    const onKey = (event) => {
      const tag = event.target?.tagName
      // Escape is checked before the typing guard on purpose. After editing a
      // field in the properties panel the focus sits in an `<input>`, and the
      // guard below would swallow the key — so the one gesture the person would
      // reach for to leave the selection did nothing exactly when they had just
      // been editing it.
      if (event.key === 'Escape') {
        event.preventDefault()
        if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) event.target.blur()
        onClearSelection?.()
        return
      }
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
  }, [selection, onEdit, onUndo, onRedo, onClearSelection])

  const seekTo = useCallback((seconds) => {
    transport?.seek?.(Math.max(0, Math.min(duration, seconds)))
  }, [transport, duration])

  useEffect(() => {
    const onKey = (event) => {
      const target = event.target
      const tag = target?.tagName
      // Space belongs to the transport, always. Only a field that is being typed
      // into may keep it.
      //
      // A focused button is the case that matters: after clicking 静音 the button
      // keeps focus, and the browser activates it on Space, so the transport key
      // silently toggles mute instead. Bailing out on BUTTON (tried first) is
      // wrong for the same reason in reverse — Space would then do nothing at all.
      // The answer is to consume the key and drop the focus, so the next Space
      // goes straight to the transport.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (event.code === 'Space') {
        event.preventDefault()
        if (tag === 'BUTTON' || tag === 'A') target.blur()
        if (transport?.playing) transport.pause()
        else transport?.play?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [transport])

  const dragPreview = drag ? { trackId: drag.trackId, itemId: drag.itemId, deltaSec: drag.deltaSec } : null
  const playheadX = positionSec * scale

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 } },
    // One compact row. Every pixel here comes out of the track area, so the
    // transport is icon-only (title carries the word) and the track count is
    // printed once, in the header, not again beside the zoom.
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 22 } },
      h(Btn, {
        onClick: () => (transport?.playing ? transport.pause() : transport?.play?.()),
        kind: 'primary',
        title: transport?.playing ? t('暂停') : t('播放'),
        style: { padding: '2px 10px', fontSize: 12, lineHeight: 1.3 },
      }, transport?.playing ? '❚❚' : '▶'),
      h('span', { style: { ...S.mono, fontSize: 11, minWidth: 92 } }, `${clockLabel(positionSec)} / ${clockLabel(duration)}`),
      h('span', { style: { flex: 1 } }),
      h(Btn, { onClick: () => setScale((value) => Math.max(10, value / 1.5)), title: t('缩小'), style: { padding: '0 7px', fontSize: 12, lineHeight: 1.5 } }, '−'),
      h('span', { style: { ...S.mono, fontSize: 10, minWidth: 46, textAlign: 'center' } }, `${Math.round(scale)} px/s`),
      h(Btn, { onClick: () => setScale((value) => Math.min(600, value * 1.5)), title: t('放大'), style: { padding: '0 7px', fontSize: 12, lineHeight: 1.5 } }, '+'),
    ),
    transport?.error ? h('div', { style: S.notice('error') }, transport.error) : null,
    h('div', {
      // The only scrolling area in the panel: the transport row above and the
      // ruler inside stay put, so the person never loses the time reference
      // while scrolling a tall project.
      style: {
        border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'auto',
        flex: 1, minHeight: 0, background: C.softer,
      },
    },
      h('div', { style: { width: headWidth + duration * scale, minWidth: '100%', position: 'relative' } },
        h('div', {
          // Sticky ruler: it is the one thing that must stay visible while the
          // tracks scroll under it (the "frozen pane" the user asked for).
          style: {
            display: 'flex', position: 'sticky', top: 0, zIndex: 2,
            background: surface, borderBottom: `1px solid ${C.border}`,
          },
        },
          h('div', {
            // The ruler's corner stays put on both axes, or the labels would
            // slide under it when the timeline scrolls sideways.
            style: {
              width: headWidth, flex: '0 0 auto', borderRight: `1px solid ${C.border}`,
              position: 'sticky', left: 0, zIndex: 3, background: surface,
              cursor: 'col-resize',
            },
            title: t('拖动调整轨道头宽度'),
            onPointerDown: startHeadDrag,
          }),
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
            headWidth,
            audible: audibleByTrack.get(track.id) !== false,
            levelDb: trackLevel(track),
            active: track.id === activeTrackId,
            onSelect: () => setActiveTrackId(track.id),
            onEdit: (request) => onEdit?.({ ...request, trackId: track.id }),
            drag: { preview: dragPreview },
            selection,
            onClipPointerDown: startDrag,
            onClipSelect: (trackId, itemId) => onSelect?.(trackId, itemId),
            range,
            surface,
            onRangeStart: startRange,
          })),
        h('div', {
          style: {
            position: 'absolute', top: 0, bottom: 0, width: 1, zIndex: 1,
            left: headWidth + playheadX, background: C.accent, pointerEvents: 'none',
          },
        }),
      ),
    ),
  )
}
