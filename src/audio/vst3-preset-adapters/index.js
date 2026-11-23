/**
 * 预设适配器注册表。新增一个厂商 = 新增一个模块并加进这个数组；
 * 核心 vst3-presets.js 不认任何厂商名。
 */
import { ampleSoundAdapter } from './ample-sound.js'

export const PRESET_ADAPTERS = [ampleSoundAdapter]
