/**
 * AnyAudio settings page.
 *
 * Registered into `settings.section`; every value is read from and written to
 * the plugin's own same-origin routes (/api/dsh-any-audio/*), which are backed by
 * one machine-wide config file — DSH's settings service is profile-scoped, so it
 * cannot be the source of truth.
 */
import { h, Fragment, useState, useEffect, useCallback, useMemo, C, S, bytes, Btn, Field, TextInput, NumberInput, Select, Switch, Notice, Card, HelpTip } from './ui.js'
import { t, jobFailure, detectLanguage, setLanguage, setLanguagePreference, language } from './i18n.js'
import { api } from './api.js'
import { BASE_PACK, DownloadLinks, VoicebankDownloadLinks, useVoicebankSources, installVoicebankZip } from './base-pack.js'

const GITHUB_URL = 'https://github.com/cloudoyx/any-audio'

/** Category badge in front of a source name: VST3 blue, SF2 green. */
function kindBadge(kind) {
  const vst3 = kind === 'vst3'
  return h('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 6px',
      borderRadius: 4,
      background: vst3 ? C.accent : C.good,
      color: '#fff',
      fontSize: 10,
      fontWeight: 600,
      lineHeight: '16px',
    },
  }, vst3 ? 'VST3' : 'SF2')
}

/**
 * The host's suggestion, not a rule: a plugin whose metadata declares an
 * Instrument class gets a green「音源」, one that clearly is an effect gets a
 * grey「效果器」. Anything unreadable shows nothing, and the person still picks.
 */
function suggestionBadge(recognized) {
  if (recognized !== 'instrument' && recognized !== 'effect') return null
  const instrument = recognized === 'instrument'
  return h('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 6px',
      borderRadius: 4,
      background: instrument ? C.good : C.soft,
      color: instrument ? '#fff' : C.muted,
      border: instrument ? 'none' : `1px solid ${C.border}`,
      fontSize: 10,
      fontWeight: 600,
      lineHeight: '16px',
      whiteSpace: 'nowrap',
    },
  }, instrument ? t('音源') : t('效果器'))
}

/**
 * What a person needs to know about a built-in instrument, in their words.
 * The catalog's own notes are written for the agent — measured MIDI numbers,
 * which notes are silent — and those stay out of the page.
 */
const VST3_NOTES = {
  'ample-bass-p-lite': '低音区音色有限',
  'ample-guitar-m-lite': '低音 E 弦不发声；效果音需按演奏法触发',
}

