/**
 * Browser-side primitives shared by every panel.
 *
 * `h` is React.createElement: the bundle is built by scripts/build-client.mjs
 * with no JSX transform, so markup stays plain function calls.
 */
import { createElement } from 'react'

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

export function Btn({ children, onClick, kind, disabled, style }) {
  return h('button', { type: 'button', onClick, disabled, style: { ...S.btn(kind, disabled), ...style } }, children)
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

export function NumberInput({ value, onChange, step }) {
  return h('input', {
    type: 'number',
    step: step || '0.1',
    value: value ?? '',
    onChange: event => onChange(event.target.value === '' ? '' : Number(event.target.value)),
    style: S.input,
  })
}

export function Select({ value, onChange, options }) {
  return h('select', { value, onChange: event => onChange(event.target.value), style: S.input },
    options.map(option => h('option', { key: option.value, value: option.value }, option.label)),
  )
}

export function Switch({ checked, onChange, label }) {
  return h('label', { style: { ...S.row, gap: 6, cursor: 'pointer' } },
    h('input', { type: 'checkbox', checked: Boolean(checked), onChange: event => onChange(event.target.checked) }),
    h('span', { style: { fontSize: 12 } }, label),
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
