# 视频配乐（anyaudio-scoring）

你正在为一段已经存在或即将生成的视频配乐。目标不是"生成一首歌"，而是让成片的音频更好听、更贴画面、更听得清旁白。工具链已由 `dsh-any-audio` 插件提供，你只负责创作决策。

## 何时使用

默认给视频配音，除非用户明确要求无声、或画面本身已经带成品音频。出现以下任一情况时使用本技能：

- 你正在生成或编辑视频、动画、概念片、讲解片、宣传片、科普片；
- 项目里已有分镜表、旁白稿、字幕、时间轴、`timing.json` 之类的结构；
- 用户要求"配乐/背景音乐/音效/加 BGM/改善音频"；
- 你正准备用 numpy 手写合成器做音乐——先停一下，用 `anyaudio_music` 的真实音源通常更好听。

如果只是生成纯音频、与视频无关，这套工具同样可用，但不必强行走完整流程。

## 三步工作流

1. **确定时间轴**：视频总时长、分镜/情绪节点、旁白区间。优先读取项目已有文件（分镜表、字幕、timing.json、narration.json），不要凭空猜时间。
2. **渲染音乐**：`anyaudio_music` 写一个 score（秒为单位，直接对视频时间轴），得到 WAV。
3. **混音交付**：`anyaudio_mix` 把音乐、旁白、音效放到同一条时间轴，开启旁白 ducking，对齐视频总长，必要时直接 mux 出 MP4。

第一次使用若报"没有安装音源"，先调 `anyaudio_sources`（action `install`）安装 GeneralUser GS，再渲染。

## Score 格式

最小可用例子（单位：秒）：

```json
{
  "title": "炊烟",
  "tracks": [
    { "name": "lead", "instrument": "koto", "gainDb": -2, "pan": 0.1, "reverb": 0.35,
      "notes": [[0, 2.0, "D4", 78], [2, 1.2, "F4", 84], [3.2, 2.4, "A4", 90]] },
    { "name": "pad", "instrument": "slow-strings", "gainDb": -9,
      "notes": [[0, 8, ["D3", "A3"], 60]] },
    { "name": "bass", "instrument": "cello", "gainDb": -6,
      "notes": [[0, 4, "D2", 70], [4, 4, "A1", 66]] }
  ]
}
```

规则：

- 音符是 `[起始秒, 时值秒, 音高, 力度]`；第四项力度 1–127，缺省 88。和弦把音高写成数组。也接受对象写法 `{t,d,p,v}`。
- 音高可写 MIDI 号（60）或音名（`D3`、`F#4`、`Bb2`、`C5`）。
- 轨道字段：`instrument`（GM 名或 program 号）、`gainDb`、`pan`（-1–1）、`reverb`/`chorus`（0–1 发送量）、`drums`（该轨用鼓组，音高按鼓件名如 `kick`/`snare` 解析）、`humanize:{timingMs,velocity}`（轻微时间/力度抖动，避免机械感）。
- 自动化：`automation:[{track:"pad", controller:"volume", points:[[0,90],[20,50]]}]`，控制器支持 volume/pan/expression/modulation/sustain/reverb-send/chorus-send/brightness。
- 时间从 0 开始、按视频时间轴写；`durationSec` 传视频总长，`tailSec` 留给尾音和混响。

## 乐器选择

- 民族/古风：`guzheng`(古筝)、`guqin`(古琴)、`pipa`(琵琶)、`erhu`(二胡)、`dizi`(笛)、`xiao`(箫)、`sheng`(笙)、`suona`(唢呐)、`bianzhong`(编钟)、`yangqin`(扬琴)、`taiko`(太鼓)。它们映射到最接近的 GM 音色，不是真采样，但比正弦合成有质感。
- 管弦：`strings`/`slow-strings`、`cello`、`violin`、`viola`、`harp`、`timpani`、`horn`、`trumpet`、`oboe`、`clarinet`、`flute`、`pizzicato`。
- 氛围：`choir`、`warm-pad`、`choir-pad`、`soundtrack`、`crystal`、`atmosphere`。
- 不确定就调 `anyaudio_sources`（action `instruments` 或 `presets`）先看有哪些音色。要更特别的音色可以自行装其它 SF2 并传 `font` 参数。
- 音源可以换：目前支持 `.sf2/.sf3/.dls`，以后会加 sample pack、旁白人声等类型（`action: "kinds"` 可看当前类型）；换音源不用改 score。

