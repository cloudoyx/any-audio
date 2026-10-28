// Curated sound-effect presets available in the two default banks.
// Measurements come from a 4 s C4/velocity-100 render at 24 kHz:
// riseSec = time to the loudest sample, lengthSec = time until the tail drops
// below -50 dBFS (one-shots only), peakDb = sample peak, zcr = zero crossings/s.

export const SFX_FONTS = ['generaluser', 'musescore-general']

export const SFX_GROUPS = {
  noise: '拟音噪声 / 机械细节',
  weather: '天气与水',
  animals: '动物',
  home: '家居与物件',
  traffic: '交通与机械',
  crowd: '人群与人声',
  weapons: '武器与冲击',
}

const ROWS = [
  ['generaluser', 'fret-noise', 'Fret Noise', '品丝摩擦', 120, 0, 'noise', 'one-shot', 0.07, 0.53, -25.7, 5426, ['吉他', '细节']],
  ['generaluser', 'cut-noise', 'Cut Noise', '切断噪声', 120, 1, 'noise', 'one-shot', 0.02, 0.31, -24.5, 1336, ['转场', '短促']],
  ['generaluser', 'string-slap', 'String Slap', '拍弦', 120, 2, 'noise', 'one-shot', 0.01, 0.17, -21.8, 276, ['低频', '打击']],
  ['generaluser', 'breath-noise', 'Breath Noise', '气声', 121, 0, 'noise', 'one-shot', 0.08, 0.46, -34.5, 4094, ['气口', '安静']],
  ['generaluser', 'key-click', 'Fl. Key Click', '按键咔哒', 121, 1, 'noise', 'one-shot', 0.0, 0.03, -26.0, 5878, ['UI', '短促']],
  ['generaluser', 'filter-snap', 'Filter Snap', '滤波啪声', 121, 11, 'noise', 'one-shot', 0.01, 0.1, -24.1, 41, ['低频', '转场']],
  ['generaluser', 'seashore', 'Seashore', '海岸', 122, 0, 'weather', 'sustained', 1.57, null, -19.9, 3616, ['海', '空镜']],
  ['generaluser', 'rain', 'Rain', '雨', 122, 1, 'weather', 'sustained', 3.06, null, -28.0, 6657, ['雨', '起音慢']],
  ['generaluser', 'thunder', 'Thunder', '雷', 122, 2, 'weather', 'one-shot', 1.42, 3.53, -17.9, 633, ['雷', '低频']],
  ['generaluser', 'wind', 'Wind', '风', 122, 3, 'weather', 'sustained', 0.84, null, -21.9, 1210, ['风', '户外']],
  ['generaluser', 'stream', 'Stream', '溪流', 122, 4, 'weather', 'sustained', 2.7, null, -17.1, 3218, ['水', '中频']],
  ['generaluser', 'bubbles', 'Bubbles', '气泡', 122, 5, 'weather', 'sustained', 3.6, null, -17.9, 1541, ['水下', '气泡']],
  ['generaluser', 'howling-winds', 'Howling Winds', '呼啸风', 122, 11, 'weather', 'sustained', 2.5, null, -32.2, 622, ['风', '安静']],
  ['generaluser', 'white-noise-wave', 'White Noise Wave', '白噪浪', 122, 12, 'weather', 'sustained', 3.17, null, -27.6, 12389, ['白噪', '瀑布']],
  ['generaluser', 'birds', 'Birds', '鸟鸣', 123, 0, 'animals', 'sustained', 0.88, null, -21.4, 6982, ['清晨', '林间']],
  ['generaluser', 'dog', 'Dog', '狗吠', 123, 1, 'animals', 'one-shot', 0.15, 0.55, -19.2, 1374, ['狗', '户外']],
  ['generaluser', 'horse-gallop', 'Horse Gallop', '马蹄', 123, 2, 'animals', 'sustained', 2.99, null, -27.9, 3465, ['节奏', '古装']],
  ['generaluser', 'bird-2', 'Bird 2', '鸟叫 2', 123, 3, 'animals', 'one-shot', 0.02, 0.4, -24.3, 5564, ['鸟', '短促']],
  ['generaluser', 'telephone-1', 'Telephone 1', '电话 1', 124, 0, 'home', 'sustained', 2.21, null, -22.4, 8944, ['电话', '断续']],
  ['generaluser', 'telephone-2', 'Telephone 2', '电话 2', 124, 1, 'home', 'sustained', 1.31, null, -23.2, 4400, ['电话', '低音']],
  ['generaluser', 'door-creak', 'Door Creaking', '门吱呀', 124, 2, 'home', 'one-shot', 0.2, 1.11, -24.9, 4598, ['门', '悬疑']],
  ['generaluser', 'door', 'Door', '关门', 124, 3, 'home', 'one-shot', 0.06, 0.47, -19.3, 1689, ['门', '低频']],
  ['generaluser', 'scratch', 'Scratch', '刮擦', 124, 4, 'home', 'one-shot', 0.08, 0.51, -21.1, 2350, ['摩擦', '转场']],
  ['generaluser', 'windchime', 'Windchime', '风铃', 124, 5, 'home', 'sustained', 1.64, null, -19.2, 13046, ['风铃', '空灵']],
  ['generaluser', 'helicopter', 'Helicopter', '直升机', 125, 0, 'traffic', 'sustained', 3.9, null, -21.1, 1386, ['直升机', '慢起音']],
  ['generaluser', 'car-engine', 'Car-Engine', '汽车引擎', 125, 1, 'traffic', 'sustained', 0.41, null, -22.9, 5757, ['汽车', '引擎']],
  ['generaluser', 'car-stop', 'Car-Stop', '刹车', 125, 2, 'traffic', 'one-shot', 0.19, 0.92, -19.0, 2660, ['汽车', '尖啸']],
  ['generaluser', 'car-pass', 'Car-Pass', '车驶过', 125, 3, 'traffic', 'one-shot', 0.95, 1.99, -27.0, 842, ['车', '远近']],
  ['generaluser', 'car-crash', 'Car-Crash', '碰撞', 125, 4, 'traffic', 'one-shot', 0.06, 1.91, -18.7, 1340, ['碰撞', '低频']],
  ['generaluser', 'siren', 'Siren', '警笛', 125, 5, 'traffic', 'sustained', 3.98, null, -19.4, 1987, ['警笛', '城市']],
  ['generaluser', 'train', 'Train', '火车', 125, 6, 'traffic', 'sustained', 3.46, null, -23.6, 1508, ['火车', '节奏']],
  ['generaluser', 'jet-plane', 'Jet Plane', '喷气式飞机', 125, 7, 'traffic', 'sustained', 1.41, null, -23.9, 305, ['飞机', '低频']],
  ['generaluser', 'starship', 'Starship', '飞船', 125, 8, 'traffic', 'sustained', 1.35, null, -27.8, 5600, ['科幻', '氛围']],
  ['generaluser', 'burst-noise', 'Burst Noise', '爆裂噪声', 125, 9, 'traffic', 'sustained', 1.11, null, -26.5, 1891, ['噪声', '转场']],
  ['generaluser', 'applause', 'Applause', '掌声', 126, 0, 'crowd', 'sustained', 2.21, null, -18.5, 6537, ['人群', '结尾']],
  ['generaluser', 'laughing', 'Laughing', '笑声', 126, 1, 'crowd', 'one-shot', 0.38, 1.03, -20.0, 3381, ['人声', '轻快']],
  ['generaluser', 'scream', 'Scream', '尖叫', 126, 2, 'crowd', 'one-shot', 0.59, 1.29, -19.1, 3820, ['人声', '惊吓']],
  ['generaluser', 'punch', 'Punch', '拳击', 126, 3, 'crowd', 'one-shot', 0.06, 0.42, -20.3, 919, ['打击', '低频']],
  ['generaluser', 'heart-beat', 'Heart Beat', '心跳', 126, 4, 'crowd', 'one-shot', 0.04, 0.95, -19.4, 342, ['紧张', '低频']],
  ['generaluser', 'footsteps', 'Footsteps', '脚步', 126, 5, 'crowd', 'one-shot', 0.0, 0.26, -29.2, 1288, ['行走', '安静']],
  ['generaluser', 'gun-shot', 'Gun Shot', '枪声', 127, 0, 'weapons', 'one-shot', 0.02, 0.59, -18.2, 1292, ['枪', '冲击']],
  ['generaluser', 'machine-gun', 'Machine Gun', '机枪', 127, 1, 'weapons', 'sustained', 1.65, null, -20.5, 5711, ['枪', '连发']],
  ['generaluser', 'lasergun', 'Lasergun', '激光枪', 127, 2, 'weapons', 'one-shot', 0.01, 0.54, -20.6, 11650, ['科幻', '高频']],
  ['generaluser', 'explosion', 'Explosion', '爆炸', 127, 3, 'weapons', 'one-shot', 0.04, 1.84, -17.4, 1482, ['爆炸', '低频']],
  ['generaluser', 'interference', 'Interference', '干扰噪声', 127, 11, 'weapons', 'sustained', 1.52, null, -24.5, 5389, ['故障', '干扰']],
  ['generaluser', 'shooting-star', 'Shooting Star', '流星', 127, 12, 'weapons', 'one-shot', 0.06, 1.39, -27.1, 2641, ['童话', '转场']],
  ['musescore-general', 'sea-shore', 'Sea Shore', '海岸（MS）', 122, 0, 'weather', 'sustained', 3.92, null, -18.4, 3985, ['海', '更响']],
  ['musescore-general', 'bird-tweet', 'Bird Tweet', '鸟叫（MS）', 123, 0, 'animals', 'one-shot', 0.33, 1.28, -16.4, 6653, ['鸟', '单声']],
  ['musescore-general', 'telephone', 'Telephone', '电话（MS）', 124, 0, 'home', 'sustained', 0.51, null, -16.2, 8600, ['电话', '短促']],
  ['musescore-general', 'helicopter', 'Helicopter', '直升机（MS）', 125, 0, 'traffic', 'sustained', 2.44, null, -15.2, 1884, ['直升机', '更响']],
  ['musescore-general', 'applause', 'Applause', '掌声（MS）', 126, 0, 'crowd', 'sustained', 0.74, null, -14.7, 4546, ['人群', '更响']],
  ['musescore-general', 'gun-shot', 'Gun Shot', '枪声（MS）', 127, 0, 'weapons', 'one-shot', 0.04, 1.41, -15.4, 1365, ['枪', '更响']],
]

