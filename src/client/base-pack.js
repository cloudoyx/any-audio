/**
 * The one pack the plugin recommends, described once.
 *
 * Both the settings page and the first-run guide show this card, and both must
 * say the same thing: a download that is described differently in two places is
 * how a person ends up with the wrong folder. The pack itself is not shipped —
 * it is a download, so the numbers here are the published ones, not a reading of
 * whatever happens to be installed on this machine.
 *
 * The official voicebank's download sources and local-zip installer live here
 * too, for the same reason: the settings page and the guide must show the same
 * three links. The server is authoritative (`GET /singing/sources`); the list
 * below is the first-frame / offline fallback and must stay byte-for-byte
 * identical to `VOICEBANK_SOURCES` in audio/singing-install.js. These are public
 * share links with the extraction code built in — no paths, no credentials.
 */
import { h, S, Btn, useState, useEffect } from './ui.js'
import { api } from './api.js'
import { t } from './i18n.js'

export const BASE_PACK = {
  id: 'BaseSFX',
  name: '基础音效包 BaseSFX',
  count: 237,
  size: '161 MB',
  license: 'CC0-1.0',
  summary: '环境、天气、门窗、脚步、碰撞、UI、转场',
  downloads: [
    // The share link carries its own extraction code (`?pwd=`), so the person
    // never has to copy one out of the page.
    { label: '百度网盘', url: 'https://pan.baidu.com/s/1GZcPaPQ7rWi62zASE-Cq_A?pwd=6666' },
    { label: '夸克网盘', url: 'https://pan.quark.cn/s/7d05bd130181' },
    { label: 'Google Drive', url: 'https://drive.google.com/file/d/1LCvttMGOrfWFS6da0oNAPhPz7bdcLgXu/view?usp=sharing' },
  ],
}

/**
 * The download row.
 *
 * `window.open` rather than an `<a target="_blank">`: the desktop shell hands a
 * window-open to the system browser, and a plain anchor inside a portalled
 * dialog did not reach it.
 */
export function DownloadLinks() {
  return h('div', { style: { ...S.row, gap: 8 } },
    BASE_PACK.downloads.map(item => h(Btn, {
      key: item.label,
      onClick: () => window.open(item.url, '_blank', 'noopener,noreferrer'),
    }, item.label)),
  )
}

// Official voicebank zip: GitHub abroad, Baidu / Quark in China. No Google
// Drive — the user ruled it out. Keep these URLs in sync with the backend.
export const VOICEBANK_SOURCES = [
  { id: 'github', label: 'GitHub', url: 'https://github.com/yqzhishen/qixuan-diffsinger/releases/download/v2.7.0/Qixuan_v2.7.0_DiffSinger_OpenUtau.zip' },
  { id: 'baidu', label: '百度网盘', url: 'https://pan.baidu.com/s/1WUuBy2QLmC52-uzqppr6Qg?pwd=6666' },
  { id: 'quark', label: '夸克网盘', url: 'https://pan.quark.cn/s/b7dbaf52c430' },
]

/** Read the source list from the host; fall back until (or unless) it answers. */
export function useVoicebankSources() {
  const [sources, setSources] = useState(VOICEBANK_SOURCES)
  useEffect(() => {
    let cancelled = false
    api('/singing/sources')
      .then((data) => {
        if (!cancelled && Array.isArray(data?.sources) && data.sources.length) setSources(data.sources)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  return sources
}

/**
 * The three voicebank download buttons, styled exactly like DownloadLinks above:
 * window.open, because a plain anchor inside a portalled dialog never reaches
 * the system browser. Labels go through t() so the two net-disk names read in
 * the interface language; GitHub stays as its own name.
 */
export function VoicebankDownloadLinks({ sources }) {
  const list = Array.isArray(sources) && sources.length ? sources : VOICEBANK_SOURCES
  return h('div', { style: { ...S.row, gap: 8 } },
    list.map(item => h(Btn, {
      key: item.id,
      onClick: () => window.open(item.url, '_blank', 'noopener,noreferrer'),
    }, t(item.label))),
  )
}

/** Install the downloaded official zip. `zipPath` must be an absolute path. */
export async function installVoicebankZip(zipPath) {
  return api('/singing/install-zip', { method: 'POST', body: { zipPath } })
}