## 每条轨道选音源（可选）

- 同一个 score 里，不同轨道可以用不同 SoundFont：在轨道上写 `source`（音源 id 或 `.sf2` 路径）。不写就用默认音源（`action: "use"` 设置的那个，没设过就用装好的默认库）；写 `"auto"` 让插件按乐器族评分自动挑最好的已安装音源（1–10 分，可用 `anyaudio_sources` 的 `list` 查看各库分数）。
- 典型用法：钢琴用专用钢琴库、电吉他用吉他库、贝斯和鼓用默认库。插件会自动给每套音源分配不冲突的 bank offset，不需要手工计算。
- **鼓组永远来自默认音源**（第一套加载的库）：其它库的鼓组不会被使用。要换鼓就把带鼓的库作为 `font` 传进来；默认库没有鼓时鼓轨不会响。
- 装新音源：`anyaudio_sources` 的 `install`（按 id 下载推荐音源）或 `fromPath`（本地文件）。音源装进整台机器共用的音源库（`~/.dsh/anyaudio/fonts`），所有项目与 Agent 会话共用同一份，不用每个项目重装。想让某个库成为「不写 `source` 时的默认音源」，用 `action: "use"`（会写入 `music.font` 配置）。许可证不允许再分发的音源由用户自备，不要下载来源不明的文件。

## 旁白（anyaudio_tts）

- 视频需要配音、但项目里没有现成录音时，**必须用 `anyaudio_tts`**：单条 `{text}`，或多条 `{items:[{text, voice}]}`。输出 48kHz 单声道 WAV，可直接放进 `anyaudio_mix` 的 `role: "narration"` 轨。
- 不要自己调 `edge-tts`、`ttsmaker` 或任何 Python/node 的 TTS 库：那样会绕过用户在 Settings → AnyAudio 里选的引擎和音色（例如 MiMo），用户改了默认引擎也不会生效。
- 不传 `provider` 时用用户配置的默认引擎（Edge；用户切到 MiMo 就用 MiMo）。默认音色 `zh-CN-YunjianNeural`；Edge 可选 `zh-CN-XiaoxiaoNeural`、`zh-CN-YunxiNeural`、`zh-CN-XiaoyiNeural`、`en-US-AriaNeural` 等。`rate` 写 `-12%`，`pitch` 写 `-3Hz` 这类 Edge 语法，也接受数字；MiMo 用 `style` 描述情绪。
- Edge TTS 是网络服务（非官方接口），失败先查网络/代理再重试，必要时给 `proxy`；需要 ffmpeg 把 MP3 转成 WAV。连续试听过多会触发限流（429），等一分钟或换 MiMo。
- 长旁白按分句拆成多条，每条单独放置，便于和分镜时间轴精确对齐。已有旁白音频时不要重复生成。

## 音符怎么发音（ADSR）

- 每个音符只有 `起始/时值/音高/力度` 四项；起音、衰减、延音、释放由**音源里的采样与预设**决定，插件不做 per-note 包络。钢琴是击弦后自然衰减，弦乐/铺底是渐入后持续，管乐起音更慢——同样是 5 秒长音，不同乐器峰值出现的位置完全不同。
- 想要颗粒感/断奏就写短时值、音符之间留缝；想要连奏就让时值与下一个音符接上。力度影响采样层与音量，不改变包络形状。
- 长乐句的整体强弱用 `automation` 的 `expression`（CC11）或 `volume`（CC7）画曲线，比逐个改力度自然。

## 编曲技巧菜单（按需选用，不是必做清单）

这些是可选手段，根据画面和情绪自行判断，不要机械套用：

- **厚度**：主旋律 + 低音支撑（低一个八度）+ 中声部和弦铺底；三轨通常就够，超过五轨先问是否真的需要。
- **音区分离**：低频（bass/cello）< 200Hz，中频铺底 200–800Hz，旋律 500Hz–2kHz，高频装饰（bell/glockenspiel）> 2kHz。避免所有乐器挤在同一个音区。
- **节奏层**：脉冲式低音、轻打击（`shaker`/`taiko`）、拨弦分解，用于动作段落；安静段落撤掉节奏层。
- **动态**：渐强用增加声部/提高力度/加入高八度实现；渐弱反向操作；不要只靠整体音量。
- **分轨平衡**：每条轨的 `gainDb` 是它在音乐总线里的真实比例，母带归一化不会重新平衡各轨。旋律可以比铺底高 6–10dB，但别把伴奏压到 15dB 以下（除非刻意留白）。写完用 `anyaudio_music` 的 `analyze: true` 或 `stems: true` 看每轨 RMS：任何一轨比最响轨低 12dB 以上，它基本就听不见了。分轨 WAV 现在保留母带相对电平，不再逐轨归一化。
- **进出场**：新乐器在乐句边界进入；转场处留 0.2–0.5s 空隙或用一个 whoosh。
- **高潮**：叠加八度、加打击、提高力度，但峰值要给旁白留空间（混音阶段会 duck）。
- **休止**：该停就停。关键时刻的静音比连续铺满更有力量。

