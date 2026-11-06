/**
 * UI language.
 *
 * "auto" follows the shell locale; "zh" or "en" pin it. The preference lives in
 * the plugin's own config file under `ui.language`, so this module owns the
 * lookup table and nothing else.
 *
 * The Chinese string is the lookup key and the English table is the translation,
 * which keeps every call site readable in the language actually being written.
 */
export const EN = {
  '界面语言': 'Language',
  '跟随系统': 'Follow system',
  '中文': '中文',
  'English': 'English',
  '语言已保存': 'Language saved',
  '个音源': 'sound sources',
  '尚未安装音源': 'No sound sources yet',
  'ffmpeg 可用': 'ffmpeg ready',
  'ffmpeg 缺失': 'ffmpeg missing',
  '刷新': 'Refresh',
  '重试': 'Retry',
  '正在读取 AnyAudio 设置…': 'Loading AnyAudio settings…',
  '无法读取设置：{0}。确认插件已启用，并重启一次 DSH。': 'Could not read settings: {0}. Make sure the plugin is enabled and restart DSH once.',
  '给视频自动配乐的插件。设置保存在本机一份文件里，不随 DSH 账户或 profile 变化；API Key 单独存在 DSH 凭据库。': 'Video scoring for DeepSeek Harness. Settings live in one file on this machine, shared across DSH profiles; API keys live in the DSH credential store.',
  '音源': 'Sound sources',
  '配音': 'Narration',
  '混音与输出': 'Mix & output',
  '诊断': 'Diagnostics',
  '高级': 'Advanced',
  '音源（SoundFont）': 'Sound sources (SoundFont)',
  '乐器声音来自这里。装一套 32 MB 的 GeneralUser GS 就能覆盖大部分配乐；想更真实可以再加一套。文件只放在本机，不进 git、不进插件包。': 'Instrument sounds come from SoundFont banks. GeneralUser GS (32 MB) covers most cues; add MuseScore General for a fuller orchestra. Files stay on this machine — never in git or the plugin package.',
  '正在安装': 'Installing',
  '完成：{0}': 'Done: {0}',
  '失败：{0}': 'Failed: {0}',
  '试听：{0}': 'Preview: {0}',
  '音色': 'Preset',
  '默认': 'Default',
  '建议安装': 'Suggested',
  '已安装': 'Installed',
  '文件被修改': 'File modified',
  '已安装（未登记）': 'Installed (unmanaged)',
  '未安装': 'Not installed',
  '下载安装': 'Install',
  '试听': 'Preview',
  '校验': 'Verify',
  '移除记录': 'Forget',
  '删除文件': 'Delete file',
  '删除 {0} 的文件？\n\n之后需要重新下载才能使用。': 'Delete {0}? The bank will have to be downloaded again before use.',
  '许可证：{0}': 'License: {0}',
  'SHA-256：{0}…（{1}）': 'SHA-256: {0}… ({1})',
  '记录一致': 'matches record',
  '与记录不一致': 'does not match record',
  '手动下载：{0}': 'Manual download: {0}',
  '已安装的其它音源': 'Other installed banks',
  '不在推荐列表里的音源也会被识别，按文件名或路径引用即可。': 'Banks outside the suggested list still work; reference them by file name or path.',
  '暂无。把 .sf2 放进音源目录，或在上面按文件安装。': 'None yet. Put a .sf2 in the sound source folder, or install one by path above.',
  '从本机文件安装（7z/zip 请先解压出 .sf2/.sf3/.dls）': 'Install from a local file (extract .sf2/.sf3/.dls from 7z/zip first)',
  '安装文件': 'Install file',
  '从网址安装（直链 .sf2/.sf3/.dls）': 'Install from a URL (direct .sf2/.sf3/.dls link)',
  '音源目录': 'Sound source folders',
  '整台机器共用这一个音源库；环境变量 ANYAUDIO_FONTS 可以追加目录。': 'One shared library for the whole machine; ANYAUDIO_FONTS can add more folders.',
  '默认音源：{0}': 'Default bank: {0}',
  '未安装音源': 'No bank installed',
  '音源已安装': 'Sound source installed',
  '开始下载，关掉设置页后仍会继续': 'Download started — it keeps running after you close this page',
  '已有一个下载任务在进行': 'A download is already running',
  '校验通过': 'Verification passed',
  '校验失败：文件与记录不一致': 'Verification failed: file does not match its record',
  '已处理': 'Done',
  '这个音源没有可试听的旋律预设': 'This bank has no melodic presets to preview',
  '正在读取': 'Loading',

  '配音（TTS）': 'Narration (TTS)',
  '给视频配旁白。Edge 默认可用、不需要 Key；MiMo-V2.5 需要普通 Open Platform API Key。只影响没有显式指定 voice/provider 的新任务。': 'Narration for videos. Edge works out of the box; MiMo-V2.5 needs a normal Open Platform API key. Applies to new tasks that do not set voice/provider explicitly.',
  'Edge TTS（默认，免费）': 'Edge TTS (default, free)',
  'MiMo-V2.5-TTS（需要 API Key）': 'MiMo-V2.5-TTS (needs an API key)',
  '默认音色': 'Default voice',
  'Yunjian 为男声，Xiaoxiao 为女声': 'Yunjian is male, Xiaoxiao is female',
  '语速': 'Rate',
  '例如 -12%（负数更慢）': 'e.g. -12% (negative is slower)',
  '音高': 'Pitch',
  '例如 -3Hz': 'e.g. -3Hz',
  '音量': 'Volume',
  '通常保持 +0%': 'Usually +0%',
  '代理（可选）': 'Proxy (optional)',
  '国内网络必要时填 http://127.0.0.1:7890': 'Set http://127.0.0.1:7890 if your network needs a proxy',
  '默认直连；若系统代理或规则会改写 MiMo 请求，填 http://127.0.0.1:7890 这类地址': 'Direct by default. If a system proxy or rules rewrite MiMo requests, enter an address such as http://127.0.0.1:7890',
  '只支持普通 Open Platform API Key，不支持 Token Plan；Key 保存在 DSH 凭据库（本机 YAML，权限仅当前用户，不是加密存储），不会回传给浏览器。': 'Only normal Open Platform API keys are supported. The key is stored in the DSH credential store (local YAML, current-user permissions, not encrypted at rest) and is never sent back to the browser.',
  'mimo_default 由服务端集群决定，不同集群音色可能不同': 'mimo_default is resolved by the service cluster and may differ between clusters',
  '默认风格（可选）': 'Default style (optional)',
  '用一句话描述语气，例如「温柔、缓慢、纪录片旁白」': 'One sentence of direction, e.g. "gentle, slow, documentary narration"',
  '模型': 'Model',
  '默认 mimo-v2.5-tts；声音克隆/设计模型见文档': 'Defaults to mimo-v2.5-tts; see the docs for voice clone/design models',
  'API 地址': 'API base URL',
  '一般不需要修改': 'Usually unchanged',
  'Key 状态：已配置': 'Key status: configured',
  'Key 状态：未配置': 'Key status: not configured',
  '已配置，如需更换请重新填写': 'Configured — fill again to replace',
  '粘贴 Open Platform API Key': 'Paste an Open Platform API key',
  '保存 Key': 'Save key',
  '删除 Key': 'Delete key',
  '保存为默认值': 'Save as defaults',
  '已保存为默认值（新任务生效，正在运行的任务不受影响）': 'Saved. New tasks use these defaults; running tasks are unaffected.',
  'Key 已保存到 DSH 凭据库': 'Key saved to the DSH credential store',
  'Key 已删除': 'Key deleted',
  '用当前设置合成一句，确认音色、语速与情绪。': 'Synthesise one sentence with the current settings to check voice, pace and tone.',
  '生成中…': 'Generating…',
  '生成试听': 'Generate preview',
  '先保存 Key 才能试听 MiMo': 'Save a key before previewing MiMo',
  '试听已生成': 'Preview ready',

  '这些是工具没写参数时采用的默认值；工具调用里显式写的参数永远优先。': 'Defaults used when a tool call does not set the value; explicit tool arguments always win.',
  '母带峰值上限 (dBFS)': 'Master peak ceiling (dBFS)',
  '-1.5 留出余量；设成「不归一」会保留原始电平': '-1.5 leaves headroom; "No normalisation" keeps the raw level',
  '恢复归一': 'Normalise again',
  '不归一': 'No normalisation',
  '音乐峰值 (dBFS)': 'Music peak (dBFS)',
  '渲染音乐时默认归一到的峰值': 'Peak that music is normalised to by default',
  '音乐尾音 (秒)': 'Music tail (seconds)',
  '最后一个音符结束后额外渲染的释放与混响': 'Extra release and reverb rendered after the last note',
  '音效峰值 (dBFS)': 'SFX peak (dBFS)',
  '输出目录': 'Output folder',
  '留空 = 项目下 .anyaudio/out；也可以填绝对路径': 'Empty = <project>/.anyaudio/out; an absolute path also works',
  '旁白 ducking': 'Narration ducking',
  '旁白出现时把音乐压下去，保证说话清楚。改的是新任务的默认值。': 'Lowers music while narration plays so speech stays clear. Applies to new tasks.',
  '默认启用 ducking': 'Enable ducking by default',
  '压低幅度 (dB)': 'Reduction (dB)',
  '-9 表示最多降低 9 dB；越小越不明显': '-9 means up to 9 dB lower; smaller is subtler',
  '触发阈值 (dBFS)': 'Trigger threshold (dBFS)',
  '-42 表示超过这个电平的旁白才触发': '-42 means narration above this level triggers ducking',
  '已保存。显式参数仍然优先于这些默认值': 'Saved. Explicit tool arguments still win.',

  '运行状态': 'Diagnostics',
  '排查问题先看这里。': 'Start here when something looks wrong.',
  '插件版本': 'Plugin version',
  '配置文件': 'Config file',
  '默认音源': 'Default bank',
  '未找到：TTS 转 WAV 与视频封装会失败，纯 WAV 混音不受影响': 'Not found: TTS-to-WAV and video muxing will fail; pure WAV mixing still works',
  '重新检测': 'Check again',
  '复制配置路径': 'Copy config path',
  '路径已复制': 'Path copied',
  '复制失败，请手动选择': 'Copy failed — select it manually',
  '恢复默认设置': 'Reset settings',
  '把 AnyAudio 的所有设置恢复为默认值？（音源文件不会删除，API Key 也不会删除）': 'Reset every AnyAudio setting to its default? SoundFont files and API keys are kept.',
  '设置已恢复默认': 'Settings reset',
  '音源搜索目录': 'Sound source search folders',

  '高级：原始配置': 'Advanced: raw config',
  '整个配置文件就是这一份 JSON，机器上所有 profile 共用。未知字段会在保存时被丢弃。': 'The whole config is this one JSON file, shared by every profile on the machine. Unknown fields are dropped on save.',
  '保存': 'Save',
  '重新载入': 'Reload',
  '已保存': 'Saved',
  '未知': 'Unknown',

  '剪辑台': 'Clip bay',
  '正在读取工程…': 'Loading projects…',
  '这个工作区还没有工程。在会话里让 Agent 建一个：说「新建一个剪辑台工程」即可。': 'This workspace has no projects yet. Ask the agent in a conversation to create one.',
  '还没有打开任何工作区。先在左侧打开一个工作区，再回到剪辑台。': 'No workspace is open yet. Open one from the sidebar, then come back to the clip bay.',
  '时间轴还没做，下一步就有了。': 'The timeline comes in the next step.',
  '含视频': 'Video',
  '个工程': 'projects',
  '轨': 'tracks',
  '← 返回': '← Back',
}

let LANG = 'zh'

/** Current language, after the settings page has loaded the config. */
export function language() {
  return LANG
}

/** Adopt the configured language. Called once the state arrives. */
export function setLanguage(value) {
  LANG = value === 'en' ? 'en' : 'zh'
  return LANG
}

export function detectLanguage(config) {
  const preference = config?.ui?.language || 'auto'
  if (preference === 'zh' || preference === 'en') return preference
  const nav = typeof navigator === 'undefined'
    ? 'zh'
    : String((navigator.languages && navigator.languages[0]) || navigator.language || 'zh')
  return /^zh/i.test(nav) ? 'zh' : 'en'
}

export function t(key, ...args) {
  const template = LANG === 'zh' ? key : (EN[key] ?? key)
  return template.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)] ?? ''))
}
