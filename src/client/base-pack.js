/**
 * The one pack the plugin recommends, described once.
 *
 * Both the settings page and the first-run guide show this card, and both must
 * say the same thing: a download that is described differently in two places is
 * how a person ends up with the wrong folder. The pack itself is not shipped —
 * it is a download, so the numbers here are the published ones, not a reading of
 * whatever happens to be installed on this machine.
 */
export const BASE_PACK = {
  id: 'BaseSFX',
  name: '基础音效包 BaseSFX',
  count: 237,
  size: '89 MB',
  license: 'CC0-1.0',
  summary: '环境、天气、门窗、脚步、碰撞、UI、转场',
  downloads: [
    { label: '百度网盘', url: 'https://pan.baidu.com/s/1GZcPaPQ7rWi62zASE-Cq_A', note: '提取码 6666' },
    { label: 'Google Drive', url: 'https://drive.google.com/file/d/1LCvttMGOrfWFS6da0oNAPhPz7bdcLgXu/view?usp=sharing', note: '' },
  ],
}