## 与画面对齐

- 音乐段落切换对齐分镜切换点，不要在小节中间硬切。
- 情绪转折处（角色决定、灾难、揭示）放重音或停止。
- 结尾留尾音自然收，不要突然截断（用 `tailSec` 或淡出）。
- 有旁白的段落音乐让位：旋律稀疏、音区避开人声中频（300Hz–3kHz），把厚度放在低音与高频。

## 混音（anyaudio_mix）

```json
{
  "tracks": [
    { "role": "narration", "path": ".anyaudio/out/narration.wav", "gainDb": 0 },
    { "role": "music", "path": ".anyaudio/out/score.wav", "gainDb": -6, "fadeInSec": 1.5, "fadeOutSec": 2.5 },
    { "role": "sfx", "path": ".anyaudio/out/sfx.wav", "gainDb": -4 }
  ],
  "durationSec": 84.5,
  "ducking": { "targetDb": -9, "thresholdDb": -42 },
  "video": "output/愚公移山.mp4",
  "videoOutput": "output/愚公移山-anyaudio.mp4"
}
```

要点：

- 任何 `role: "narration"` 的轨道会自动触发 ducking：旁白出现时其它轨道压低（默认最多 -9dB），旁白间隙恢复。没有旁白文件时可用 `videoAudio: "narration"` 从视频里提取。
- `durationSec` 必须等于视频时长，这是音频与画面同步的关键。
- 音乐通常 -6 到 -10dB，音效 -4 到 -8dB，旁白 0dB；峰值留给 master（默认 -1.5dBFS）。返回的 `tracks[].rmsDb` 是每轨实际电平：旁白与音乐的 RMS 差通常留 6–12dB；如果音乐太轻，先看是不是峰值归一（稀疏音乐峰值高、RMS 低），可以调高音乐增益或重渲染时传 `peakDb: null`。
- 淡入淡出用秒数，长片结尾至少 2–3s。
- 检查 `anyaudio_mix` 返回的 `ducking.measuredDropDb`（实际压低了多少）和 `peakDb`。
- 输出位置：相对路径一律按**用户当前项目目录**解析，默认写入 `<项目>/.anyaudio/out/`。想放到别的目录就传 `output`（相对项目或绝对路径）；不要假设插件会把文件写进 DSH 安装目录。

## 音效

`anyaudio_sfx` 有两套引擎，优先用默认音源库里的真实采样，没有合适的再用程序化合成。

**① 默认库音效（优先）**：`{items:[{preset:"rain", startSec:0, durationSec:20, gainDb:-8}]}`。两套默认音源（GeneralUser GS、MuseScore General）里 GM 120–127 的音色就是音效库：鸟鸣、海岸、雨、雷、风、溪流、狗、马蹄、电话、门、风铃、汽车、警车、火车、飞机、掌声、笑声、尖叫、枪声、爆炸、脚步、心跳等，共 52 条。用 `anyaudio_sfx action:"catalog"` 看完整列表（带形态、起音、峰值）。要点：

- 一次性音效（枪声、爆炸、门、脚步、掌声短促版）不写 `durationSec`，会自然放完；持续床（雨、风、海岸、掌声、直升机）写 `durationSec` 决定铺多久，可以 `fadeInSec/fadeOutSec` 做进出。
- 峰值差很大（脚步 -29、爆炸 -17），不要默认全部 0dB，按画面主次给 `gainDb`；一般关键音效 -6~-10，床 -12~-20。
- 起音慢的音效（雨 3.1s、海岸 1.6s、直升机 3.9s）要提前进，别等画面切了才响。
- 需要变化时用 `note` 移调（C4=60 是原始音高），别把音效当乐器写旋律。
- 只认这两套默认库；用户自装的其他库里的音效不进入目录。缺音源时先 `anyaudio_sources` 安装。