export const SFX_CATALOG = ROWS.map(([font, id, name, zh, program, bank, group, shape, riseSec, lengthSec, peakDb, zcr, tags, note]) => ({
  id,
  name,
  zh,
  font,
  program,
  bank,
  group,
  shape,
  riseSec,
  lengthSec,
  peakDb,
  zcr,
  tags,
  note: note || tags.join('、'),
}))

const KEY = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')

export function listSfxPresets({ fonts, group, shape, query } = {}) {
  const allowed = fonts ? new Set(fonts) : null
  const needle = KEY(query)
  return SFX_CATALOG.filter((entry) => {
    if (allowed && !allowed.has(entry.font)) return false
    if (group && entry.group !== group) return false
    if (shape && entry.shape !== shape) return false
    if (needle) {
      const haystack = [entry.id, entry.name, entry.zh, ...entry.tags].map(KEY)
      if (!haystack.some((value) => value.includes(needle))) return false
    }
    return true
  })
}

export function resolveSfxPreset(input, { fonts } = {}) {
  const needle = KEY(input)
  if (!needle) return null
  const allowed = fonts ? new Set(fonts) : null
  const candidates = SFX_CATALOG.filter((entry) => !allowed || allowed.has(entry.font))
  return (
    candidates.find((entry) => KEY(entry.id) === needle) ??
    candidates.find((entry) => KEY(entry.name) === needle || KEY(entry.zh) === needle) ??
    candidates.find((entry) => [entry.id, entry.name, entry.zh, ...entry.tags].some((value) => KEY(value).includes(needle))) ??
    null
  )
}

/** Compact one-line description used by the tool catalog action and tests. */
export function describeSfxPreset(entry) {
  const shape = entry.shape === 'sustained' ? '持续/可循环' : `一次性 ${entry.lengthSec.toFixed(2)}s`
  return `${entry.name}（${entry.zh}）· ${SFX_GROUPS[entry.group]} · ${shape} · 峰值 ${entry.peakDb.toFixed(1)} dBFS`
}
