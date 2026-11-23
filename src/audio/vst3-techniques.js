/**
 * Ample Sound 音源的演奏法常量：键位、力度语义、效果音。
 *
 * 数据来源：D:\AnyAudio研究\vst3-spike\演奏法速查表.md（说明书 + 实测）。
 * 键位一律用 MIDI 编号，避免说明书 C1=36 与 C0=24 两种记法混用。
 */

/** 键位音本身不出声，要在目标音前这么短的时间发一下（秒）。 */
export const KEYSWITCH_LEAD_SEC = 0.02

/** 键位音按住的时长（秒）：短促一按即可，太长会被当成独立音符。 */
export const KEYSWITCH_HOLD_SEC = 0.02

/**
 * 四个核心演奏法，吉他与贝斯完全一致。
 * 用法：先发一个很短的键位音，紧接着发目标音；键位音本身不出声。
 */
export const ARTICULATIONS = [
  { id: 'sus', keyswitch: 24, name: '长音 / 重音（Sus）' },
  { id: 'pm', keyswitch: 26, name: '手掌闷音（PM）' },
  { id: 'ls', keyswitch: 28, name: '滑音连奏（LS）' },
  { id: 'hp', keyswitch: 30, name: '击勾连奏（HP）' },
]

/** 吉他专属效果音：直接当音符弹，不是键位。 */
export const GUITAR_FX_SOUNDS = [
  { id: 'scratch', keyswitch: 77, name: '滑弦噪音（Scratch）' },
  { id: 'slap', keyswitch: 78, name: '打弦噪音（Slap）' },
  { id: 'muting', keyswitch: 79, name: '护弦制音（Muting）' },
  { id: 'strum-mute', keyswitch: 80, name: '扫弦制音（Strum Mute）' },
  { id: 'downstroke-1', keyswitch: 81, name: '下扫噪音 1' },
  { id: 'upstroke-1', keyswitch: 82, name: '上扫噪音 1' },
  { id: 'downstroke-2', keyswitch: 83, name: '下扫噪音 2' },
  { id: 'upstroke-2', keyswitch: 84, name: '上扫噪音 2' },
  { id: 'body-open', keyswitch: 89, name: '拍上面板（开放）' },
  { id: 'body-muted', keyswitch: 90, name: '拍上面板（闷音）' },
  { id: 'body-side', keyswitch: 91, name: '拍侧面板' },
]

/** 吉他专属控制键：开关和选择，不是演奏法。 */
export const GUITAR_CONTROL_KEYS = {
  stringSelect: { low: 31, high: 36, name: '弦指定：G0=6 弦 … C1=1 弦（大力度会改把位）' },
  positionSelect: { keyswitch: 37, name: '把位指定入口，再按 E1–G#2（40–56）选 0–16 把位' },
  repeatNote: { keyswitch: 86, name: '重复键：重复当前音符（支持复音）' },
  autoLegato: { keyswitch: 87, name: '自动连奏：大力度=自动滑音，小力度=自动击勾' },
  openStringFirst: { keyswitch: 92, name: '空弦优先：大力度开，小力度关' },
}

/** 贝斯专属键位。 */
export const BASS_KEYS = {
  pullOff: { keyswitch: 21, name: '勾弦：大力度=勾弦，小力度=哑音勾弦' },
}

/**
 * 力度语义：同一个力度值在两种乐器上含义不同。
 * 吉他 127 触发 Pop（重勾）；贝斯超过 125 是重音（Accent）。
 */
export const VELOCITY = {
  guitar: {
    longMax: 127,
    popAt: 127,
    note: '≤127 长音；127 触发 Pop（重勾）',
  },
  bass: {
    longMax: 125,
    accentMin: 126,
    note: '≤125 长音；>125 重音（Accent）；大力度闷音、小力度哑音',
  },
}
