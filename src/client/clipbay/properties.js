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

/** A labelled field cell inside the two-column grid. */
function cell(label, control) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
    h('span', { style: { fontSize: 10, color: C.muted } }, label),
    control,
  )
}

export function ClipProperties({ selection, track, item, tracks, onEdit, onClear }) {
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
        title: `${t('所属轨道')}：${track.name} · ${track.volumeDb} dB`,
        style: { ...S.desc, fontSize: 10, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, `${track.name} · ${track.volumeDb} dB${track.pan ? ` · ${t('声像')} ${track.pan}` : ''}`)
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
