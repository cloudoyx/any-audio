/**
 * Browser-side primitives shared by every panel.
 *
 * `h` is React.createElement: the bundle is built by scripts/build-client.mjs
 * with no JSX transform, so markup stays plain function calls.
 */
import { createElement, useEffect, useState } from 'react'

export const h = createElement
export { Fragment, useState, useEffect, useRef, useCallback, useMemo } from 'react'

export const C = {
  border: 'rgba(128,128,128,0.28)',
  soft: 'rgba(128,128,128,0.10)',
  softer: 'rgba(128,128,128,0.06)',
  text: 'inherit',
  muted: 'rgba(128,128,128,0.95)',
  accent: '#4f7cff',
  good: '#2ea36b',
  warn: '#c9822a',
  bad: '#c0504d',
}

/**
 * The first opaque background above `node`, as a CSS colour.
 *
 * The timeline's track heads are sticky and must be opaque, or clips scroll
 * through them. The shell's own background is not a fixed colour (light and
 * dark themes differ), so it is read from the DOM instead of guessed.
 */
export function surfaceOf(node) {
  if (typeof document === 'undefined') return '#ffffff'
  let current = node
  while (current && current !== document.documentElement) {
    const value = getComputedStyle(current).backgroundColor
    const match = value && value.match(/rgba?\(([^)]+)\)/)
    if (match) {
      const parts = match[1].split(',').map(Number)
      const alpha = parts.length > 3 ? parts[3] : 1
      if (alpha > 0.5) return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`
    }
    current = current.parentElement
  }
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  return dark ? '#1c1d21' : '#ffffff'
}

/** The shell background, for surfaces that must be opaque. Read once per mount. */
export function useSurface() {
  const [value, setValue] = useState('#ffffff')
  useEffect(() => {
    const node = document.querySelector('[data-conversation-composer-overlay]') || document.body
    setValue(surfaceOf(node))
  }, [])
  return value
}

export const S = {
  page: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 900, padding: '4px 2px 32px', fontSize: 13, lineHeight: 1.55 },
  // The workbench fills whatever width the view gets: a timeline that stops at
  // 900px wastes most of a wide screen, and every pixel is another second of
  // waveform. The settings page keeps `page` — a form reads worse when stretched.
  workbench: { display: 'flex', flexDirection: 'column', gap: 10, width: '100%', minWidth: 0, padding: '4px 8px 16px', fontSize: 13, lineHeight: 1.55, boxSizing: 'border-box' },
  header: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  title: { margin: 0, fontSize: 18, fontWeight: 600 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, border: `1px solid ${C.border}`, fontSize: 11, color: C.muted, whiteSpace: 'nowrap' },
  tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' },
  tab: active => ({ padding: '6px 12px', borderRadius: '6px 6px 0 0', border: `1px solid ${active ? C.border : 'transparent'}`, borderBottom: 'none', background: active ? C.soft : 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 13 }),
  card: { border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
  cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  cardTitle: { fontWeight: 600, fontSize: 14 },
  desc: { color: C.muted, fontSize: 12, margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180, flex: '1 1 180px' },
  label: { fontSize: 12, color: C.muted },
  input: { border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', background: 'transparent', color: 'inherit', fontSize: 13, width: '100%', boxSizing: 'border-box' },
  btn: (kind = 'normal', disabled = false) => ({ border: `1px solid ${kind === 'primary' ? C.accent : C.border}`, background: kind === 'primary' ? C.accent : 'transparent', color: kind === 'primary' ? '#fff' : 'inherit', borderRadius: 6, padding: '4px 10px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, opacity: disabled ? 0.5 : 1 }),
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  item: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 },
  itemHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11, color: C.muted, wordBreak: 'break-all' },
  bar: { height: 6, background: C.soft, borderRadius: 999, overflow: 'hidden' },
  barFill: pct => ({ height: '100%', width: `${Math.min(100, Math.max(0, pct))}%`, background: C.accent, transition: 'width .2s' }),
  notice: tone => ({ border: `1px solid ${tone === 'error' ? C.bad : tone === 'warn' ? C.warn : C.border}`, background: C.softer, borderRadius: 8, padding: '7px 10px', fontSize: 12, color: tone === 'error' ? C.bad : 'inherit' }),
  audio: { width: '100%', marginTop: 6 },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
}

export function bytes(value) {
  if (!Number.isFinite(value)) return ''
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

export function Btn({ children, onClick, kind, disabled, style, title }) {
  return h('button', { type: 'button', onClick, disabled, title, style: { ...S.btn(kind, disabled), ...style } }, children)
}

export function Field({ label, hint, children }) {
  return h('div', { style: S.field },
    h('span', { style: S.label }, label),
    children,
    hint ? h('span', { style: { ...S.desc, fontSize: 11 } }, hint) : null,
  )
}

export function TextInput({ value, onChange, placeholder, type }) {
  return h('input', {
    type: type || 'text',
    value: value ?? '',
    placeholder,
    onChange: event => onChange(event.target.value),
    style: S.input,
    spellCheck: false,
  })
}

export function NumberInput({ value, onChange, step, style, title }) {
  return h('input', {
    type: 'number',
    step: step || '0.1',
    value: value ?? '',
    title,
    onChange: event => onChange(event.target.value === '' ? '' : Number(event.target.value)),
    style: { ...S.input, ...style },
  })
}

/**
 * A track-head fader.
 *
 * A bare `input[type=range]` renders the browser's chunky track with a thick
 * accent-coloured fill, which is both louder than a track head should be and
 * impossible to slim down from an inline style — pseudo-elements need a real
 * stylesheet. One rule set is injected once and every fader in the plugin uses
 * it, so the heads read as thin DAW faders instead of form controls.
 */
const SLIDER_CSS = [
  '.aa-slider{-webkit-appearance:none;appearance:none;background:transparent;margin:0;display:block}',
  '.aa-slider:focus{outline:none}',
  '.aa-slider::-webkit-slider-runnable-track{height:3px;border-radius:999px;background:rgba(128,128,128,0.34)}',
  '.aa-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:9px;height:9px;margin-top:-3px;border:none;border-radius:50%;background:#4f7cff}',
  '.aa-slider::-moz-range-track{height:3px;border-radius:999px;background:rgba(128,128,128,0.34)}',
  '.aa-slider::-moz-range-thumb{width:9px;height:9px;border:none;border-radius:50%;background:#4f7cff}',
].join('')

function ensureSliderCss() {
  if (typeof document === 'undefined' || !document.head) return
  if (document.getElementById('anyaudio-slider-css')) return
  const style = document.createElement('style')
  style.id = 'anyaudio-slider-css'
  style.textContent = SLIDER_CSS
  document.head.appendChild(style)
}

ensureSliderCss()

export function Slider({ value, min, max, step, onChange, title, disabled }) {
  ensureSliderCss()
  return h('input', {
    type: 'range',
    className: 'aa-slider',
    min,
    max,
    step,
    value,
    title,
    disabled,
    onChange: event => onChange(Number(event.target.value)),
    onClick: event => event.stopPropagation(),
    onPointerDown: event => event.stopPropagation(),
    style: { flex: 1, minWidth: 0, height: 12, cursor: 'pointer' },
  })
}

export function Select({ value, onChange, options }) {
  return h('select', { value, onChange: event => onChange(event.target.value), style: S.input },
    options.map(option => h('option', { key: option.value, value: option.value }, option.label)),
  )
}

export function Switch({ checked, onChange, label, title }) {
  return h('label', { style: { ...S.row, gap: 6, cursor: 'pointer' }, title },
    h('input', { type: 'checkbox', checked: Boolean(checked), onChange: event => onChange(event.target.checked) }),
    label ? h('span', { style: { fontSize: 12 } }, label) : null,
  )
}

export function Notice({ children, tone }) {
  if (!children) return null
  return h('div', { style: S.notice(tone) }, children)
}

export function Card({ title, desc, right, children }) {
  return h('section', { style: S.card },
    h('div', { style: S.cardHead },
      h('div', null,
        h('div', { style: S.cardTitle }, title),
        desc ? h('p', { style: S.desc }, desc) : null,
      ),
      right || null,
    ),
    children,
  )
}
