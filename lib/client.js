/**
 * AnyAudio — browser half.
 *
 * Contributes one settings section (`settings.section` id `any-audio`). Every
 * value is read from and written to the plugin's own same-origin routes
 * (/api/dsh-any-audio/*), which are backed by one machine-wide config file —
 * DSH's settings service is profile-scoped, so it cannot be the source of truth.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides.
 *
 * UI language: "auto" (follow the shell locale), "zh" or "en", persisted in the
 * shared config under `ui.language`. The Chinese string is the lookup key; the
 * English table lives in EN.
 */
window.__ModuleLoader__.load({
  id: 'dsh-any-audio',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useRef, useCallback, useMemo } = React

    const API = '/api/dsh-any-audio'
    const inject = ['slots', 'locale']

    const EN = {
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
      '开始下载，请保持页面打开': 'Download started — keep this page open',
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
    }

    let LANG = 'zh'

    function detectLanguage(config) {
      const preference = config?.ui?.language || 'auto'
      if (preference === 'zh' || preference === 'en') return preference
      const nav = typeof navigator === 'undefined'
        ? 'zh'
        : String((navigator.languages && navigator.languages[0]) || navigator.language || 'zh')
      return /^zh/i.test(nav) ? 'zh' : 'en'
    }

    function t(key, ...args) {
      const template = LANG === 'zh' ? key : (EN[key] ?? key)
      return template.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)] ?? ''))
    }

    const C = {
      border: 'rgba(128,128,128,0.28)',
      soft: 'rgba(128,128,128,0.10)',
      softer: 'rgba(128,128,128,0.06)',
      text: 'inherit',
      muted: 'rgba(128,128,128,0.95)',
      accent: '#4f7cff',
      good: '#2ea36b',
      warn: '#c9822a',
      bad: '#c0504d',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 900, padding: '4px 2px 32px', fontSize: 13, lineHeight: 1.55 },
      header: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 18, fontWeight: 600 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, border: `1px solid ${C.border}`, fontSize: 11, color: C.muted, whiteSpace: 'nowrap' },
      tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' },
      tab: active => ({ padding: '6px 12px', borderRadius: '6px 6px 0 0', border: `1px solid ${active ? C.border : 'transparent'}`, borderBottom: 'none', background: active ? C.soft : 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 13 }),
      card: { border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
      cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
      cardTitle: { fontWeight: 600, fontSize: 14 },
      desc: { color: C.muted, fontSize: 12, margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180, flex: '1 1 180px' },
      label: { fontSize: 12, color: C.muted },
      input: { border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', background: 'transparent', color: 'inherit', fontSize: 13, width: '100%', boxSizing: 'border-box' },
      btn: (kind = 'normal', disabled = false) => ({ border: `1px solid ${kind === 'primary' ? C.accent : C.border}`, background: kind === 'primary' ? C.accent : 'transparent', color: kind === 'primary' ? '#fff' : 'inherit', borderRadius: 6, padding: '4px 10px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, opacity: disabled ? 0.5 : 1 }),
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      item: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 },
      itemHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11, color: C.muted, wordBreak: 'break-all' },
      bar: { height: 6, background: C.soft, borderRadius: 999, overflow: 'hidden' },
      barFill: pct => ({ height: '100%', width: `${Math.min(100, Math.max(0, pct))}%`, background: C.accent, transition: 'width .2s' }),
      notice: tone => ({ border: `1px solid ${tone === 'error' ? C.bad : tone === 'warn' ? C.warn : C.border}`, background: C.softer, borderRadius: 8, padding: '7px 10px', fontSize: 12, color: tone === 'error' ? C.bad : 'inherit' }),
      audio: { width: '100%', marginTop: 6 },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
    }

    async function api(path, { method = 'GET', body } = {}) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: {
          'x-any-audio-client': 'any-audio/1',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let data = {}
      try {
        data = await response.json()
      } catch {
        data = {}
      }
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function bytes(value) {
      if (!Number.isFinite(value)) return ''
      if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
      if (value >= 1024) return `${Math.round(value / 1024)} KB`
      return `${value} B`
    }

    function Btn({ children, onClick, kind, disabled, style }) {
      return h('button', { type: 'button', onClick, disabled, style: { ...S.btn(kind, disabled), ...style } }, children)
    }

    function Field({ label, hint, children }) {
      return h('div', { style: S.field },
        h('span', { style: S.label }, label),
        children,
        hint ? h('span', { style: { ...S.desc, fontSize: 11 } }, hint) : null,
      )
    }

    function TextInput({ value, onChange, placeholder, type }) {
      return h('input', {
        type: type || 'text',
        value: value ?? '',
        placeholder,
        onChange: event => onChange(event.target.value),
        style: S.input,
        spellCheck: false,
      })
    }

    function NumberInput({ value, onChange, step }) {
      return h('input', {
        type: 'number',
        step: step || '0.1',
        value: value ?? '',
        onChange: event => onChange(event.target.value === '' ? '' : Number(event.target.value)),
        style: S.input,
      })
    }

    function Select({ value, onChange, options }) {
      return h('select', { value, onChange: event => onChange(event.target.value), style: S.input },
        options.map(option => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    function Switch({ checked, onChange, label }) {
      return h('label', { style: { ...S.row, gap: 6, cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: Boolean(checked), onChange: event => onChange(event.target.checked) }),
        h('span', { style: { fontSize: 12 } }, label),
      )
    }

    function Notice({ children, tone }) {
      if (!children) return null
      return h('div', { style: S.notice(tone) }, children)
    }

    function Card({ title, desc, right, children }) {
      return h('section', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', null,
            h('div', { style: S.cardTitle }, title),
            desc ? h('p', { style: S.desc }, desc) : null,
          ),
          right || null,
        ),
        children,
      )
    }

    function FontsTab({ state, reload, notify }) {
      const [job, setJob] = useState(null)
      const [busy, setBusy] = useState('')
      const [preview, setPreview] = useState(null)
      const [picker, setPicker] = useState(null)
      const [customPath, setCustomPath] = useState('')
      const [customUrl, setCustomUrl] = useState('')

      useEffect(() => {
        if (!job || job.status !== 'running') return undefined
        const timer = setInterval(async () => {
          try {
            const data = await api(`/jobs?id=${encodeURIComponent(job.id)}`)
            setJob(data.job)
            if (data.job.status === 'done') {
              notify(t('音源已安装'))
              await reload()
            }
            if (data.job.status === 'error') notify(data.job.error, 'error')
          } catch (error) {
            notify(error.message, 'error')
            setJob(null)
          }
        }, 700)
        return () => clearInterval(timer)
      }, [job, reload, notify])

      async function install(body) {
        setBusy(`install:${body.id || body.fromPath || 'custom'}`)
        try {
          const data = await api('/sources/install', { method: 'POST', body })
          setJob(data.job)
          notify(t('开始下载，请保持页面打开'))
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      async function act(kind, body) {
        setBusy(`${kind}:${body.path}`)
        try {
          const data = await api(`/sources/${kind}`, { method: 'POST', body })
          if (kind === 'preview') setPreview(data)
          else {
            notify(kind === 'verify' ? (data.ok ? t('校验通过') : t('校验失败：文件与记录不一致')) : t('已处理'))
            await reload()
          }
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      async function runPreview(path, program) {
        setBusy(`preview:${path}:${program}`)
        try {
          const data = await api('/sources/preview', { method: 'POST', body: { path, program } })
          setPreview(data)
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      async function openPreview(path) {
        setBusy(`presets:${path}`)
        try {
          const data = await api(`/sources/presets?path=${encodeURIComponent(path)}`)
          const list = data.presets || []
          if (list.length === 0) {
            notify(t('这个音源没有可试听的旋律预设'), 'error')
            return
          }
          setPicker({ path, presets: list, program: list[0].program })
          await runPreview(path, list[0].program)
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      function selectProgram(program) {
        if (!picker) return
        setPicker({ ...picker, program })
        void runPreview(picker.path, program)
      }

      const fonts = state.fonts
      const percent = job && job.total ? (job.received / job.total) * 100 : 0
      return h(Fragment, null,
        h(Card, {
          title: t('音源（SoundFont）'),
          desc: t('乐器声音来自这里。装一套 32 MB 的 GeneralUser GS 就能覆盖大部分配乐；想更真实可以再加一套。文件只放在本机，不进 git、不进插件包。'),
          right: h(Btn, { onClick: reload }, t('刷新')),
        },
          job ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: { ...S.row, justifyContent: 'space-between' } },
              h('span', { style: S.label }, job.status === 'running' ? `${t('正在安装')}${job.total ? ` ${Math.round(percent)}%` : ''}` : job.status === 'done' ? t('完成：{0}', job.message || t('已安装')) : t('失败：{0}', job.error || '')),
              job.total ? h('span', { style: S.mono }, `${bytes(job.received)} / ${bytes(job.total)}`) : null,
            ),
            h('div', { style: S.bar }, h('div', { style: S.barFill(percent) })),
          ) : null,
          preview ? h('div', { style: { ...S.item } },
            h('div', { style: S.itemHead }, h('span', null, t('试听：{0}', preview.label)), h('span', { style: S.mono }, `${preview.durationSec}s · ${preview.peakDb} dBFS`)),
            picker && picker.presets.length > 1
              ? h('div', { style: S.row },
                h('span', { style: S.label }, t('音色')),
                h('select', {
                  value: String(picker.program),
                  onChange: event => selectProgram(Number(event.target.value)),
                  style: S.input,
                }, picker.presets.map(preset => h('option', { key: `${preset.bank}:${preset.program}`, value: String(preset.program) }, `${preset.program} · ${preset.name} (${preset.family})`))),
              )
              : null,
            h('audio', { controls: true, autoPlay: true, src: preview.url, style: S.audio }),
          ) : null,
          h('div', { style: S.list },
            fonts.available.map(font => {
              const installed = fonts.rows.find(row => row.recommendedId === font.id)
              return h('div', { key: font.id, style: S.item },
                h('div', { style: S.itemHead },
                  h('span', { style: { fontWeight: 600 } }, font.name),
                  font.default ? h('span', { style: S.chip }, t('默认')) : null,
                  font.suggested && !font.default ? h('span', { style: S.chip }, t('建议安装')) : null,
                  h('span', { style: S.mono }, bytes(font.bytes)),
                  h('span', { style: S.chip }, installed ? (installed.status === 'ok' ? t('已安装') : installed.status === 'modified' ? t('文件被修改') : t('已安装（未登记）')) : t('未安装')),
                  installed ? null : h(Btn, { kind: 'primary', disabled: busy === `install:${font.id}`, onClick: () => install({ id: font.id }) }, t('下载安装')),
                  installed ? h(Btn, { onClick: () => openPreview(installed.path) }, t('试听')) : null,
                  installed ? h(Btn, { onClick: () => act('verify', { path: installed.path }) }, t('校验')) : null,
                  installed ? h(Btn, { onClick: () => act('remove', { path: installed.path, removeFile: false }) }, t('移除记录')) : null,
                  installed ? h(Btn, { onClick: () => { if (window.confirm(t('删除 {0} 的文件？\n\n之后需要重新下载才能使用。', installed.name))) act('remove', { path: installed.path, removeFile: true }) } }, t('删除文件')) : null,
                ),
                h('div', { style: S.desc }, font.note),
                h('div', { style: S.mono }, t('许可证：{0}', font.license)),
                installed?.sha256 ? h('div', { style: S.mono }, t('SHA-256：{0}…（{1}）', installed.sha256.slice(0, 24), installed.status === 'ok' ? t('记录一致') : t('与记录不一致'))) : null,
                font.manual ? h('div', { style: S.mono }, t('手动下载：{0}', font.manual)) : null,
              )
            }),
          ),
          h('div', { style: S.item },
            h('div', { style: S.label }, t('从本机文件安装（7z/zip 请先解压出 .sf2/.sf3/.dls）')),
            h('div', { style: S.row },
              h(TextInput, { value: customPath, onChange: setCustomPath, placeholder: 'C:\\Downloads\\Piano.sf2' }),
              h(Btn, { disabled: !customPath.trim() || busy.startsWith('install:'), onClick: () => install({ fromPath: customPath.trim() }) }, t('安装文件')),
            ),
          ),
          h('div', { style: S.item },
            h('div', { style: S.label }, t('从网址安装（直链 .sf2/.sf3/.dls）')),
            h('div', { style: S.row },
              h(TextInput, { value: customUrl, onChange: setCustomUrl, placeholder: 'https://example.com/bank.sf2' }),
              h(Btn, { disabled: !customUrl.trim() || busy.startsWith('install:'), onClick: () => install({ url: customUrl.trim() }) }, t('下载安装')),
            ),
          ),
        ),
        h(Card, { title: t('已安装的其它音源'), desc: t('不在推荐列表里的音源也会被识别，按文件名或路径引用即可。') },
          fonts.rows.filter(row => !row.recommendedId).length === 0
            ? h('p', { style: S.desc }, t('暂无。把 .sf2 放进音源目录，或在上面按文件安装。'))
            : h('div', { style: S.list }, fonts.rows.filter(row => !row.recommendedId).map(row => h('div', { key: row.path, style: S.item },
              h('div', { style: S.itemHead },
                h('span', { style: { fontWeight: 600 } }, row.name),
                h('span', { style: S.mono }, bytes(row.bytes)),
                h(Btn, { onClick: () => openPreview(row.path) }, t('试听')),
                h(Btn, { onClick: () => act('verify', { path: row.path }) }, t('校验')),
                h(Btn, { onClick: () => act('remove', { path: row.path, removeFile: true }) }, t('删除文件')),
              ),
              h('div', { style: S.mono }, row.path),
            ))),
        ),
        h(Card, { title: t('音源目录'), desc: t('整台机器共用这一个音源库；环境变量 ANYAUDIO_FONTS 可以追加目录。') },
          h('div', { style: S.mono }, fonts.directories.join('\n')),
          h('div', { style: S.desc }, t('默认音源：{0}', fonts.defaultPath || t('未安装音源'))),
        ),
      )
    }

    function TtsTab({ state, reload, notify }) {
      const [form, setForm] = useState(null)
      const [keyInput, setKeyInput] = useState('')
      const [busy, setBusy] = useState('')
      const [previewText, setPreviewText] = useState('')
      const [preview, setPreview] = useState(null)

      useEffect(() => {
        if (!form && state?.config) {
          setForm(JSON.parse(JSON.stringify(state.config.tts)))
          setPreviewText(state.config.tts.previewText)
        }
      }, [state, form])

      if (!form) return null
      const provider = form.provider
      const set = (path, value) => setForm(current => {
        const next = JSON.parse(JSON.stringify(current))
        const keys = path.split('.')
        let cursor = next
        for (let index = 0; index < keys.length - 1; index++) cursor = cursor[keys[index]] = cursor[keys[index]] || {}
        cursor[keys[keys.length - 1]] = value
        return next
      })

      async function save() {
        setBusy('save')
        try {
          await api('/config', { method: 'POST', body: { patch: { tts: form } } })
          notify(t('已保存为默认值（新任务生效，正在运行的任务不受影响）'))
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      async function saveKey() {
        setBusy('key')
        try {
          await api('/credentials/set', { method: 'POST', body: { value: keyInput } })
          setKeyInput('')
          notify(t('Key 已保存到 DSH 凭据库'))
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      async function clearKey() {
        setBusy('key')
        try {
          await api('/credentials/unset', { method: 'POST', body: {} })
          notify(t('Key 已删除'))
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      async function test() {
        setBusy('preview')
        try {
          const data = await api('/tts/preview', { method: 'POST', body: { provider, voice: provider === 'mimo' ? form.mimo.voice : form.edge.voice, style: form.mimo.style, text: previewText } })
          setPreview(data)
          notify(t('试听已生成'))
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      return h(Fragment, null,
        h(Card, { title: t('配音（TTS）'), desc: t('给视频配旁白。Edge 默认可用、不需要 Key；MiMo-V2.5 需要普通 Open Platform API Key。只影响没有显式指定 voice/provider 的新任务。') },
          h('div', { style: S.row },
            h('label', { style: { ...S.row, gap: 6, cursor: 'pointer' } }, h('input', { type: 'radio', checked: provider === 'edge', onChange: () => set('provider', 'edge') }), t('Edge TTS（默认，免费）')),
            h('label', { style: { ...S.row, gap: 6, cursor: 'pointer' } }, h('input', { type: 'radio', checked: provider === 'mimo', onChange: () => set('provider', 'mimo') }), t('MiMo-V2.5-TTS（需要 API Key）')),
          ),
          provider === 'edge'
            ? h(Fragment, null,
              h('div', { style: S.grid2 },
                h(Field, { label: t('默认音色'), hint: t('Yunjian 为男声，Xiaoxiao 为女声') }, h(Select, { value: form.edge.voice, onChange: value => set('edge.voice', value), options: state.tts.edgeVoices.map(voice => ({ value: voice, label: voice })) })),
                h(Field, { label: t('语速'), hint: t('例如 -12%（负数更慢）') }, h(TextInput, { value: form.edge.rate, onChange: value => set('edge.rate', value) })),
                h(Field, { label: t('音高'), hint: t('例如 -3Hz') }, h(TextInput, { value: form.edge.pitch, onChange: value => set('edge.pitch', value) })),
                h(Field, { label: t('音量'), hint: t('通常保持 +0%') }, h(TextInput, { value: form.edge.volume, onChange: value => set('edge.volume', value) })),
              ),
              h(Field, { label: t('代理（可选）'), hint: t('国内网络必要时填 http://127.0.0.1:7890') }, h(TextInput, { value: form.edge.proxy, onChange: value => set('edge.proxy', value) })),
            )
            : h(Fragment, null,
              h('div', { style: S.notice('warn') }, t('只支持普通 Open Platform API Key，不支持 Token Plan；Key 保存在 DSH 凭据库（本机 YAML，权限仅当前用户，不是加密存储），不会回传给浏览器。')),
              h('div', { style: S.grid2 },
                h(Field, { label: t('默认音色'), hint: t('mimo_default 由服务端集群决定，不同集群音色可能不同') }, h(Select, { value: form.mimo.voice, onChange: value => set('mimo.voice', value), options: state.tts.mimoVoices.map(voice => ({ value: voice, label: voice })) })),
                h(Field, { label: t('默认风格（可选）'), hint: t('用一句话描述语气，例如「温柔、缓慢、纪录片旁白」') }, h(TextInput, { value: form.mimo.style, onChange: value => set('mimo.style', value) })),
                h(Field, { label: t('模型'), hint: t('默认 mimo-v2.5-tts；声音克隆/设计模型见文档') }, h(TextInput, { value: form.mimo.model, onChange: value => set('mimo.model', value) })),
                h(Field, { label: t('API 地址'), hint: t('一般不需要修改') }, h(TextInput, { value: form.mimo.baseUrl, onChange: value => set('mimo.baseUrl', value) })),
                h(Field, { label: t('代理（可选）'), hint: t('默认直连；若系统代理或规则会改写 MiMo 请求，填 http://127.0.0.1:7890 这类地址') }, h(TextInput, { value: form.mimo.proxy, onChange: value => set('mimo.proxy', value) })),
              ),
              h('div', { style: S.row },
                h('span', { style: { color: S.muted, minWidth: 120 } }, state.tts.mimoConfigured ? t('Key 状态：已配置') : t('Key 状态：未配置')),
                h(TextInput, { value: keyInput, onChange: setKeyInput, type: 'password', placeholder: state.tts.mimoConfigured ? t('已配置，如需更换请重新填写') : t('粘贴 Open Platform API Key') }),
                h(Btn, { kind: 'primary', disabled: !keyInput.trim() || busy === 'key', onClick: saveKey }, t('保存 Key')),
                h(Btn, { disabled: busy === 'key', onClick: clearKey }, t('删除 Key')),
              ),
            ),
          h('div', { style: { ...S.row, justifyContent: 'flex-end' } },
            h(Btn, { kind: 'primary', disabled: busy === 'save', onClick: save }, t('保存为默认值')),
          ),
        ),
        h(Card, { title: t('试听'), desc: t('用当前设置合成一句，确认音色、语速与情绪。') },
          h('textarea', {
            value: previewText,
            onChange: event => setPreviewText(event.target.value),
            rows: 3,
            style: { ...S.input, resize: 'vertical' },
          }),
          h('div', { style: S.row },
            h(Btn, { kind: 'primary', disabled: busy === 'preview' || !previewText.trim(), onClick: test }, busy === 'preview' ? t('生成中…') : t('生成试听')),
            provider === 'mimo' && !state.tts.mimoConfigured ? h('span', { style: S.desc }, t('先保存 Key 才能试听 MiMo')) : null,
          ),
          preview ? h('div', { style: S.item },
            h('div', { style: S.itemHead }, h('span', null, preview.label), h('span', { style: S.mono }, `${preview.durationSec}s · ${preview.peakDb} dBFS`)),
            h('audio', { controls: true, autoPlay: true, src: preview.url, style: S.audio }),
          ) : null,
        ),
      )
    }

    function MixTab({ state, reload, notify }) {
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState('')
      useEffect(() => {
        if (!form && state?.config) setForm(JSON.parse(JSON.stringify(state.config)))
      }, [state, form])
      if (!form) return null
      const set = (path, value) => setForm(current => {
        const next = JSON.parse(JSON.stringify(current))
        const keys = path.split('.')
        let cursor = next
        for (let index = 0; index < keys.length - 1; index++) cursor = cursor[keys[index]] = cursor[keys[index]] || {}
        cursor[keys[keys.length - 1]] = value
        return next
      })
      async function save() {
        setBusy('save')
        try {
          await api('/config', { method: 'POST', body: { patch: { music: form.music, sfx: form.sfx, mix: form.mix, output: form.output } } })
          notify(t('已保存。显式参数仍然优先于这些默认值'))
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }
      return h(Fragment, null,
        h(Card, { title: t('混音与输出'), desc: t('这些是工具没写参数时采用的默认值；工具调用里显式写的参数永远优先。') },
          h('div', { style: S.grid2 },
            h(Field, { label: t('母带峰值上限 (dBFS)'), hint: t('-1.5 留出余量；设成「不归一」会保留原始电平') },
              h('div', { style: S.row },
                h(NumberInput, { value: form.mix.masterPeakDb, onChange: value => set('mix.masterPeakDb', value === '' ? null : value) }),
                h(Btn, { onClick: () => set('mix.masterPeakDb', form.mix.masterPeakDb === null ? -1.5 : null) }, form.mix.masterPeakDb === null ? t('恢复归一') : t('不归一')),
              ),
            ),
            h(Field, { label: t('音乐峰值 (dBFS)'), hint: t('渲染音乐时默认归一到的峰值') }, h(NumberInput, { value: form.music.peakDb, onChange: value => set('music.peakDb', value === '' ? null : value) })),
            h(Field, { label: t('音乐尾音 (秒)'), hint: t('最后一个音符结束后额外渲染的释放与混响') }, h(NumberInput, { value: form.music.tailSec, onChange: value => set('music.tailSec', Number(value) || 0) })),
            h(Field, { label: t('音效峰值 (dBFS)') }, h(NumberInput, { value: form.sfx.peakDb, onChange: value => set('sfx.peakDb', value === '' ? null : value) })),
            h(Field, { label: t('输出目录'), hint: t('留空 = 项目下 .anyaudio/out；也可以填绝对路径') }, h(TextInput, { value: form.output.dir, onChange: value => set('output.dir', value) })),
          ),
        ),
        h(Card, { title: t('旁白 ducking'), desc: t('旁白出现时把音乐压下去，保证说话清楚。改的是新任务的默认值。') },
          h(Switch, { checked: form.mix.ducking.enabled, onChange: value => set('mix.ducking.enabled', value), label: t('默认启用 ducking') }),
          h('div', { style: S.grid2 },
            h(Field, { label: t('压低幅度 (dB)'), hint: t('-9 表示最多降低 9 dB；越小越不明显') }, h(NumberInput, { value: form.mix.ducking.targetDb, onChange: value => set('mix.ducking.targetDb', value) })),
            h(Field, { label: t('触发阈值 (dBFS)'), hint: t('-42 表示超过这个电平的旁白才触发') }, h(NumberInput, { value: form.mix.ducking.thresholdDb, onChange: value => set('mix.ducking.thresholdDb', value) })),
          ),
          h('div', { style: { ...S.row, justifyContent: 'flex-end' } }, h(Btn, { kind: 'primary', disabled: busy === 'save', onClick: save }, t('保存为默认值'))),
        ),
      )
    }

    function DiagnosticsTab({ state, reload, notify }) {
      const [busy, setBusy] = useState('')
      async function reset() {
        if (!window.confirm(t('把 AnyAudio 的所有设置恢复为默认值？（音源文件不会删除，API Key 也不会删除）'))) return
        setBusy('reset')
        try {
          await api('/config/reset', { method: 'POST', body: {} })
          notify(t('设置已恢复默认'))
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }
      return h(Fragment, null,
        h(Card, { title: t('运行状态'), desc: t('排查问题先看这里。') },
          h('div', { style: S.list },
            h('div', { style: S.row }, h('span', { style: S.label }, t('插件版本')), h('span', { style: S.mono }, state.version)),
            h('div', { style: S.row }, h('span', { style: S.label }, t('配置文件')), h('span', { style: S.mono }, state.configPath)),
            h('div', { style: S.row }, h('span', { style: S.label }, 'ffmpeg'), h('span', { style: S.mono }, state.ffmpeg ? `${state.ffmpeg.path} (${state.ffmpeg.version})` : t('未找到：TTS 转 WAV 与视频封装会失败，纯 WAV 混音不受影响'))),
            h('div', { style: S.row }, h('span', { style: S.label }, t('默认音源')), h('span', { style: S.mono }, state.fonts.defaultPath || t('未安装音源'))),
            h('div', { style: S.row }, h('span', { style: S.label }, 'Node'), h('span', { style: S.mono }, state.platform.node)),
          ),
          h('div', { style: S.row },
            h(Btn, { onClick: reload }, t('重新检测')),
            h(Btn, { onClick: async () => { try { await navigator.clipboard.writeText(state.configPath); notify(t('路径已复制')) } catch { notify(t('复制失败，请手动选择'), 'error') } } }, t('复制配置路径')),
            h(Btn, { disabled: busy === 'reset', onClick: reset }, t('恢复默认设置')),
          ),
        ),
        h(Card, { title: t('音源搜索目录') },
          h('div', { style: S.mono }, state.fonts.directories.join('\n')),
        ),
      )
    }

    function AdvancedTab({ state, reload, notify }) {
      const [text, setText] = useState('')
      const [busy, setBusy] = useState('')
      useEffect(() => {
        if (state?.config) setText(JSON.stringify(state.config, null, 2))
      }, [state?.config])
      async function save() {
        setBusy('save')
        try {
          const parsed = JSON.parse(text)
          await api('/config', { method: 'POST', body: { patch: parsed } })
          notify(t('已保存'))
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }
      return h(Card, { title: t('高级：原始配置'), desc: t('整个配置文件就是这一份 JSON，机器上所有 profile 共用。未知字段会在保存时被丢弃。') },
        h('textarea', { value: text, onChange: event => setText(event.target.value), rows: 18, style: { ...S.input, resize: 'vertical', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 } }),
        h('div', { style: S.row },
          h(Btn, { kind: 'primary', disabled: busy === 'save', onClick: save }, t('保存')),
          h(Btn, { onClick: () => setText(JSON.stringify(state.config, null, 2)) }, t('重新载入')),
        ),
      )
    }

    function Page() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [toast, setToast] = useState(null)
      const [tab, setTab] = useState('sources')

      const notify = useCallback((message, tone) => {
        setToast({ message, tone })
        window.clearTimeout(notify.timer)
        notify.timer = window.setTimeout(() => setToast(null), tone === 'error' ? 9000 : 4000)
      }, [])

      const reload = useCallback(async () => {
        try {
          const data = await api('/state')
          setState(data)
          setError('')
        } catch (caught) {
          setError(caught.message)
        }
      }, [])

      useEffect(() => { reload() }, [reload])

      const tabs = useMemo(() => ([
        { id: 'sources', label: t('音源'), render: () => h(FontsTab, { state, reload, notify }) },
        { id: 'tts', label: t('配音'), render: () => h(TtsTab, { state, reload, notify }) },
        { id: 'mix', label: t('混音与输出'), render: () => h(MixTab, { state, reload, notify }) },
        { id: 'diagnostics', label: t('诊断'), render: () => h(DiagnosticsTab, { state, reload, notify }) },
        { id: 'advanced', label: t('高级'), render: () => h(AdvancedTab, { state, reload, notify }) },
      ]), [state, reload, notify, LANG])

      if (error) {
        return h('div', { style: S.page },
          h('h2', { style: S.title }, 'AnyAudio'),
          h(Notice, { tone: 'error' }, t('无法读取设置：{0}。确认插件已启用，并重启一次 DSH。', error)),
          h('div', null, h(Btn, { onClick: reload }, t('重试'))),
        )
      }
      if (!state) return h('div', { style: S.page }, h('p', { style: S.desc }, t('正在读取 AnyAudio 设置…')))

      LANG = detectLanguage(state.config)
      if (LANG === 'en') document.documentElement.lang = 'en'

      async function saveLanguage(value) {
        try {
          await api('/config', { method: 'POST', body: { patch: { ui: { language: value } } } })
          notify(t('语言已保存'))
          await reload()
        } catch (caught) {
          notify(caught.message, 'error')
        }
      }

      const active = tabs.find(item => item.id === tab) || tabs[0]
      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('h2', { style: S.title }, 'AnyAudio'),
          h('span', { style: S.chip }, `v${state.version}`),
          h('span', { style: S.chip }, state.fonts.rows.length ? `${state.fonts.rows.length} ${t('个音源')}` : t('尚未安装音源')),
          h('span', { style: S.chip }, state.tts.providers.find(item => item.id === state.config.tts.provider)?.label || state.config.tts.provider),
          h('span', { style: S.chip }, state.ffmpeg ? t('ffmpeg 可用') : t('ffmpeg 缺失')),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { ...S.desc, fontSize: 11 } }, t('界面语言')),
          h('select', {
            value: state.config.ui?.language ?? 'auto',
            onChange: event => void saveLanguage(event.target.value),
            style: { ...S.input, width: 'auto', minWidth: 110, fontSize: 12 },
          },
            h('option', { value: 'auto' }, t('跟随系统')),
            h('option', { value: 'zh' }, t('中文')),
            h('option', { value: 'en' }, t('English')),
          ),
          h(Btn, { onClick: reload }, t('刷新')),
        ),
        h('p', { style: S.desc }, t('给视频自动配乐的插件。设置保存在本机一份文件里，不随 DSH 账户或 profile 变化；API Key 单独存在 DSH 凭据库。')),
        h('div', { style: S.tabs }, tabs.map(item => h('button', { key: item.id, type: 'button', onClick: () => setTab(item.id), style: S.tab(item.id === tab) }, item.label))),
        active.render(),
        toast ? h('div', { style: { position: 'sticky', bottom: 8, zIndex: 5 } }, h(Notice, { tone: toast.tone === 'error' ? 'error' : 'info' }, toast.message)) : null,
      )
    }

    function apply(ctx) {
      const setSection = () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'any-audio',
        order: 210,
        label: () => 'AnyAudio',
      }, () => h(Page)))
      try {
        setSection()
      } catch (error) {
        console.error('[any-audio] settings section failed', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'any-audio'
    exports.__test = { bytes, detectLanguage, t: (key) => (LANG === 'zh' ? key : (EN[key] ?? key)) }
    return module.exports
  },
})
