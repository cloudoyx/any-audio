/**
 * The effect-chain editor (improvement plan 02, I-07).
 *
 * One component for all three levels, because a chain is a chain: a clip, a
 * track and the bus differ in where the audio goes, not in how a compressor is
 * described. The caller says which level it is editing and gets a whole chain
 * back; the mutators in `edit.js` replace it as one unit, so history reads
 * "set the track chain" rather than three separate inserts.
 *
 * What it deliberately does not do: preview a change by itself. Every edit goes
 * through the same `onChange` the faders use, which means it reaches the live
 * graph the moment it is applied — an effect you cannot hear while you turn it
 * is an effect you will get wrong.
 */
import { h, S, Btn, NumberInput, Slider, Switch, C, Select } from '../ui.js'
import { t } from '../i18n.js'
import { FX_TYPES, MAX_EQ_BANDS, defaultFx, resolveFx } from '../../audio/fx.js'

const FX_LABELS = {
  eq: 'EQ',
  compressor: '压缩',
  limiter: '限幅',
  reverb: '混响',
  delay: '延迟',
  duck: '侧链',
  pitch: '变速变调',
}

const FX_HINTS = {
  eq: '按频段加减；六段够用',
  compressor: '超过阈值就压，人声更贴',
  limiter: '封顶，保证不削波',
  reverb: '空间感；与导出一致',
  delay: '回声；反馈决定衰减',
  duck: '旁白出现时压低这条',
  pitch: '变速/变调；与导出一致',
}

const cellInput = { padding: '2px 5px', fontSize: 11, height: 22 }
const tinyBtn = { padding: '1px 5px', fontSize: 10, lineHeight: 1.3 }

function field(label, control) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
    h('span', { style: { fontSize: 9, color: C.muted, whiteSpace: 'nowrap' } }, label),
    control,
  )
}

function numberField(label, value, onChange, { step = '0.1', min, max } = {}) {
  return field(label, h(NumberInput, {
    value,
    step,
    style: cellInput,
    onChange: (next) => onChange(Number(next)),
    title: min !== undefined ? `${min} – ${max}` : undefined,
  }))
}

function sliderField(label, value, onChange, { min = 0, max = 1, step = 0.01 } = {}) {
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 } },
    h('span', { style: { ...S.mono, fontSize: 9, minWidth: 54, color: C.muted } }, `${label} ${Number(value).toFixed(2)}`),
    h(Slider, { min, max, step, value, onChange, title: label }),
  )
}

/** One effect's parameters, laid out compactly enough for a 220px column. */
function FxParams({ fx, onChange, tracks }) {
  const set = (patch) => onChange({ ...fx, ...patch })
  switch (fx.type) {
    case 'eq': {
      const bands = fx.bands ?? []
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        ...bands.map((band, index) => h('div', { key: index, style: { display: 'grid', gridTemplateColumns: '58px 1fr 1fr 1fr 16px', gap: 2, alignItems: 'end' } },
          field(t('类型'), h(Select, {
            value: band.type,
            options: [
              { value: 'peaking', label: t('峰值') },
              { value: 'lowshelf', label: t('低架') },
              { value: 'highshelf', label: t('高架') },
            ],
            onChange: (type) => {
              const next = bands.slice()
              next[index] = { ...band, type }
              set({ bands: next })
            },
          })),
          numberField('Hz', band.freqHz, (freqHz) => {
            const next = bands.slice()
            next[index] = { ...band, freqHz }
            set({ bands: next })
          }, { step: '10' }),
          numberField('dB', band.gainDb, (gainDb) => {
            const next = bands.slice()
            next[index] = { ...band, gainDb }
            set({ bands: next })
          }, { step: '0.5' }),
          numberField('Q', band.q, (q) => {
            const next = bands.slice()
            next[index] = { ...band, q }
            set({ bands: next })
          }, { step: '0.1' }),
          h(Btn, {
            onClick: () => set({ bands: bands.filter((_, i) => i !== index) }),
            title: t('删除这段'),
            style: tinyBtn,
          }, '✕'),
        )),
        bands.length < MAX_EQ_BANDS
          ? h(Btn, {
            onClick: () => set({ bands: [...bands, { type: 'peaking', freqHz: 1000, gainDb: 0, q: 1 }] }),
            style: tinyBtn,
          }, t('+ 频段'))
          : null,
      )
    }
    case 'compressor':
      return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 3 } },
        numberField(t('阈值 dB'), fx.thresholdDb, (thresholdDb) => set({ thresholdDb }), { step: '1' }),
        numberField(t('比率'), fx.ratio, (ratio) => set({ ratio }), { step: '0.5' }),
        numberField(t('增益 dB'), fx.makeupDb, (makeupDb) => set({ makeupDb }), { step: '0.5' }),
        numberField(t('起音 s'), fx.attackSec, (attackSec) => set({ attackSec }), { step: '0.005' }),
        numberField(t('释放 s'), fx.releaseSec, (releaseSec) => set({ releaseSec }), { step: '0.01' }),
        numberField(t('膝 dB'), fx.kneeDb, (kneeDb) => set({ kneeDb }), { step: '1' }),
      )
    case 'limiter':
      return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 } },
        numberField(t('封顶 dB'), fx.ceilingDb, (ceilingDb) => set({ ceilingDb }), { step: '0.5' }),
        numberField(t('释放 s'), fx.releaseSec, (releaseSec) => set({ releaseSec }), { step: '0.01' }),
      )
    case 'reverb':
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        sliderField(t('房间'), fx.roomSize, (roomSize) => set({ roomSize })),
        sliderField(t('阻尼'), fx.damping, (damping) => set({ damping })),
        sliderField(t('湿声'), fx.wet, (wet) => set({ wet })),
        sliderField(t('干声'), fx.dry, (dry) => set({ dry })),
        sliderField(t('宽度'), fx.width, (width) => set({ width })),
      )
    case 'delay':
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 } },
          numberField(t('时间 s'), fx.timeSec, (timeSec) => set({ timeSec }), { step: '0.01' }),
          numberField(t('反馈'), fx.feedback, (feedback) => set({ feedback }), { step: '0.05' }),
        ),
        sliderField(t('湿声'), fx.wet, (wet) => set({ wet })),
        sliderField(t('干声'), fx.dry, (dry) => set({ dry })),
        h(Switch, { checked: fx.pingPong, label: t('乒乓'), onChange: (pingPong) => set({ pingPong }) }),
      )
    case 'duck':
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        field(t('侧链来源'), h(Select, {
          value: fx.sourceTrackId ?? '',
          options: [{ value: '', label: t('选择轨道') }, ...(tracks ?? []).map((track) => ({ value: track.id, label: track.name }))],
          onChange: (sourceTrackId) => set({ sourceTrackId }),
        })),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 } },
          numberField(t('压低 dB'), fx.targetDb, (targetDb) => set({ targetDb }), { step: '0.5' }),
          numberField(t('阈值 dB'), fx.thresholdDb, (thresholdDb) => set({ thresholdDb }), { step: '1' }),
          numberField(t('起音 s'), fx.attackSec, (attackSec) => set({ attackSec }), { step: '0.01' }),
          numberField(t('释放 s'), fx.releaseSec, (releaseSec) => set({ releaseSec }), { step: '0.01' }),
        ),
      )
    case 'pitch':
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 } },
          numberField(t('速率'), fx.rate, (rate) => set({ rate }), { step: '0.05' }),
          numberField(t('半音'), fx.pitchSemitones, (pitchSemitones) => set({ pitchSemitones }), { step: '1' }),
        ),
        h(Switch, {
          checked: fx.preservePitch,
          label: t('保持音高'),
          title: t('打开：只改变长度，音高不变'),
          onChange: (preservePitch) => set({ preservePitch }),
        }),
      )
    default:
      return null
  }
}

