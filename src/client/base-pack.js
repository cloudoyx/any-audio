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
import { t } from './i18n.js'

export const BASE_PACK = {
  id: 'BaseSFX',
  name: '基础音效包 BaseSFX',
  count: 237,
  size: '161 MB',
  license: 'CC0-1.0',
  summary: '环境、天气、门窗、脚步、碰撞、UI、转场',
  downloads: [
    { label: '百度网盘', url: 'https://pan.baidu.com/s/1GZcPaPQ7rWi62zASE-Cq_A', code: '6666' },
    { label: 'Google Drive', url: 'https://drive.google.com/file/d/1LCvttMGOrfWFS6da0oNAPhPz7bdcLgXu/view?usp=sharing', code: '' },
  ],
}

/**
 * The download row.
 *
 * `window.open` rather than an `<a target="_blank">`: the desktop shell hands a
 * window-open to the system browser, and a plain anchor inside a portalled
 * dialog did not reach it. The extraction code sits beside the link instead of
 * inside its label, where it read as part of the name.
 */
export function DownloadLinks() {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    BASE_PACK.downloads.map(item => h('div', { key: item.label, style: { ...S.row, gap: 8 } },
      h(Btn, { onClick: () => window.open(item.url, '_blank', 'noopener,noreferrer') }, item.label),
      item.code ? h('span', { style: S.desc }, t('提取码 {0}', item.code)) : null,
    )),
  )
}
