/**
 * The one pack the plugin recommends, described once.
 *
 * Both the settings page and the first-run guide show this card, and both must
 * say the same thing: a download that is described differently in two places is
 * how a person ends up with the wrong folder. The pack itself is not shipped —
 * it is a download, so the numbers here are the published ones, not a reading of
 * whatever happens to be installed on this machine.
 */
import { h, S, Btn } from './ui.js'

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
