/**
 * Clip properties (plan M5.4).
 *
 * The panel edits the selected clip's own gain, pan, fades and mute. They are the
 * same fields the renderer reads, so what is dialled here is what an export
 * contains — no separate preview-only values.
 */
import { h, S, Btn, NumberInput, Switch } from '../ui.js'
import { t } from '../i18n.js'
import { itemLength } from './edit.js'
import { clockLabel } from './timeline.js'

export function ClipProperties({ selection, track, item, onEdit }) {
  if (!selection || !item) {
    return h('div', { style: S.desc }, t('选中一个片段后可以在这里改增益、声像和淡入淡出。'))
  }

  const length = itemLength(item)

  return h('div', { style: { ...S.card, gap: 8 } },
    h('div', { style: S.cardHead },
      h('div', { style: S.cardTitle }, item.label || item.id),
      h('span', { style: S.chip }, `${clockLabel(item.startSec)} → ${clockLabel(item.startSec + length)}`),
      h('span', { style: S.chip }, `${length.toFixed(2)}s`),
    ),
    h('div', { style: S.grid2 },
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
    ),
    h('div', { style: S.row },
      h(Switch, {
        checked: item.muted,
        label: t('静音这个片段'),
        onChange: (checked) => onEdit({ kind: 'mute', muted: checked }),
      }),
      h('span', { style: { flex: 1 } }),
      h(Btn, { onClick: () => onEdit({ kind: 'split' }) }, t('在播放头分割')),
      h(Btn, { onClick: () => onEdit({ kind: 'duplicate' }) }, t('复制')),
      h(Btn, { onClick: () => onEdit({ kind: 'delete' }) }, t('删除')),
    ),
    track ? h('p', { style: S.desc }, `${t('所属轨道')}：${track.name} · ${track.volumeDb} dB${track.pan ? ` · ${t('声像')} ${track.pan}` : ''}`) : null,
  )
}