/**
 * The chain itself.
 *
 * `level` names what is being edited ('clip' | 'track' | 'master') and is only
 * used for the title; `onChange` receives the whole new chain, so every mutation
 * is one history entry.
 */
export function FxEditor({ level, chain, tracks, onChange, disabled, disabledHint }) {
  const list = Array.isArray(chain) ? chain : []
  const title = level === 'master' ? t('总线效果') : level === 'track' ? t('轨道效果') : t('片段效果')

  const move = (index, delta) => {
    const target = index + delta
    if (target < 0 || target >= list.length) return
    const next = list.slice()
    const [entry] = next.splice(index, 1)
    next.splice(target, 0, entry)
    onChange(next)
  }

  if (disabled) {
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { fontSize: 11, fontWeight: 600, flex: 1 } }, title),
      ),
      h('p', { style: { ...S.desc, fontSize: 10, margin: 0 } }, disabledHint ?? t('先选中一个片段')),
    )
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      h('span', { style: { fontSize: 11, fontWeight: 600, flex: 1 } }, title),
      h('span', { style: { ...S.mono, fontSize: 10 } }, `${list.length}`),
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
      h('div', { style: { flex: 1, minWidth: 0 } },
        h(Select, {
          value: '',
          options: [
            { value: '', label: t('+ 添加效果') },
            ...FX_TYPES.map((type) => ({ value: type, label: t(FX_LABELS[type]) })),
          ],
          onChange: (type) => {
            if (!type) return
            onChange([...list, defaultFx(type)])
          },
        }),
      ),
    ),
    list.length === 0
      ? h('p', { style: { ...S.desc, fontSize: 10, margin: 0 } }, t('这条链是空的，声音原样通过。'))
      : null,
    ...list.map((raw, index) => {
      // Resolved, not raw: an effect written before a field existed still shows
      // the value the renderer will actually use, instead of an empty box.
      const fx = resolveFx(raw)
      return h('div', {
        key: `${fx.type}-${index}`,
        style: { border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 5px', display: 'flex', flexDirection: 'column', gap: 3, background: C.softer },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 3 } },
          h('span', { style: { fontSize: 11, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            `${index + 1}. ${t(FX_LABELS[fx.type] ?? fx.type)}`),
          h(Btn, { onClick: () => move(index, -1), disabled: index === 0, title: t('上移'), style: tinyBtn }, '↑'),
          h(Btn, { onClick: () => move(index, 1), disabled: index === list.length - 1, title: t('下移'), style: tinyBtn }, '↓'),
          h(Btn, {
            onClick: () => onChange(list.filter((_, i) => i !== index)),
            title: t('删除这个效果'),
            style: tinyBtn,
          }, '✕'),
        ),
        h(FxParams, {
          fx,
          tracks,
          onChange: (next) => {
            const copy = list.slice()
            copy[index] = next
            onChange(copy)
          },
        }),
        FX_HINTS[fx.type]
          ? h('span', { style: { fontSize: 9, color: C.muted } }, t(FX_HINTS[fx.type]))
          : null,
      )
    }),
  )
}