function FontsTab({ state, reload, notify }) {
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [picker, setPicker] = useState(null)
  const [customPath, setCustomPath] = useState('')
  const [openDetails, setOpenDetails] = useState({})
  const [showRecommended, setShowRecommended] = useState(false)
  const [vst3, setVst3] = useState(null)
  const [vst3Error, setVst3Error] = useState('')
  const [vst3Path, setVst3Path] = useState('')
  const [scanDir, setScanDir] = useState('C:\\Program Files\\Common Files\\VST3')
  const [scan, setScan] = useState(null)
  const [scanPicks, setScanPicks] = useState({})
  const [vst3Preview, setVst3Preview] = useState(null)
  const [runtime, setRuntime] = useState(null)
  const [runtimeJob, setRuntimeJob] = useState(null)
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
        if (data.job.status === 'error') notify(jobFailure(data.job), 'error')
      } catch (error) {
        notify(error.message, 'error')
        setJob(null)
      }
    }, 700)
    return () => clearInterval(timer)
  }, [job, reload, notify])

  // VST3 entries live in the same list as the SF2 banks: one page, one list,
  // a badge on each row. The catalog is its own route because it merges the
  // built-in entries with the plugins the person added.
  const loadVst3 = useCallback(async () => {
    try {
      const data = await api('/vst3/list')
      setVst3(data)
      setVst3Error('')
    } catch (error) {
      setVst3Error(error.message)
    }
  }, [])

  useEffect(() => { loadVst3() }, [loadVst3])

  // The VST3 render runtime is a separate install from the sound sources: the
  // sidecar needs a Python that can import pedalboard/numpy/mido, and a machine
  // that only installed the plugin has none. Status has its own route, and the
  // install is a host job, so reopening settings must pick up a running one.
  const loadRuntime = useCallback(async () => {
    try {
      setRuntime(await api('/vst3/status'))
    } catch (error) {
      setRuntime({ ok: false, error: error.message })
    }
  }, [])

  useEffect(() => { loadRuntime() }, [loadRuntime])

  useEffect(() => {
    let cancelled = false
    api('/jobs/active?kind=vst3-install')
      .then((data) => { if (!cancelled && data.job) setRuntimeJob(data.job) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!runtimeJob || runtimeJob.status !== 'running') return undefined
    const timer = setInterval(async () => {
      try {
        const data = await api(`/jobs?id=${encodeURIComponent(runtimeJob.id)}`)
        setRuntimeJob(data.job)
        if (data.job.status === 'done') {
          notify(t('VST3 运行时已安装'))
          await loadRuntime()
        }
        if (data.job.status === 'error') notify(jobFailure(data.job), 'error')
      } catch (error) {
        notify(error.message, 'error')
        setRuntimeJob(null)
      }
    }, 700)
    return () => clearInterval(timer)
  }, [runtimeJob, loadRuntime, notify])

  async function installRuntime() {
    setBusy('vst3-install')
    try {
      const data = await api('/vst3/install', { method: 'POST', body: {} })
      setRuntimeJob(data.job)
      notify(data.reused ? t('已有一个下载任务在进行') : t('安装已开始，关掉设置页后仍会继续'))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

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
      notify(t('已设为鼓组音源'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  // The bank a render actually lands on, not the one that was chosen: with
  // nothing chosen the host picks one, and the page has to say which. Comparing
  // against `configured` left every row unmarked until someone pressed the
  // button, which is exactly the question "which one is the default?".
  const isDefault = (font) => Boolean(fonts.defaultPath) && fonts.defaultPath === font.path

  async function runPreview(path, program) {
    setBusy(`preview:${path}:${program}`)
    try {
      const data = await api('/sources/preview', { method: 'POST', body: { path, program } })
      setPreview(data)
      notify(t('试听已生成'))
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

  // The host renders a short arpeggio now, so the page only names the plugin.
  async function testVst3(plugin) {
    setBusy(`vst3:test:${plugin.id}`)
    try {
      const data = await api('/vst3/test', { method: 'POST', body: { plugin: plugin.id } })
      setVst3Preview({ ...data, pluginId: plugin.id })
      notify(t('试听已生成'))
    } catch (error) {
      notify(t('试听失败：{0}', error.message), 'error')
    } finally {
      setBusy('')
    }
  }

  async function addVst3(path, name, vendor) {
    setBusy(`vst3:add:${path}`)
    try {
      await api('/vst3/add', { method: 'POST', body: { path, name, vendor } })
      notify(t('已添加 VST3 音源'))
      await loadVst3()
    } catch (error) {
      // Adding the same path twice is refused by the host; the reason has to
      // reach the person instead of the button looking dead.
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function removeVst3(plugin) {
    setBusy(`vst3:remove:${plugin.plugin}`)
    try {
      await api('/vst3/remove', { method: 'POST', body: { path: plugin.plugin } })
      notify(t('已移除 VST3 音源'))
      await loadVst3()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function scanVst3() {
    setBusy('vst3:scan')
    try {
      const data = await api('/vst3/scan', { method: 'POST', body: { dir: scanDir.trim() || undefined } })
      setScan(data)
      // Only what the plugin itself declares as an instrument starts checked;
      // a plugin the host recognises as an instrument counts too. Effect
      // plugins (Waves, Valhalla, FabFilter …) and single files with no
      // metadata stay unchecked, and the person decides.
      setScanPicks(Object.fromEntries((data.plugins ?? []).map(item => [
        item.path,
        item.declaredInstrument === true || item.recognized === 'instrument',
      ])))
      notify(t('扫描到 {0} 个 VST3 插件', data.plugins.length))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  /** Add every checked scan result in one go; unchecked rows are skipped. */
  async function addPicked() {
    const picked = (scan?.plugins ?? []).filter(item => scanPicks[item.path]
      && !vst3Plugins.some(plugin => plugin.plugin.toLowerCase() === item.path.toLowerCase()))
    if (picked.length === 0) return
    setBusy('vst3:add:batch')
    let added = 0
    try {
      for (const item of picked) {
        await api('/vst3/add', { method: 'POST', body: { path: item.path, name: item.name, vendor: item.vendor } })
        added++
      }
      notify(t('已添加 {0} 个 VST3 音源', added))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
      await loadVst3()
    }
  }

  const fonts = state.fonts
  // A single-instrument bank (e.g. Electric Guitar Clean) is published only as
  // a 7z archive, so there is no URL the installer could fetch: point the
  // button at the release page instead of offering a download that always fails.
  const libraryDir = fonts.libraryDir || fonts.directories?.[0] || ''
  const percent = job && job.total ? (job.received / job.total) * 100 : 0
  const installing = Boolean(job && job.status === 'running')
  // A recommendation is an offer, not a catalogue: once the bank is installed it
  // belongs in the list below, and leaving it here only pushes the ones the
  // person can still add further down the page.
  const missingRecommended = fonts.available.filter(font => !fonts.rows.some(row => row.recommendedId === font.id))
  const allRecommendedInstalled = fonts.available.length > 0 && missingRecommended.length === 0
  const recommendedShown = showRecommended ? fonts.available : missingRecommended
  const vst3Plugins = vst3?.plugins ?? []
  const scanPlugins = scan?.plugins ?? []
  const pickedCount = scanPlugins.filter(item => scanPicks[item.path]
    && !vst3Plugins.some(plugin => plugin.plugin.toLowerCase() === item.path.toLowerCase())).length
  const runtimeInstalled = Boolean(runtime?.runtime?.installed)
  const runtimeReady = Boolean(runtime?.ready)
  const runtimeInstalling = Boolean(runtimeJob && runtimeJob.status === 'running')
  const runtimePercent = runtimeJob?.status === 'done'
    ? 100
    : runtimeJob && runtimeJob.total ? (runtimeJob.received / runtimeJob.total) * 100 : 0
  const runtimeDeps = runtime?.deps ?? {}

  function renderFontRow(row) {
    const recommended = fonts.available.find(font => font.id === row.recommendedId)
    const label = recommended?.name ?? row.name
    const open = Boolean(openDetails[row.path])
    return h('div', { key: `sf2:${row.path}`, style: S.item },
      h('div', { style: S.itemHead },
        kindBadge('sf2'),
        h('span', { style: { fontWeight: 600 } }, label),
        isDefault(row) ? h('span', { style: S.chip }, t('鼓组音源')) : null,
        row.status === 'ok' ? null : h('span', { style: S.chip }, row.status === 'modified' ? t('文件被修改') : t('已安装（未登记）')),
        h('span', { style: { flex: 1 } }),
        h(Btn, { onClick: () => openPreview(row.path) }, t('试听')),
        // No button on the row that already is the default: a control that
        // does nothing is worse than no control.
        isDefault(row) ? null : h(Btn, { onClick: () => setDefault(row) }, t('设为鼓组音源')),
        h(Btn, { onClick: () => { if (window.confirm(t('删除 {0} 的文件？\n\n之后需要重新下载才能使用。', label))) act('remove', { path: row.path, removeFile: true }) } }, t('删除')),
        h(Btn, { onClick: () => toggleDetails(row.path) }, open ? t('收起') : t('详情')),
      ),
      open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        recommended?.tagline ? h('div', { style: S.desc }, t(recommended.tagline)) : null,
        h('div', { style: S.mono }, row.path),
        h('div', { style: S.desc }, bytes(row.bytes)),
        row.sha256 ? h('div', { style: S.mono }, t('SHA-256：{0}…（{1}）', row.sha256.slice(0, 24), row.status === 'ok' ? t('记录一致') : t('与记录不一致'))) : null,
        h('div', { style: S.row }, h(Btn, { onClick: () => act('verify', { path: row.path }) }, t('校验'))),
      ) : null,
    )
  }

  function renderVst3Row(plugin) {
    const scanned = plugin.kind === 'scanned'
    const open = Boolean(openDetails[`vst3:${plugin.id}`])
    const playing = vst3Preview?.pluginId === plugin.id
    const note = VST3_NOTES[plugin.id] ?? (scanned ? '扫描条目：音域与演奏法未实测。' : '')
    return h('div', { key: `vst3:${plugin.id}`, style: S.item },
      h('div', { style: S.itemHead },
        kindBadge('vst3'),
        h('span', { style: { fontWeight: 600 } }, plugin.name),
        suggestionBadge(plugin.recognized),
        plugin.vendor && plugin.vendor !== '未知' ? h('span', { style: S.chip }, plugin.vendor) : null,
        scanned ? h('span', { style: S.chip }, t('未实测')) : null,
        h('span', { style: { flex: 1 } }),
        // One render at a time: the sidecar serialises them anyway, and a
        // second click while the first is warming up would just queue.
        h(Btn, { kind: 'primary', disabled: Boolean(busy), onClick: () => testVst3(plugin) }, busy === `vst3:test:${plugin.id}` ? t('渲染中…') : t('试听')),
        scanned ? h(Btn, { disabled: busy === `vst3:remove:${plugin.plugin}`, onClick: () => removeVst3(plugin) }, t('移除')) : null,
        h(Btn, { onClick: () => toggleDetails(`vst3:${plugin.id}`) }, open ? t('收起') : t('详情')),
      ),
      open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: S.desc }, plugin.range ? t('音域：实测 MIDI {0}–{1}', plugin.range.low, plugin.range.high) : t('音域：未实测')),
        h('div', { style: S.desc }, t('演奏法：{0} 个', plugin.articulations.length)),
        h('div', { style: S.desc }, t('效果音：{0} 个', plugin.fxSounds.length)),
        note ? h('div', { style: S.desc }, t(note)) : null,
        scanned ? h('div', { style: S.desc }, t('只能显式指定，不参与自动选源。')) : null,
        h('div', { style: S.mono }, plugin.plugin),
      ) : null,
      playing ? h('audio', { controls: true, autoPlay: true, src: vst3Preview.url, style: S.audio }) : null,
    )
  }

  return h(Fragment, null,
    h(Card, { inline: true, title: t('音源介绍'), desc: t('音源分两类，按需选择，也可以都装。') },
      h('div', { style: S.grid2 },
        h('div', { style: S.item },
          h('div', { style: S.itemHead },
            kindBadge('sf2'),
            h('span', { style: { fontWeight: 600 } }, t('SoundFont')),
          ),
          h('div', { style: S.desc }, t('体积小、安装方便，一个文件即装即用。')),
        ),
        h('div', { style: S.item },
          h('div', { style: S.itemHead },
            kindBadge('vst3'),
            h('span', { style: { fontWeight: 600 } }, t('虚拟乐器插件')),
          ),
          h('div', { style: S.desc }, t('音色真实、可调性好，需要先装运行时。')),
        ),
      ),
    ),
    h(Card, {
      inline: true,
      title: t('推荐音源'),
      desc: t('作者精选。既有通用音源，也有专攻一种乐器的特色音源。'),
      right: h(Btn, { onClick: reload }, t('刷新')),
    },
      job ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('span', { style: S.label }, job.status === 'running' ? `${t('正在安装')}${job.label ? ` ${job.label}` : ''}${job.total ? ` ${Math.round(percent)}%` : ''}` : job.status === 'done' ? t('完成：{0}', job.message || t('已安装')) : t('失败：{0}', jobFailure(job))),
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
          recommendedShown.map(font => {
            const installed = fonts.rows.find(row => row.recommendedId === font.id)
            const key = `rec:${font.id}`
            const open = Boolean(openDetails[key])
            return h('div', { key: font.id, style: S.item },
              h('div', { style: S.itemHead },
                kindBadge('sf2'),
                h('span', { style: { fontWeight: 600 } }, font.name),
                h('span', { style: S.mono }, bytes(font.bytes)),
                h('span', { style: S.chip }, installed ? t('已安装') : t('未安装')),
                font.default ? h('span', { style: S.chip }, t('默认')) : null,
                h('span', { style: { flex: 1 } }),
                installed ? null : font.url
                  ? h(Btn, { kind: 'primary', disabled: installing || busy === `install:${font.id}`, onClick: () => install({ id: font.id }) }, t('下载安装'))
                  : font.manual
                    ? h(Btn, { kind: 'primary', onClick: () => window.open(font.manual, '_blank', 'noopener,noreferrer') }, t('下载'))
                    : null,
                h(Btn, { onClick: () => toggleDetails(key) }, open ? t('收起') : t('详情')),
              ),
              font.tagline ? h('div', { style: S.desc }, t(font.tagline)) : null,
              open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                h('div', { style: S.mono }, t('许可证：{0}', font.license)),
                font.manual ? h('div', { style: S.mono }, t('手动下载：{0}', font.manual)) : null,
                font.manual ? h('div', { style: S.mono }, t('安装说明：解压后把 .sf2 放到 {0}，文件名保持 {1}', libraryDir || t('未设置'), font.file)) : null,
                installed?.sha256 ? h('div', { style: S.mono }, t('SHA-256：{0}…（{1}）', installed.sha256.slice(0, 24), installed.status === 'ok' ? t('记录一致') : t('与记录不一致'))) : null,
              ) : null,
            )
          }),
        ),
      h('div', { style: S.item },
        h('div', { style: S.itemHead },
          kindBadge('vst3'),
          h('span', { style: { fontWeight: 600 } }, t('VST3 音源暂无推荐')),
        ),
      ),
    ),
    h(Card, { inline: true, title: t('已安装'), desc: t('这些音源已经在这台机器上，可以直接用。') },
      preview ? h('div', { style: { ...S.item } },
        picker && picker.presets.length > 1
          ? h('div', { style: S.row },
            h('span', { style: S.label }, t('预设')),
            h(Select, {
              value: String(picker.program),
              onChange: value => selectProgram(Number(value)),
              options: picker.presets.map(preset => ({
                value: String(preset.program),
                label: `${preset.program} · ${preset.name} (${preset.family})`,
              })),
            }),
          )
          : null,
        h('audio', { controls: true, autoPlay: true, src: preview.url, style: S.audio }),
      ) : null,
      vst3Error ? h(Notice, { tone: 'error' }, t('读取音源档案失败：{0}', vst3Error)) : null,
      !vst3 && !vst3Error ? h('p', { style: S.desc }, t('正在读取音源档案…')) : null,
      fonts.rows.length === 0 && vst3Plugins.length === 0
        ? h('p', { style: S.desc }, t('还没有安装任何音源。从上面的推荐里挑一套，或在下面按文件安装。'))
        : h('div', { style: S.list }, [...fonts.rows.map(renderFontRow), ...vst3Plugins.map(renderVst3Row)]),
    ),
    h(Card, { inline: true, title: t('安装自定义音源'), desc: t('装 SF2 或 VST3 音源，按下面的方式操作。') },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('span', { style: S.label }, t('① 安装 SF2 音源')),
        h('div', { style: S.row },
          h('div', { style: { flex: '1 1 240px', minWidth: 0 } },
            h(TextInput, { value: customPath, onChange: setCustomPath, placeholder: t('粘贴 .sf2 / .sf3 / .dls 文件路径') }),
          ),
          h(Btn, { disabled: !customPath.trim() || installing || busy.startsWith('install:'), onClick: () => install({ fromPath: customPath.trim() }) }, t('安装')),
        ),
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('span', { style: S.label }, t('② 安装 VST3 音源')),
        h('div', { style: S.row },
          h('div', { style: { flex: '1 1 240px', minWidth: 0 } },
            h(TextInput, { value: vst3Path, onChange: setVst3Path, placeholder: t('粘贴 .vst3 插件路径') }),
          ),
          h(Btn, { disabled: !vst3Path.trim() || busy.startsWith('vst3:add:'), onClick: () => addVst3(vst3Path.trim()) }, t('添加')),
        ),
        h('div', { style: S.row },
          h('div', { style: { flex: '1 1 240px', minWidth: 0 } },
            h(TextInput, { value: scanDir, onChange: setScanDir, placeholder: t('扫描目录') }),
          ),
          h(Btn, { disabled: busy === 'vst3:scan', onClick: scanVst3 }, busy === 'vst3:scan' ? t('扫描中…') : t('扫描')),
        ),
        scan ? h('div', { style: S.list },
          h('div', { style: S.row },
            h('span', { style: S.desc }, t('扫描到 {0} 个插件（{1}）', scan.plugins.length, scan.dir)),
            h('span', { style: { flex: 1 } }),
            h(Btn, { kind: 'primary', disabled: pickedCount === 0 || Boolean(busy), onClick: addPicked }, t('添加选中（{0}）', pickedCount)),
          ),
          scan.plugins.length === 0 ? h('p', { style: S.desc }, t('这个目录里没有可用的 VST3 插件。')) : null,
          ...scan.plugins.map(item => {
            const added = vst3Plugins.some(plugin => plugin.plugin.toLowerCase() === item.path.toLowerCase())
            const picked = Boolean(scanPicks[item.path])
            return h('div', { key: item.path, style: S.item },
              h('div', { style: S.itemHead },
                h('input', {
                  type: 'checkbox',
                  checked: picked,
                  disabled: added,
                  onChange: event => setScanPicks(current => ({ ...current, [item.path]: event.target.checked })),
                }),
                h('span', { style: { fontWeight: 600 } }, item.name),
                suggestionBadge(item.recognized),
                item.vendor ? h('span', { style: S.chip }, item.vendor) : null,
                h('span', { style: S.desc }, item.form === 'single' ? t('单文件') : t('目录包')),
                added ? h('span', { style: S.chip }, t('已添加')) : null,
                h('span', { style: { flex: 1 } }),
                h(Btn, { disabled: added || !picked || busy === `vst3:add:${item.path}`, onClick: () => addVst3(item.path, item.name, item.vendor) }, t('添加')),
              ),
            )
          }),
        ) : null,
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('span', { style: S.label }, t('③ VST3 运行时（VST3 音源渲染需要）')),
        runtime === null
          ? h('p', { style: S.desc }, t('正在检测…'))
          : runtime.ok === false
            ? h(Notice, { tone: 'error' }, t('状态检测失败：{0}', runtime.error))
            : h(Fragment, null,
              h('div', { style: S.row },
                h('span', { style: S.label }, t('运行时')),
                h('span', {
                  style: runtimeInstalled && !runtimeInstalling
                    ? { ...S.chip, borderColor: C.good, color: C.good }
                    : S.chip,
                }, runtimeInstalling ? t('安装中') : runtimeInstalled ? t('已安装') : t('未安装')),
                runtime.runtime?.version ? h('span', { style: S.mono }, t('版本：{0}', runtime.runtime.version)) : null,
                h('span', { style: { flex: 1 } }),
                runtimeReady ? null : h(Btn, {
                  kind: 'primary',
                  disabled: runtimeInstalling || busy === 'vst3-install',
                  onClick: installRuntime,
                }, t('安装运行时')),
              ),
              h('div', { style: S.row },
                h('span', { style: S.label }, t('依赖')),
                ...['pedalboard', 'numpy', 'mido'].map(name => h('span', {
                  key: name,
                  style: {
                    ...S.chip,
                    borderColor: runtimeDeps[name] ? C.good : C.border,
                    color: runtimeDeps[name] ? C.good : C.muted,
                  },
                }, name)),
              ),
              runtimeInstalled && !runtimeReady && !runtimeInstalling
                ? h('div', { style: S.desc }, t('运行时已装好，但依赖不全；点「安装运行时」补齐。'))
                : null,
              runtimeJob && runtimeJob.status !== 'error'
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                    h('span', { style: S.label }, runtimeJob.status === 'running'
                      ? `${t('正在安装')}${runtimeJob.total ? ` ${Math.round(runtimePercent)}%` : ''}${runtimeJob.message ? ` · ${runtimeJob.message}` : ''}`
                      : t('完成：{0}', t('已安装'))),
                    runtimeJob.total ? h('span', { style: S.mono }, `${bytes(runtimeJob.received)} / ${bytes(runtimeJob.total)}`) : null,
                  ),
                  h('div', { style: S.bar }, h('div', { style: S.barFill(runtimePercent) })),
                )
                : null,
              runtimeJob?.status === 'error'
                ? h(Notice, { tone: 'error' }, t('安装失败：{0}', jobFailure(runtimeJob)))
                : null,
            ),
      ),
    ),
    h(Card, { inline: true, title: t('音源目录'), desc: t('SF2 与 VST3 的存放位置。') },
      h('div', { style: S.item },
        h('div', { style: S.itemHead },
          kindBadge('sf2'),
          h('span', { style: { fontWeight: 600 } }, t('SF2 音源库')),
        ),
        h('div', { style: S.mono }, fonts.directories.join('\n')),
        h('div', { style: S.desc }, t('整台机器共用这一个音源库；环境变量 ANYAUDIO_FONTS 可以追加目录。')),
        // "默认音源" used to show the path a render would land on, which is the
        // fallback when nothing was chosen. Naming both makes "did I set one?"
        // answerable from this page (improvement plan 04).
        h('div', { style: S.desc }, fonts.configured
          ? t('你选的默认音源：{0}', fonts.configured)
          : t('默认音源：{0}（自动选择）', fonts.defaultPath || t('未安装音源'))),
      ),
      h('div', { style: S.item },
        h('div', { style: S.itemHead },
          kindBadge('vst3'),
          h('span', { style: { fontWeight: 600 } }, t('VST3 插件')),
          h('span', { style: S.chip }, t('已有 {0} 个接入本插件', vst3Plugins.length)),
        ),
        h('div', { style: S.desc }, t('无统一目录：插件装在系统 VST3 目录，通过上方扫描或添加登记。')),
        vst3Plugins.length === 0 ? h('div', { style: S.desc }, t('扫描后勾选并点「添加」即可接入')) : null,
      ),
    ),
  )
}

function TtsTab({ state, reload, notify }) {
  const [form, setForm] = useState(() => (state?.config?.tts ? JSON.parse(JSON.stringify(state.config.tts)) : null))
  const [keyInput, setKeyInput] = useState('')
  const [busy, setBusy] = useState('')
  const [previewText, setPreviewText] = useState(() => state?.config?.tts?.previewText ?? '')
  const [preview, setPreview] = useState(null)
  const [showKey, setShowKey] = useState(false)

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
      await api('/credentials/set', { method: 'POST', body: { provider, value: keyInput } })
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
      await api('/credentials/unset', { method: 'POST', body: { provider } })
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
      const data = await api('/tts/preview', { method: 'POST', body: { provider, voice: form[provider]?.voice ?? '', text: previewText } })
      setPreview(data)
      notify(t('试听已生成'))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  const engines = state.tts.providers
  const engine = engines.find(item => item.id === provider) ?? engines[0]
  const voices = engine?.voices ?? []
  const savedProvider = state.config.tts.provider
  const savedEngine = engines.find(item => item.id === savedProvider)
  const savedVoice = state.config.tts[savedProvider]?.voice ?? ''
  // Which engines the person can actually reach right now. MiMo needs a saved
  // key; DeepSeek needs the DSH sign-in. Edge needs neither, so it never shows
  // a readiness line.
  const keyReady = {
    mimo: Boolean(state.tts.mimoConfigured),
    deepseek: Boolean(state.tts.deepseekConfigured),
  }

  return h(Card, { title: t('配音（TTS）'), desc: t('给视频配旁白。') },
    h('div', { style: S.row },
      h(Field, { label: t('引擎') },
        h(Select, {
          value: provider,
          onChange: value => set('provider', value),
          options: engines.map(item => ({ value: item.id, label: item.label })),
        }),
      ),
    ),
    h('div', { style: S.row },
      h(Field, { label: t('音色') },
        h(Select, {
          value: form[provider]?.voice ?? voices[0] ?? '',
          onChange: value => set(`${provider}.voice`, value),
          options: voices.map(voice => ({ value: voice, label: voice })),
        }),
      ),
    ),
    provider === 'deepseek'
      ? h('div', { style: S.row },
        h('span', { style: S.label }, state.tts.deepseekConfigured ? t('使用本机 DeepSeek 账号，无需配置') : t('未检测到 DeepSeek 账号，请先在 DSH 里登录')),
      )
      : provider === 'mimo'
        ? h('div', { style: S.row },
          h('span', { style: S.label }, state.tts.mimoConfigured ? t('Key 已配置') : t('Key 未配置')),
          state.tts.mimoConfigured && !showKey
            ? h(Btn, { onClick: () => setShowKey(true) }, t('更换'))
            : h(Fragment, null,
              h(TextInput, { value: keyInput, onChange: setKeyInput, type: 'password', placeholder: t('粘贴 Open Platform API Key') }),
              h(Btn, { kind: 'primary', disabled: !keyInput.trim() || busy === 'key', onClick: saveKey }, t('保存')),
            ),
          state.tts.mimoConfigured ? h(Btn, { disabled: busy === 'key', onClick: clearKey }, t('删除')) : null,
        )
        : null,
    h('div', { style: S.grid2 },
      provider === 'edge'
        ? h(Fragment, null,
          h(Field, { label: t('语速'), hint: t('例如 -12%（负数更慢）') }, h(TextInput, { value: form.edge.rate, onChange: value => set('edge.rate', value) })),
          h(Field, { label: t('音高'), hint: t('例如 -3Hz') }, h(TextInput, { value: form.edge.pitch, onChange: value => set('edge.pitch', value) })),
          h(Field, { label: t('音量'), hint: t('通常保持 +0%') }, h(TextInput, { value: form.edge.volume, onChange: value => set('edge.volume', value) })),
          h(Field, { label: t('代理（可选）'), hint: t('国内网络必要时填 http://127.0.0.1:7890') }, h(TextInput, { value: form.edge.proxy, onChange: value => set('edge.proxy', value) })),
        )
        : provider === 'deepseek'
          ? h(Fragment, null,
            h(Field, { label: t('API 地址'), hint: t('一般不需要修改') }, h(TextInput, { value: form.deepseek.baseUrl, onChange: value => set('deepseek.baseUrl', value) })),
            h(Field, { label: t('代理（可选）'), hint: t('默认直连') }, h(TextInput, { value: form.deepseek.proxy, onChange: value => set('deepseek.proxy', value) })),
          )
          : h(Fragment, null,
            h(Field, { label: t('模型'), hint: t('默认 mimo-v2.5-tts') }, h(TextInput, { value: form.mimo.model, onChange: value => set('mimo.model', value) })),
            h(Field, { label: t('API 地址'), hint: t('一般不需要修改') }, h(TextInput, { value: form.mimo.baseUrl, onChange: value => set('mimo.baseUrl', value) })),
            h(Field, { label: t('代理（可选）'), hint: t('默认直连；系统代理会改写 MiMo 请求时再填') }, h(TextInput, { value: form.mimo.proxy, onChange: value => set('mimo.proxy', value) })),
          ),
    ),
    h('div', { style: { borderTop: `1px solid ${C.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 } },
      h('textarea', {
        value: previewText,
        onChange: event => setPreviewText(event.target.value),
        rows: 3,
        style: { ...S.input, resize: 'vertical' },
      }),
      h('div', { style: S.row },
        h(Btn, { kind: 'primary', disabled: busy === 'preview' || !previewText.trim(), onClick: test }, busy === 'preview' ? t('生成中…') : t('生成试听')),
        provider === 'deepseek' && !keyReady.deepseek ? h('span', { style: S.desc }, t('先登录 DSH 才能试听 DeepSeek')) : null,
        provider === 'mimo' && !keyReady.mimo ? h('span', { style: S.desc }, t('先保存 Key 才能试听 MiMo')) : null,
      ),
      preview ? h('div', { style: S.item },
        h('div', { style: S.itemHead }, h('span', null, preview.label), h('span', { style: S.mono }, `${preview.durationSec}s · ${preview.peakDb} dBFS`)),
        h('audio', { controls: true, autoPlay: true, src: preview.url, style: S.audio }),
      ) : null,
    ),
    h('div', { style: { borderTop: `1px solid ${C.border}`, paddingTop: 10, ...S.row, justifyContent: 'space-between' } },
      h('span', { style: S.desc }, t('当前默认：{0} · {1}', savedEngine?.label ?? savedProvider, savedVoice)),
      h(Btn, { disabled: busy === 'save', onClick: save }, t('保存为默认配置')),
    ),
  )
}

/**
 * Singing engine settings. Four controls only — engine status, install
 * progress, voicebank and device. There is deliberately no "synthesis mode"
 * switch: the tool sings one way (split at rests into phrases), and a toggle
 * that never changes the outcome is worse than no toggle.
 */
function SingingTab({ state, reload, notify }) {
  const [form, setForm] = useState(() => (state?.config?.singing ? JSON.parse(JSON.stringify(state.config.singing)) : null))
  const [status, setStatus] = useState(null)
  const [voices, setVoices] = useState([])
  const [job, setJob] = useState(null)
  const [gpuStatus, setGpuStatus] = useState(null)
  const [gpuJob, setGpuJob] = useState(null)
  const [busy, setBusy] = useState('')
  const [zipPath, setZipPath] = useState('')
  const voicebankSources = useVoicebankSources()

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api('/singing/status'))
    } catch (error) {
      setStatus({ ok: false, error: error.message })
    }
  }, [])
  const loadVoices = useCallback(async () => {
    try {
      const data = await api('/singing/voices')
      setVoices(data.voices ?? [])
    } catch {
      setVoices([])
    }
  }, [])
  const loadGpuStatus = useCallback(async () => {
    try {
      setGpuStatus(await api('/singing/gpu-status'))
    } catch (error) {
      setGpuStatus({ ok: false, error: error.message })
    }
  }, [])

  useEffect(() => { void loadStatus(); void loadVoices(); void loadGpuStatus() }, [loadStatus, loadVoices, loadGpuStatus])
  useEffect(() => {
    if (!form && state?.config?.singing) setForm(JSON.parse(JSON.stringify(state.config.singing)))
  }, [state, form])

  // Like the font installer, the job lives on the host: reopening settings must
  // pick up an install that is still running.
  useEffect(() => {
    let cancelled = false
    api('/jobs/active?kind=singing-install')
      .then((data) => { if (!cancelled && data.job) setJob(data.job) })
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
          notify(t('唱歌环境已安装'))
          await loadStatus()
          await loadVoices()
          await reload()
        }
        if (data.job.status === 'error') notify(jobFailure(data.job), 'error')
      } catch (error) {
        notify(error.message, 'error')
        setJob(null)
      }
    }, 700)
    return () => clearInterval(timer)
  }, [job, loadStatus, loadVoices, reload, notify])

  // The GPU install is its own host job: it survives closing this page, so the
  // running job has to be rediscovered when settings opens again.
  useEffect(() => {
    let cancelled = false
    api('/jobs/active?kind=singing-gpu-install')
      .then((data) => { if (!cancelled && data.job) setGpuJob(data.job) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!gpuJob || gpuJob.status !== 'running') return undefined
    const timer = setInterval(async () => {
      try {
        const data = await api(`/jobs?id=${encodeURIComponent(gpuJob.id)}`)
        setGpuJob(data.job)
        if (data.job.status === 'done') {
          notify(t('显卡组件已安装'))
          await loadGpuStatus()
        }
        if (data.job.status === 'error') notify(jobFailure(data.job), 'error')
      } catch (error) {
        notify(error.message, 'error')
        setGpuJob(null)
      }
    }, 700)
    return () => clearInterval(timer)
  }, [gpuJob, loadGpuStatus, notify])

  if (!form) return null

  async function save(patch) {
    setBusy('save')
    try {
      const singing = { ...form, ...patch }
      await api('/config', { method: 'POST', body: { patch: { singing } } })
      setForm(singing)
      notify(t('已保存为默认值（新任务生效，正在运行的任务不受影响）'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function install() {
    setBusy('install')
    try {
      const data = await api('/singing/install', { method: 'POST', body: {} })
      setJob(data.job)
      notify(data.reused ? t('已有一个下载任务在进行') : t('安装已开始，关掉设置页后仍会继续'))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  // Choosing the GPU is a commitment: the component is a ~216 MB download and
  // takes a while. Ask first, and say plainly that until it finishes every
  // request still runs on CPU and that closing this page will not stop it.
  async function chooseDevice(value) {
    if (value === 'cuda' && !gpuInstalled && !gpuInstalling) {
      const ok = window.confirm(t('选显卡需要先下载显卡组件（约 216 MB），耗时较久。下载期间仍按 CPU 运行；现在关闭设置页也会在后台继续。现在开始下载？'))
      if (!ok) return
      setBusy('gpu-install')
      try {
        const data = await api('/singing/gpu-install', { method: 'POST', body: {} })
        setGpuJob(data.job)
        notify(data.reused ? t('已有一个下载任务在进行') : t('显卡组件下载已开始，关掉设置页后仍会继续'))
      } catch (error) {
        notify(error.message, 'error')
      } finally {
        setBusy('')
      }
    }
    await save({ device: value })
  }

  // Install the same official zip the three links serve, from a local copy.
  // zipPath must be absolute: the browser's file input hides the full path, so
  // the person pastes it, exactly like the sound-pack install field.
  async function installZip() {
    const path = zipPath.trim()
    if (!path) return
    setBusy('zip')
    try {
      const result = await installVoicebankZip(path)
      notify(t('声库已安装，刷新后即可选用'))
      setZipPath('')
      await loadStatus()
      await loadVoices()
      await reload()
    } catch (error) {
      notify(t('声库 zip 安装失败：{0}', error.message), 'error')
    } finally {
      setBusy('')
    }
  }

  const installing = Boolean(job && job.status === 'running')
  const percent = job && job.total ? (job.received / job.total) * 100 : 0
  const ready = Boolean(status?.ready)
  // The environment install installs only the runtime now; the voicebank is a
  // separate step. The button state here must follow the runtime alone, or a
  // machine with a runtime but no voicebank still looks like "not installed".
  const runtimeInstalled = Boolean(status?.runtime?.installed)
  const parts = status?.ok
    ? [
      { label: t('运行环境'), ok: Boolean(status.runtime?.installed), detail: status.runtime?.version ? t('版本：{0}', status.runtime.version) : '' },
      { label: t('声库'), ok: Boolean(status.voicebank?.installed), detail: status.voicebank?.name ?? '' },
      { label: t('声码器'), ok: Boolean(status.vocoder?.installed), detail: '' },
    ]
    : []
  // The configured bank must remain selectable even before it is installed, so
  // the dropdown never silently jumps to a different value on first render.
  const voiceOptions = [...new Set([form.voicebank, ...voices.map((voice) => voice.name)].filter(Boolean))]
  const gpuInstalled = Boolean(gpuStatus?.ok && gpuStatus.installed)
  const gpuInstalling = Boolean(gpuJob && gpuJob.status === 'running')
  const gpuPercent = gpuJob && gpuJob.total ? (gpuJob.received / gpuJob.total) * 100 : 0
  const devices = [
    { value: 'auto', label: t('自动') },
    { value: 'cpu', label: 'CPU' },
    { value: 'cuda', label: t('显卡（CUDA）') },
  ]

  return h(Fragment, null,
    h(Card, { title: t('引擎状态'), desc: t('本地歌声合成需要先装好运行环境、声库和声码器。') },
      status?.ok
        ? h(Fragment, null,
          h('div', { style: S.row },
            ...parts.map((part) => h('span', { key: part.label, style: S.chip },
              `${part.label}：${part.ok ? t('已安装') : t('未安装')}${part.detail ? ` ${part.detail}` : ''}`,
            )),
          ),
          h('div', { style: S.desc }, ready ? t('唱歌环境已就绪') : t('唱歌环境尚未就绪')),
        )
        : h('p', { style: S.desc }, status?.error ? t('状态检测失败：{0}', status.error) : t('正在检测…')),
    ),
    h(Card, { title: t('第一步：安装唱歌环境'), desc: t('安装运行环境与依赖；声库请在下一步自行下载并安装。') },
      h('div', { style: S.row },
        h(Btn, {
          kind: 'primary',
          disabled: runtimeInstalled || installing || busy === 'install',
          onClick: install,
        }, runtimeInstalled ? t('运行环境已安装') : t('安装')),
      ),
      job ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('span', { style: S.label }, job.status === 'running'
            ? `${t('正在安装')}${job.total ? ` ${Math.round(percent)}%` : ''}${job.message ? ` · ${job.message}` : ''}`
            : job.status === 'done' ? t('完成：{0}', job.message || t('已安装')) : t('失败：{0}', jobFailure(job))),
          job.total ? h('span', { style: S.mono }, `${bytes(job.received)} / ${bytes(job.total)}`) : null,
        ),
        h('div', { style: S.bar }, h('div', { style: S.barFill(percent) })),
      ) : null,
    ),
    h(Card, { title: t('第二步：下载声库包'), desc: t('国外用 GitHub，国内用百度网盘或夸克网盘。三处都是同一个官方原包：下好后到第三步选本地文件安装。') },
      h(VoicebankDownloadLinks, { sources: voicebankSources }),
    ),
    h(Card, { title: t('第三步：安装声库包'), desc: t('填一个下载好的官方 .zip 文件的完整路径（绝对路径）。') },
      h('div', { style: S.row },
        h(TextInput, { value: zipPath, onChange: setZipPath, placeholder: t('粘贴声库 zip 的完整路径') }),
        h(Btn, {
          kind: 'primary',
          disabled: !zipPath.trim() || busy === 'zip' || installing,
          onClick: installZip,
        }, busy === 'zip' ? t('正在安装声库…') : t('安装 zip')),
      ),
    ),
    h(Card, { title: t('选声库'), desc: t('列出这台机器上已装的声库；工具调用里显式写的声库优先。') },
      h('div', { style: S.row },
        h(Field, { label: t('声库') },
          h(Select, {
            value: form.voicebank,
            onChange: value => void save({ voicebank: value }),
            options: voiceOptions.map(name => ({ value: name, label: name })),
          }),
        ),
      ),
    ),
    h(Card, { title: t('选设备'), desc: t('装好显卡组件后，「自动」和「显卡」都走显卡，只有「CPU」走 CPU；设备变更会重启唱歌进程。') },
      h('div', { style: S.row },
        h(Field, { label: t('推理设备') },
          h(Select, {
            value: form.device,
            onChange: value => void chooseDevice(value),
            options: devices,
          }),
        ),
      ),
      h('div', { style: S.row },
        h('span', { style: S.label }, t('显卡组件')),
        h('span', { style: S.chip }, gpuInstalling ? t('安装中') : gpuInstalled ? t('已安装') : t('未安装')),
        gpuStatus?.ok && gpuStatus.version ? h('span', { style: S.mono }, t('版本：{0}', gpuStatus.version)) : null,
      ),
      gpuInstalled
        ? h('div', { style: S.desc }, t('「自动」和「显卡」都走显卡，「CPU」仍走 CPU。'))
        : h('div', { style: S.desc }, t('未装显卡组件时，无论选什么，实际都按 CPU 运行。')),
      gpuInstalling
        ? h(Fragment, null,
          h('div', { style: S.desc }, t('显卡组件安装中，当前按 CPU 运行。')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: { ...S.row, justifyContent: 'space-between' } },
              h('span', { style: S.label }, `${t('正在安装')}${gpuJob.total ? ` ${Math.round(gpuPercent)}%` : ''}${gpuJob.message ? ` · ${gpuJob.message}` : ''}`),
              gpuJob.total ? h('span', { style: S.mono }, `${bytes(gpuJob.received)} / ${bytes(gpuJob.total)}`) : null,
            ),
            h('div', { style: S.bar }, h('div', { style: S.barFill(gpuPercent) })),
          ),
        )
        : null,
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
      await api('/config', { method: 'POST', body: { patch: { music: form.music, output: form.output } } })
      notify(t('已保存。显式参数仍然优先于这些默认值'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }
  return h(Card, { title: t('混音与输出'), desc: t('这些是工具没写参数时采用的默认值；工具调用里显式写的参数永远优先。') },
    h('div', { style: S.grid2 },
      h(Field, { label: t('音乐峰值 (dBFS)'), hint: t('渲染音乐时默认归一到的峰值') }, h(NumberInput, { value: form.music.peakDb, onChange: value => set('music.peakDb', value === '' ? null : value) })),
      h(Field, { label: t('音乐尾音 (秒)'), hint: t('最后一个音符结束后额外渲染的释放与混响') }, h(NumberInput, { value: form.music.tailSec, onChange: value => set('music.tailSec', Number(value) || 0) })),
      h(Field, { label: t('输出目录'), hint: t('留空 = 项目下 .anyaudio/out；也可以填绝对路径') }, h(TextInput, { value: form.output.dir, onChange: value => set('output.dir', value) })),
    ),
    h('div', { style: { ...S.row, justifyContent: 'flex-end' } }, h(Btn, { kind: 'primary', disabled: busy === 'save', onClick: save }, t('保存为默认值'))),
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
  const [job, setJob] = useState(null)
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

  // The install runs on the host: a folder without a manifest has to be measured
  // first, which takes a moment on a large pack. The page only watches it.
  useEffect(() => {
    if (!job || job.status !== 'running') return undefined
    const timer = setInterval(async () => {
      try {
        const data = await api(`/jobs?id=${encodeURIComponent(job.id)}`)
        setJob(data.job)
        if (data.job.status === 'done') {
          const result = data.job.result ?? {}
          notify(t('已安装 {0}（{1} 条）', result.id ?? '', result.count ?? ''))
          setInstallPath('')
          await load()
        }
        if (data.job.status === 'error') notify(jobFailure(data.job), 'error')
      } catch (caught) {
        notify(caught.message, 'error')
        setJob(null)
      }
    }, 500)
    return () => clearInterval(timer)
  }, [job, load, notify])

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
      const data = await api('/sfx/packs/install', { method: 'POST', body: { fromPath } })
      setJob(data.job)
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
    h(Card, {
      title: t('安装音效包'),
      desc: t('填一个音效包文件夹的路径。'),
      right: h(HelpTip, { text: t('文件夹里按 FOL（动效）/ AMB（环境音）/ DSN（设计音效）分三个子目录，音频文件直接放进去就行。\n\n三个子目录可以只有一部分。如果一个都没有，文件夹里的音频会全部当作动效。\n\n不需要准备任何清单文件，安装时会自动识别。') }),
    },
      h('div', { style: S.row },
        h(TextInput, { value: installPath, placeholder: t('把音效包文件夹的路径粘贴到这里'), onChange: setInstallPath }),
        h(Btn, { kind: 'primary', disabled: busy === 'install' || !installPath.trim() || job?.status === 'running', onClick: install }, t('安装')),
      ),
      job ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('span', { style: S.label }, job.status === 'running'
            ? (job.total ? t('正在识别 {0} / {1}', job.received, job.total) : t('正在识别…'))
            : job.status === 'done' ? t('完成：{0}', job.message || t('已安装')) : t('失败：{0}', jobFailure(job))),
          job.total ? h('span', { style: S.mono }, `${job.received} / ${job.total}`) : null,
        ),
        h('div', { style: S.bar }, h('div', { style: S.barFill(job.total ? (job.received / job.total) * 100 : 0) })),
      ) : null,
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
    { id: 'fxlib', label: t('音效'), render: () => h(FxLibTab, { state, reload, notify }) },
    { id: 'tts', label: t('配音'), render: () => h(TtsTab, { state, reload, notify }) },
    { id: 'singing', label: t('唱歌'), render: () => h(SingingTab, { state, reload, notify }) },
    { id: 'mix', label: t('混音'), render: () => h(MixTab, { state, reload, notify }) },
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
    h('div', { style: { ...S.header, alignItems: 'center' } },
      h('h2', { style: S.title }, 'AnyAudio'),
      h('span', { style: { flex: 1 } }),
      h(Select, {
        value: state.config.ui?.language ?? 'auto',
        onChange: value => void saveLanguage(value),
        title: t('界面语言'),
        style: { width: 'auto', minWidth: 110, fontSize: 12 },
        options: [
          { value: 'auto', label: t('跟随系统') },
          { value: 'zh', label: t('中文') },
          { value: 'en', label: 'English' },
        ],
      }),
      h(Btn, { onClick: reload }, t('刷新')),
    ),
    h('div', { style: { ...S.row, gap: 8 } },
      h(Btn, { onClick: () => window.open(GITHUB_URL, '_blank', 'noopener,noreferrer') }, 'GitHub'),
      h('span', { style: S.desc }, t('喜欢的话给个 Star ⭐')),
    ),
    h('div', { style: S.tabs }, tabs.map(item => h('button', { key: item.id, type: 'button', onClick: () => setTab(item.id), style: S.tab(item.id === tab) }, item.label))),
    active.render(),
    toast ? h('div', { style: { position: 'sticky', bottom: 8, zIndex: 5 } }, h(Notice, { tone: toast.tone === 'error' ? 'error' : 'info' }, toast.message)) : null,
  )
}

export { Page, FontsTab, FxLibTab, TtsTab, SingingTab }
