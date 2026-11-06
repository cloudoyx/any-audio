/**
 * Clip properties (plan M5.4).
 *
 * The panel edits the selected clip's own gain, pan, fades and mute. They are the
 * same fields the renderer reads, so what is dialled here is what an export
 * contains — no separate preview-only values.
 *
 * It lives in a narrow column beside the preview (improvement plan 01, I-05), so
 * the fields stack instead of sitting in a grid, and the action buttons wrap.
 */
import { h, S, Btn, NumberInput, Switch } from '../ui.js'
import { t } from '../i18n.js'
import { itemLength } from './edit.js'
import { clockLabel } from './timeline.js'

export function ClipProperties({ selection, track, item, onEdit }) {
  if (!selection || !item) {
    return h('div', { style: { ...S.desc, padding: '2px 2px 0' } },
      t('选中一个片段后可以在这里改增益、声像和淡入淡出。'),
    )
  }

  const length = itemLength(item)

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h('div', { style: { ...S.cardTitle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.label || item.id),
      h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
        h('span', { style: S.chip }, `${clockLabel(item.startSec)} → ${clockLabel(item.startSec + length)}`),
        h('span', { style: S.chip }, `${length.toFixed(2)}s`),
      ),
    ),
    h('div', { style: S.field },
      h('span', { style: S.label }, t('增益 (dB)')),
      h(NumberInput, {
        value: item.gainDb,
        step: '0.5',
        onChange: (value) => onEdit({ kind: 'gain', gainDb: Number(value) || 0 }),
      }),
    ),
    h('div', { style: S.field },
      h('span', { style: S.label }, t('声像 (-1 左 / +1 右)')),
      h(NumberInput, {
        value: item.pan,
        step: '0.1',
        onChange: (value) => onEdit({ kind: 'pan', pan: Number(value) || 0 }),
      }),
    ),
    h('div', { style: S.field },
      h('span', { style: S.label }, t('淡入 (秒)')),
      h(NumberInput, {
        value: item.fadeInSec,
        step: '0.1',
        onChange: (value) => onEdit({ kind: 'fades', fadeInSec: Number(value) || 0 }),
      }),
    ),
    h('div', { style: S.field },
      h('span', { style: S.label }, t('淡出 (秒)')),
      h(NumberInput, {
        value: item.fadeOutSec,
        step: '0.1',
        onChange: (value) => onEdit({ kind: 'fades', fadeOutSec: Number(value) || 0 }),
      }),
    ),
    h(Switch, {
      checked: item.muted,
      label: t('静音这个片段'),
      onChange: (checked) => onEdit({ kind: 'mute', muted: checked }),
    }),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
      h(Btn, { onClick: () => onEdit({ kind: 'split' }) }, t('在播放头分割')),
      h(Btn, { onClick: () => onEdit({ kind: 'duplicate' }) }, t('复制')),
      h(Btn, { onClick: () => onEdit({ kind: 'delete' }) }, t('删除')),
    ),
    track ? h('p', { style: { ...S.desc, fontSize: 11 } }, `${t('所属轨道')}：${track.name} · ${track.volumeDb} dB${track.pan ? ` · ${t('声像')} ${track.pan}` : ''}`) : null,
  )
}
