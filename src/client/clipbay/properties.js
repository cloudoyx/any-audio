/**
 * Clip properties (plan M5.4).
 *
 * The panel edits the selected clip's own gain, pan, fades and mute. They are the
 * same fields the renderer reads, so what is dialled here is what an export
 * contains — no separate preview-only values.
 *
 * It lives in a narrow column beside the picture (improvement plan 01, I-05), and
 * that column is only as tall as the picture — roughly 175px. Stacked one field
 * per line the contents needed 218px and 删除 fell below the fold, so everything
 * here is arranged to fit that budget: the fields sit two to a row, the time span
 * shares the title line, and the mute switch shares the action row.
 */
import { h, S, Btn, NumberInput, Switch, C } from '../ui.js'
import { t } from '../i18n.js'
import { itemLength } from './edit.js'
import { clockLabel } from './timeline.js'
import { FxEditor } from './fx-editor.js'

const cellInput = { padding: '2px 6px', fontSize: 12, height: 24 }
const smallBtn = { padding: '3px 6px', fontSize: 11 }

/** −12.3 dBFS, or an honest dash when nobody has measured the material. */
function dbLabel(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}` : '—'
}

/**
 * The three numbers that decide how loud a clip is (improvement plan 03, I-38).
 *
 * Without them a fader reading 0 dB is ambiguous: is that "the material as it is"
 * or "this track is at 0 dB"? Those are different questions with different
 * answers, and the only way to tell them apart is to show where the level comes
 * from: the file's measured RMS, the clip's own offset, and what the two add up
 * to. The first value never moves when the gain does — that is the whole point.
 */
function LevelStrip({ material, item }) {
  const sourceDb = typeof material?.rmsDb === 'number' && Number.isFinite(material.rmsDb) ? material.rmsDb : null
  const gainDb = Number(item?.gainDb) || 0
  const actualDb = sourceDb === null ? null : sourceDb + gainDb
  return h('div', {
    title: t('素材电平 → 片段增益 → 实际电平'),
    style: {
      display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap',
      border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 6px',
      background: C.softer, fontSize: 10, fontVariantNumeric: 'tabular-nums',
    },
  },
    h('span', { style: { color: '#9fc0ff', fontSize: 12, fontWeight: 600 } }, dbLabel(sourceDb)),
    h('span', { style: { color: C.muted } }, t('素材 dBFS')),
    h('span', { style: { color: C.muted } }, '→'),
    h('span', { style: { color: '#ffd08a', fontSize: 12, fontWeight: 600 } }, `${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)}`),
    h('span', { style: { color: C.muted } }, t('片段 dB')),
    h('span', { style: { color: C.muted } }, '→'),
    h('span', { style: { color: C.good, fontSize: 12, fontWeight: 600 } }, dbLabel(actualDb)),
    h('span', { style: { color: C.muted } }, t('实际 dBFS')),
    sourceDb === null
      ? h('span', { style: { color: C.muted } }, `· ${t('素材电平未知')}`)
      : null,
  )
}

/** A labelled field cell inside the two-column grid. */
function cell(label, control) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
    h('span', { style: { fontSize: 10, color: C.muted } }, label),
    control,
  )
}

export function ClipProperties({ selection, track, item, material, tracks, onEdit, onClear }) {
  if (!selection || !item) {
    return h('div', { style: { ...S.desc, padding: '2px 2px 0' } },
      t('选中一个片段后可以在这里改增益、声像和淡入淡出。'),
    )
  }

  const length = itemLength(item)

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 } },
      h('span', {
        title: `${item.label || item.id} · ${clockLabel(item.startSec)} → ${clockLabel(item.startSec + length)}`,
        style: { fontSize: 12, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, item.label || item.id),
      h('span', { style: { ...S.mono, fontSize: 10, flex: '0 0 auto' } },
        `${clockLabel(item.startSec)} → ${clockLabel(item.startSec + length)}`,
      ),
      onClear
        ? h(Btn, {
          onClick: onClear,
          title: t('取消选择'),
          style: { padding: '0 5px', fontSize: 10, lineHeight: 1.4, flex: '0 0 auto' },
        }, '✕')
        : null,
    ),
    h(LevelStrip, { material, item }),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 } },
      cell(t('增益 (dB)'), h(NumberInput, {
        value: item.gainDb,
        step: '0.5',
        style: cellInput,
        onChange: (value) => onEdit({ kind: 'gain', gainDb: Number(value) || 0 }),
      })),
      cell(t('声像 (-1=极左, 1=极右)'), h(NumberInput, {
        value: item.pan,
        step: '0.1',
        style: cellInput,
        onChange: (value) => onEdit({ kind: 'pan', pan: Number(value) || 0 }),
      })),
      cell(t('淡入 (秒)'), h(NumberInput, {
        value: item.fadeInSec,
        step: '0.1',
        style: cellInput,
        onChange: (value) => onEdit({ kind: 'fades', fadeInSec: Number(value) || 0 }),
      })),
      cell(t('淡出 (秒)'), h(NumberInput, {
        value: item.fadeOutSec,
        step: '0.1',
        style: cellInput,
        onChange: (value) => onEdit({ kind: 'fades', fadeOutSec: Number(value) || 0 }),
      })),
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
      h(Btn, { onClick: () => onEdit({ kind: 'split' }), title: t('在播放头分割'), style: smallBtn }, t('分割')),
      h(Btn, { onClick: () => onEdit({ kind: 'duplicate' }), style: smallBtn }, t('复制')),
      h(Btn, { onClick: () => onEdit({ kind: 'delete' }), style: smallBtn }, t('删除')),
      h('span', { style: { flex: 1 } }),
      h(Switch, {
        checked: item.muted,
        label: t('静音'),
        title: t('静音这个片段'),
        onChange: (checked) => onEdit({ kind: 'mute', muted: checked }),
      }),
    ),
    track
      ? h('p', {
        title: `${t('所属轨道')}：${track.name}`,
        style: { ...S.desc, fontSize: 10, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, track.name)
      : null,
    // The clip's own chain (I-07). It sits last in the column because it is the
    // longest block, and the fields a person reaches for first — gain, pan,
    // fades — have to stay where they were.
    h('div', { style: { borderTop: `1px solid ${C.border}`, paddingTop: 5, marginTop: 1 } },
      h(FxEditor, {
        level: 'clip',
        chain: item.fx,
        tracks,
        onChange: (chain) => onEdit({ kind: 'fx', chain }),
      }),
    ),
  )
}