目录速查（英文名即 `preset` 值；同一 program 下的中文名是别名）：

| 场景 | 音效 |
| --- | --- |
| 天气与水 | Seashore 海岸 · Rain 雨 · Thunder 雷 · Wind 风 · Stream 溪流 · Bubbles 气泡 · Howling Winds 呼啸风 · White Noise Wave 白噪浪 |
| 动物 | Birds 鸟鸣 · Bird 2 鸟叫 · Dog 狗吠 · Horse Gallop 马蹄 |
| 家居 | Telephone 1/2 电话 · Door 关门 · Door Creaking 门吱呀 · Scratch 刮擦 · Windchime 风铃 |
| 交通 | Helicopter 直升机 · Car-Engine 引擎 · Car-Stop 刹车 · Car-Pass 驶过 · Car-Crash 碰撞 · Siren 警笛 · Train 火车 · Jet Plane 飞机 · Starship 飞船 · Burst Noise 爆裂 |
| 人群与人声 | Applause 掌声 · Laughing 笑 · Scream 尖叫 · Punch 拳击 · Heart Beat 心跳 · Footsteps 脚步 |
| 武器与冲击 | Gun Shot 枪声 · Machine Gun 机枪 · Lasergun 激光 · Explosion 爆炸 · Interference 干扰 · Shooting Star 流星 |
| 拟音噪声 | Fret Noise 品丝摩擦 · Cut Noise 切断噪声 · String Slap 拍弦 · Breath Noise 气声 · Fl. Key Click 按键 · Filter Snap 滤波啪 |

MuseScore General 另有一组更响的版本（`sea-shore`、`bird-tweet`、`telephone`、`helicopter`、`applause`、`gun-shot`、`fret-noise`、`breath-noise`），需要在 `pan`/`gainDb` 上重新平衡。

**② 程序化音效**：`{type:"wind"}` 等 15 种（wind/rain/water/fire/birds/footsteps/stones/whoosh/impact/bell/gong/drum/riser/heartbeat/thunder），适合转场 whoosh、撞击、需要连续变化的氛围、以及目录里没有的声音（机械、魔法、卡通）。

- 音效服务画面事件：脚步跟脚步、落石跟落石、转场跟转场。
- 音效不要铺满；关键点之外保持干净。
- 环境底噪可以用低音量 `wind`/`rain` 或 `preset:"wind"` 轨道（role `ambience`），它同样会被 ducking 压低。

## 验收清单

渲染/混音完成后自检，并把结果写进最终回复：

1. 文件时长与视频一致（误差 < 0.1s）。
2. `peakDb` 不超过 -1dBFS，没有削波；整体 RMS 大约 -20 到 -14dBFS。
3. 有旁白处音乐明显让位（看 `measuredDropDb`），旁白不被遮蔽。
4. 开头/结尾没有爆音或突然截断（淡入淡出、尾音）。
5. 至少试听开头、中段、高潮、结尾四个点（可用 ffmpeg 抽 5–10s 片段）。
6. 音频文件能被播放器打开（WAV 16bit PCM 48kHz 立体声）。

## 常见错误

- 只生成一条旋律轨，没有低音和铺底 → 单薄。
- 所有音符力度都是 90 → 没有强弱，像 MIDI 循环。
- 旁白段音乐不避让 → 听不清台词。
- 时长没对齐视频 → 结尾音画不同步。
- 用 numpy 手搓合成器代替真实音源 → 电子感。
- 自己写 Python/Node 调 edge-tts 生成旁白 → 绕过用户的 TTS 引擎与音色设置，MiMo 永远用不上。
- 把相对 `output` 当成 DSH 目录里的路径 → 文件跑到插件安装目录，用户找不到；相对路径按项目目录解析。
- 只调 `anyaudio_music` 不看每轨电平 → 旋律把伴奏压没（用 `analyze: true` 或 `stems: true` 检查）。
- 为了"专业"堆十几个轨道 → 浑浊，先做减法。

## 与视频整合

- 插件不重编码视频：`anyaudio_mix` 的 mux 用 `-c:v copy` 复制原视频流，只重编码音频为 AAC 192k。
- 没有 ffmpeg 时仍会输出 WAV，并提示手动 mux；也可以把 WAV 交给项目原有渲染流程（例如 imageio_ffmpeg）合并。
- 不要覆盖原视频；输出到新文件（例如 `<原名>-anyaudio.mp4`）。
