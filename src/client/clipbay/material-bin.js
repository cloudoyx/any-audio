/**
 * The material bin (improvement plan 03, I-40; spec §5.1 and §6.5).
 *
 * Every material in the project, with the two facts that decide what to do with
 * it: how loud it is (measured when it landed, I-37) and how many clips point at
 * it. Anything with zero references is an orphan — in one real project that was
 * 34 of 46 materials and 398 MB nobody could see.
 *
 * A material is audio on disk and is never edited; the only operation is delete,
 * and only when nothing uses it. spec §6.5 is explicit about that rule, which is
 * why the button is disabled rather than the request being refused after the
 * click.
 */
import { useEffect, useRef, useState } from 'react'
import { h, Btn, C, S } from '../ui.js'
import { t } from '../i18n.js'
import { API, api } from '../api.js'

const cell = { padding: '2px 6px', fontSize: 11 }
const tinyBtn = { padding: '1px 6px', fontSize: 10 }

function mediaUrl(root, projectId, materialId) {
  return `${API}/clipbay/media?root=${encodeURIComponent(root)}&project=${encodeURIComponent(projectId)}&id=${encodeURIComponent(materialId)}`
}

function dbLabel(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : t('未知')
}

/** How many clips point at a material, and the label the person will recognise. */
function references(project, materialId) {
  let count = 0
  let label = null
  for (const track of project?.tracks ?? []) {
    for (const item of track.items ?? []) {
      if (item.material !== materialId) continue
      count++
      if (!label) label = item.label || track.name
    }
  }
  return { count, label }
}

export function MaterialBin({ root, projectId, materials, project, onDeleted }) {
  const [open, setOpen] = useState(false)
  const [playing, setPlaying] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)
  const audioRef = useRef(null)

  // One <audio> element for the whole bin: two clicks must not produce two
  // overlapping previews, which is what one element per row would do.
  useEffect(() => () => {
    audioRef.current?.pause?.()
    audioRef.current = null
  }, [])

  const preview = (materialId) => {
    if (playing === materialId) {
      audioRef.current?.pause()
      setPlaying(null)
      return
    }
    audioRef.current?.pause()
    const audio = new Audio(mediaUrl(root, projectId, materialId))
    audio.addEventListener('ended', () => setPlaying(null))
    audio.play().then(() => setPlaying(materialId)).catch((caught) => {
      setError(`${t('这段素材没能播放')}：${caught.message}`)
      setPlaying(null)
    })
    audioRef.current = audio
  }

  const remove = async (materialId) => {
    setBusy(materialId)
    setError('')
    try {
      await api(`/clipbay/material?root=${encodeURIComponent(root)}&project=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        body: { id: materialId },
      })
      onDeleted?.()
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(null)
    }
  }

  const rows = (materials ?? []).map((material) => {
    const { count, label } = references(project, material.id)
    return { material, count, label }
  })
  const orphans = rows.filter((row) => row.count === 0)
  const totalBytes = (materials ?? []).reduce((sum, material) => sum + (Number(material.bytes) || 0), 0)

  return h('div', {
    style: { border: `1px solid ${C.border}`, borderRadius: 8, display: 'flex', flexDirection: 'column' },
  },
    h('div', {
      onClick: () => setOpen(!open),
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    },
      h('span', null, open ? '▾' : '▸'),
      h('span', null, t('素材箱')),
      h('span', { style: S.chip }, `${rows.length}`),
      orphans.length > 0
        ? h('span', { style: { ...S.chip, borderColor: C.warn, color: C.warn } }, `${orphans.length} ${t('条未被引用')}`)
        : null,
      h('span', { style: { flex: 1 } }),
      h('span', { style: { ...S.desc, fontWeight: 400 } }, totalBytes > 0 ? `${(totalBytes / 1048576).toFixed(1)} MB` : ''),
    ),
    open
      ? h('div', { style: { borderTop: `1px solid ${C.border}`, padding: '4px 8px 6px', display: 'flex', flexDirection: 'column', gap: 4 } },
        error ? h('p', { style: { ...S.desc, color: C.bad, margin: 0 } }, error) : null,
        rows.length === 0
          ? h('p', { style: { ...S.desc, margin: 0 } }, t('这个工程还没有素材。'))
          : h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 11 } },
            h('thead', null,
              h('tr', null,
                h('th', { style: { ...cell, textAlign: 'left', color: C.muted, fontWeight: 500 } }, t('素材')),
                h('th', { style: { ...cell, textAlign: 'left', color: C.muted, fontWeight: 500 } }, t('类型')),
                h('th', { style: { ...cell, textAlign: 'left', color: C.muted, fontWeight: 500 } }, t('时长')),
                h('th', { style: { ...cell, textAlign: 'left', color: C.muted, fontWeight: 500 } }, t('实测电平')),
                h('th', { style: { ...cell, textAlign: 'left', color: C.muted, fontWeight: 500 } }, t('被引用')),
                h('th', { style: { ...cell, textAlign: 'left', color: C.muted, fontWeight: 500 } }, t('操作')),
              ),
            ),
            h('tbody', null,
              rows.map(({ material, count, label }) => h('tr', { key: material.id },
                h('td', { style: { ...cell, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  material.source?.label || label || material.id,
                ),
                h('td', { style: { ...cell, color: C.muted } }, material.kind),
                h('td', { style: { ...cell, fontVariantNumeric: 'tabular-nums' } }, `${Number(material.durationSec || 0).toFixed(2)}s`),
                h('td', { style: { ...cell, fontVariantNumeric: 'tabular-nums', color: typeof material.rmsDb === 'number' ? C.good : C.muted } },
                  dbLabel(material.rmsDb),
                ),
                h('td', { style: { ...cell, color: count ? C.good : C.warn } },
                  count ? `${count} ${t('个片段')}` : t('未引用'),
                ),
                h('td', { style: { ...cell, whiteSpace: 'nowrap' } },
                  h(Btn, { onClick: () => preview(material.id), style: tinyBtn }, playing === material.id ? '⏸' : '▶'),
                  count === 0
                    ? h(Btn, {
                      onClick: () => remove(material.id),
                      disabled: busy === material.id,
                      style: { ...tinyBtn, marginLeft: 4, borderColor: C.bad, color: C.bad },
                      title: t('删除这个没有被引用的素材（不可撤销）'),
                    }, busy === material.id ? '…' : t('删除'))
                    : null,
                ),
              )),
            ),
          ),
        h('p', { style: { ...S.desc, margin: 0, fontSize: 10 } },
          t('点 ▶ 试听；被片段引用的素材不能删，先删掉那些片段。'),
        ),
      )
      : null,
  )
}
