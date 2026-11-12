/**
 * AnyAudio settings page.
 *
 * Registered into `settings.section`; every value is read from and written to
 * the plugin's own same-origin routes (/api/dsh-any-audio/*), which are backed by
 * one machine-wide config file — DSH's settings service is profile-scoped, so it
 * cannot be the source of truth.
 */
import { h, Fragment, useState, useEffect, useCallback, useMemo, S, bytes, Btn, Field, TextInput, NumberInput, Select, Switch, Notice, Card } from './ui.js'
import { t, detectLanguage, setLanguage, setLanguagePreference, language } from './i18n.js'
import { api } from './api.js'
import { BASE_PACK, DownloadLinks } from './base-pack.js'

function FontsTab({ state, reload, notify }) {
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [picker, setPicker] = useState(null)
  const [customPath, setCustomPath] = useState('')
  const [openDetails, setOpenDetails] = useState({})
  const [showRecommended, setShowRecommended] = useState(false)
  const toggleDetails = (key) => setOpenDetails(current => ({ ...current, [key]: !current[key] }))

  // The job lives on the host, not in this component: reopening the settings
  // page must pick up an install that is still running.
  useEffect(() => {
    let cancelled = false
    api('/jobs/active?kind=install')
      .then((data) => {
        if (!cancelled && data.job) setJob(data.job)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

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
      notify(data.reused ? t('已有一个下载任务在进行') : t('开始下载，关掉设置页后仍会继续'))
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

  // Choosing the default bank had no control at all: the page only showed the
  // path a render would use, which is the fallback when nothing is configured —
  // so a person could read "默认音源：GeneralUser" and believe they had chosen it
  // while every tool still reported "not set" (improvement plan 04).
  async function setDefault(font) {
    const value = font.recommendedId || font.path
    setBusy(`default:${font.path}`)
    try {
      await api('/config', { method: 'POST', body: { patch: { music: { font: value } } } })
      notify(t('已设为默认音源'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  const isDefault = (font) => Boolean(fonts.configured) && (fonts.configured === font.recommendedId || fonts.configured === font.path)

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
  const installing = Boolean(job && job.status === 'running')
  // Once every recommendation is installed the section is a wall of "已安装"
  // that says nothing; one line and a way back in is the whole message.
  const allRecommendedInstalled = fonts.available.length > 0
    && fonts.available.every(font => fonts.rows.some(row => row.recommendedId === font.id))

  return h(Fragment, null,
    h(Card, {
      title: t('推荐音源'),
      desc: t('作者精选。装一套就能覆盖大部分配乐。'),
      right: h(Btn, { onClick: reload }, t('刷新')),
    },
      job ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('span', { style: S.label }, job.status === 'running' ? `${t('正在安装')}${job.label ? ` ${job.label}` : ''}${job.total ? ` ${Math.round(percent)}%` : ''}` : job.status === 'done' ? t('完成：{0}', job.message || t('已安装')) : t('失败：{0}', job.error || '')),
          job.total ? h('span', { style: S.mono }, `${bytes(job.received)} / ${bytes(job.total)}`) : null,
        ),
        h('div', { style: S.bar }, h('div', { style: S.barFill(percent) })),
      ) : null,
      allRecommendedInstalled && !showRecommended
        ? h('div', { style: S.row },
          h('span', { style: S.desc }, t('推荐音源已全部安装')),
          h(Btn, { onClick: () => setShowRecommended(true) }, t('查看')),
        )
        : h('div', { style: S.list },
          fonts.available.map(font => {
            const installed = fonts.rows.find(row => row.recommendedId === font.id)
            const key = `rec:${font.id}`
            const open = Boolean(openDetails[key])
            return h('div', { key: font.id, style: S.item },
              h('div', { style: S.itemHead },
                h('span', { style: { fontWeight: 600 } }, font.name),
                h('span', { style: S.mono }, bytes(font.bytes)),
                h('span', { style: S.chip }, installed ? t('已安装') : t('未安装')),
                font.default ? h('span', { style: S.chip }, t('默认')) : null,
                h('span', { style: { flex: 1 } }),
                installed ? null : h(Btn, { kind: 'primary', disabled: installing || busy === `install:${font.id}`, onClick: () => install({ id: font.id }) }, t('下载安装')),
                h(Btn, { onClick: () => toggleDetails(key) }, open ? t('收起') : t('详情')),
              ),
              font.tagline ? h('div', { style: S.desc }, t(font.tagline)) : null,
              open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                h('div', { style: S.mono }, t('许可证：{0}', font.license)),
                font.manual ? h('div', { style: S.mono }, t('手动下载：{0}', font.manual)) : null,
                installed?.sha256 ? h('div', { style: S.mono }, t('SHA-256：{0}…（{1}）', installed.sha256.slice(0, 24), installed.status === 'ok' ? t('记录一致') : t('与记录不一致'))) : null,
              ) : null,
            )
          }),
        ),
    ),
    h(Card, { title: t('已安装'), desc: t('这些音源已经在这台机器上，可以直接用。') },
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
      fonts.rows.length === 0
        ? h('p', { style: S.desc }, t('还没有安装任何音源。从上面的推荐里挑一套，或在下面按文件安装。'))
        : h('div', { style: S.list }, fonts.rows.map(row => {
          const recommended = fonts.available.find(font => font.id === row.recommendedId)
          const label = recommended?.name ?? row.name
          const open = Boolean(openDetails[row.path])
          return h('div', { key: row.path, style: S.item },
            h('div', { style: S.itemHead },
              h('span', { style: { fontWeight: 600 } }, label),
              h('span', { style: S.mono }, bytes(row.bytes)),
              isDefault(row) ? h('span', { style: S.chip }, t('默认')) : null,
              row.status === 'ok' ? null : h('span', { style: S.chip }, row.status === 'modified' ? t('文件被修改') : t('已安装（未登记）')),
              h('span', { style: { flex: 1 } }),
              h(Btn, { onClick: () => openPreview(row.path) }, t('试听')),
              h(Btn, { kind: isDefault(row) ? 'primary' : 'plain', onClick: () => setDefault(row) }, isDefault(row) ? t('当前默认') : t('设为默认')),
              h(Btn, { onClick: () => { if (window.confirm(t('删除 {0} 的文件？\n\n之后需要重新下载才能使用。', label))) act('remove', { path: row.path, removeFile: true }) } }, t('删除')),
              h(Btn, { onClick: () => toggleDetails(row.path) }, open ? t('收起') : t('详情')),
            ),
            recommended?.tagline ? h('div', { style: S.desc }, t(recommended.tagline)) : null,
            open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: S.mono }, row.path),
              row.sha256 ? h('div', { style: S.mono }, t('SHA-256：{0}…（{1}）', row.sha256.slice(0, 24), row.status === 'ok' ? t('记录一致') : t('与记录不一致'))) : null,
              h('div', { style: S.row }, h(Btn, { onClick: () => act('verify', { path: row.path }) }, t('校验'))),
            ) : null,
          )
        })),
    ),
    h(Card, { title: t('安装音源'), desc: t('填一个 .sf2 / .sf3 / .dls 文件的路径。7z / zip 请先解压。') },
      h('div', { style: S.row },
        h(TextInput, { value: customPath, onChange: setCustomPath, placeholder: t('粘贴文件路径') }),
        h(Btn, { disabled: !customPath.trim() || installing || busy.startsWith('install:'), onClick: () => install({ fromPath: customPath.trim() }) }, t('安装')),
      ),
    ),
    h(Card, { title: t('音源目录'), desc: t('整台机器共用这一个音源库；环境变量 ANYAUDIO_FONTS 可以追加目录。') },
      h('div', { style: S.mono }, fonts.directories.join('\n')),
      // "默认音源" used to show the path a render would land on, which is the
      // fallback when nothing was chosen. Naming both makes "did I set one?"
      // answerable from this page (improvement plan 04).
      h('div', { style: S.desc }, fonts.configured
        ? t('你选的默认音源：{0}', fonts.configured)
        : t('你选的默认音源：未选择（没选时使用 {0}）', fonts.fallbackPath || t('未安装音源'))),
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

/**
 * Sound packs: what is installed, and which packs `catalog` expands.
 *
 * There is no browser and no audition here on purpose. A sound is judged by
 * putting it on a timeline and listening to it there, which is what the clip
 * bay is for; a second player in the settings page would be a worse copy of it.
 */
function FxLibTab({ state, reload, notify }) {
  const [packs, setPacks] = useState(null)
  const [root, setRoot] = useState('')
  const [busy, setBusy] = useState('')
  const [installPath, setInstallPath] = useState('')
  const [error, setError] = useState('')
  const [showDownloads, setShowDownloads] = useState(false)
  const [showRecommended, setShowRecommended] = useState(false)
  const [openDetails, setOpenDetails] = useState({})
  const toggleDetails = (key) => setOpenDetails(current => ({ ...current, [key]: !current[key] }))

  const load = useCallback(async () => {
    try {
      const data = await api('/sfx/packs')
      setPacks(data.packs ?? [])
      setRoot(data.root ?? '')
      setError('')
    } catch (caught) {
      setError(caught.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function toggle(pack) {
    setBusy(pack.id)
    try {
      await api('/sfx/packs/toggle', { method: 'POST', body: { id: pack.id, priority: !pack.priority } })
      await load()
      await reload()
    } catch (caught) {
      notify(caught.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function install() {
    const fromPath = installPath.trim()
    if (!fromPath) return
    setBusy('install')
    try {
      const result = await api('/sfx/packs/install', { method: 'POST', body: { fromPath } })
      notify(t('已安装 {0}（{1} 条）', result.id, result.count ?? ''))
      setInstallPath('')
      await load()
    } catch (caught) {
      notify(caught.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function remove(pack) {
    if (!window.confirm(t('删除音效包「{0}」？已经放进工程的素材不受影响。', pack.name))) return
    setBusy(pack.id)
    try {
      await api('/sfx/packs/remove', { method: 'POST', body: { id: pack.id } })
      await load()
      await reload()
    } catch (caught) {
      notify(caught.message, 'error')
    } finally {
      setBusy('')
    }
  }

  const installed = Boolean(packs?.some(pack => pack.id === BASE_PACK.id))

  return h(Fragment, null,
    h(Card, { title: t('推荐音效包'), desc: t('作者精选。装一次，所有工程共用。') },
      installed && !showRecommended
        ? h('div', { style: S.row },
          h('span', { style: S.desc }, t('推荐音效包已安装')),
          h(Btn, { onClick: () => setShowRecommended(true) }, t('查看')),
        )
        : h('div', { style: S.list },
          h('div', { style: S.item },
            h('div', { style: S.itemHead },
              h('span', { style: { fontWeight: 600 } }, BASE_PACK.name),
              h('span', { style: S.chip }, `${BASE_PACK.count} ${t('条')}`),
              h('span', { style: S.chip }, BASE_PACK.size),
              h('span', { style: S.chip }, BASE_PACK.license),
              installed ? h('span', { style: S.chip }, t('已安装')) : null,
              h('span', { style: { flex: 1 } }),
              h(Btn, { onClick: () => setShowDownloads(value => !value) }, t('去下载')),
            ),
            h('div', { style: S.desc }, t(BASE_PACK.summary)),
            h('div', { style: S.desc }, t('压缩包，下载后解压，把解压出来的 BaseSFX 目录路径填到下面「安装」。')),
            showDownloads ? h(DownloadLinks, null) : null,
          ),
        ),
    ),
    h(Card, { title: t('已安装'), desc: t('打开「优先」的包，名字会直接列在 catalog 里；其余包用 search 检索。') },
      error ? h(Notice, { tone: 'error' }, error)
        : !packs ? h('p', { style: S.desc }, t('正在读取音效包…'))
        : packs.length === 0 ? h('p', { style: S.desc }, t('还没有安装任何音效包。把包目录的路径填在下面安装。'))
        : h('div', { style: S.list }, packs.map(pack => {
          const open = Boolean(openDetails[pack.id])
          return h('div', { key: pack.id, style: S.item },
            h('div', { style: S.itemHead },
              h('span', { style: { fontWeight: 600 } }, pack.name),
              h('span', { style: S.chip }, `${pack.count} ${t('条')}`),
              pack.license ? h('span', { style: S.chip }, pack.license) : null,
              h('span', { style: { flex: 1 } }),
              h(Switch, {
                checked: pack.priority,
                disabled: busy === pack.id,
                onChange: () => toggle(pack),
                label: pack.priority ? t('优先') : t('普通'),
              }),
              h(Btn, { kind: 'ghost', disabled: busy === pack.id, onClick: () => remove(pack) }, t('删除')),
              h(Btn, { onClick: () => toggleDetails(pack.id) }, open ? t('收起') : t('详情')),
            ),
            open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: S.mono }, pack.dir),
              pack.tokens ? h('div', { style: S.desc }, t('优先时约占用 {0}K tokens 上下文', pack.tokens)) : null,
            ) : null,
          )
        })),
      h('p', { style: { ...S.desc, marginTop: 10 } }, t('打开「优先」会占用更多上下文，建议只对常用的音效包使用。')),
    ),
    h(Card, { title: t('安装音效包'), desc: t('填一个包含 manifest.json 的包目录。没有 manifest 的目录先用打包脚本生成。') },
      h('div', { style: S.row },
        h(TextInput, { value: installPath, placeholder: t('把解压出来的 BaseSFX 文件夹路径粘贴到这里'), onChange: setInstallPath }),
        h(Btn, { kind: 'primary', disabled: busy === 'install' || !installPath.trim(), onClick: install }, t('安装')),
      ),
    ),
    h(Card, { title: t('音效包目录'), desc: t('整台机器共用这一个音效库；装一次，所有工程共用。') },
      h('div', { style: S.mono }, root || t('正在读取…')),
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
  // The guide's "seen" flag is the plugin's own number, not the shell's: the
  // shell forgets as soon as the person types, so replaying means clearing this.
  // The event reaches a guide that is already mounted, so replaying does not
  // need a page reload.
  async function replayGuide() {
    setBusy('guide')
    try {
      await api('/config', { method: 'POST', body: { patch: { ui: { onboardedVersion: 0 } } } })
      window.dispatchEvent(new CustomEvent('anyaudio:onboarding-reset'))
      notify(t('已重置。打开一个新对话即可看到引导。'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }
  return h(Fragment, null,
    h(Card, { title: t('高级：原始配置'), desc: t('整个配置文件就是这一份 JSON，机器上所有 profile 共用。未知字段会在保存时被丢弃。') },
      h('textarea', { value: text, onChange: event => setText(event.target.value), rows: 18, style: { ...S.input, resize: 'vertical', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 } }),
      h('div', { style: S.row },
        h(Btn, { kind: 'primary', disabled: busy === 'save', onClick: save }, t('保存')),
        h(Btn, { onClick: () => setText(JSON.stringify(state.config, null, 2)) }, t('重新载入')),
      ),
    ),
    h(Card, { title: t('音源搜索目录') },
      h('div', { style: S.mono }, state.fonts.directories.join('\n')),
    ),
    h(Card, { title: t('首次安装引导'), desc: t('装音源、装音效包、认识剪辑台。已经看过的话，这里可以重放。') },
      h('div', { style: S.row },
        h(Btn, { disabled: busy === 'guide', onClick: replayGuide }, t('重新播放引导')),
        h('span', { style: S.desc }, t('重置后打开一个新对话即可看到。')),
      ),
    ),
    h(Card, { title: t('恢复默认设置'), desc: t('音源文件不会删除，API Key 也不会删除。') },
      h('div', { style: S.row },
        h(Btn, { disabled: busy === 'reset', onClick: reset }, t('恢复默认设置')),
      ),
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
    { id: 'fxlib', label: t('音效包'), render: () => h(FxLibTab, { state, reload, notify }) },
    { id: 'tts', label: t('配音'), render: () => h(TtsTab, { state, reload, notify }) },
    { id: 'mix', label: t('混音与输出'), render: () => h(MixTab, { state, reload, notify }) },
    { id: 'advanced', label: t('高级'), render: () => h(AdvancedTab, { state, reload, notify }) },
  ]), [state, reload, notify])

  if (error) {
    return h('div', { style: S.page },
      h('h2', { style: S.title }, 'AnyAudio'),
      h(Notice, { tone: 'error' }, t('无法读取设置：{0}。确认插件已启用，并重启一次 DSH。', error)),
      h('div', null, h(Btn, { onClick: reload }, t('重试'))),
    )
  }
  if (!state) return h('div', { style: S.page }, h('p', { style: S.desc }, t('正在读取 AnyAudio 设置…')))

  // Record the preference as well as adopting it: the clip bay's tab label is
  // translated outside any component, so it resolves the language on every read
  // and needs to know whether a language is pinned or left on "auto".
  setLanguagePreference(state.config?.ui?.language || 'auto')
  setLanguage(detectLanguage(state.config))
  if (language() === 'en') document.documentElement.lang = 'en'

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

export { Page, FontsTab, FxLibTab }
