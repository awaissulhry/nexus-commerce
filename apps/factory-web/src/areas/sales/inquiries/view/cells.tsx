'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FileText, Image as ImageIcon, Shirt } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import type { InquiryRow } from '../api'
import type { Phrase } from '../model'

/**
 * B-TH-216 (threads plan TH-1b, Sales › Incoming; features O-SAL-INQ-LIST.list-F01, -F02): the cells of an Incoming row the Orders
 * sheet's parts do not cover — the Picture cell (the small preview of the style a line names; else the kind of files with their
 * count, a door to them; else a neutral placeholder: never a broken image, never the original) and the picture large. The doors,
 * the funnel and the peek card are the Orders sheet's own parts (areas/sales/orders/list/sheet/parts.tsx), so both lists read
 * the same. Words: the `sales-inquiries` catalogue.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** A small preview's address, kept until shortly before it expires (the cell re-reads it after). */
const SMALL_CACHE = new Map<string, { url: string; until: number }>()

export type PictureLoader = (inquiryId: string) => Promise<{ url: string; expiresAt: string } | null>

/** The small preview of a row: undefined while read, null for the placeholder (none, no right, or not made yet). */
export function useRequestPicture(row: Pick<InquiryRow, 'id' | 'picture'>, load: PictureLoader | undefined, demo: string | undefined): string | null | undefined {
  const wanted = !!row.picture?.small && !!row.picture.fileId
  const cached = SMALL_CACHE.get(row.id)
  const [src, setSrc] = useState<string | null | undefined>(demo ?? (!wanted || !load ? null : cached && cached.until > Date.now() ? cached.url : undefined))
  useEffect(() => {
    if (demo !== undefined) return setSrc(demo)
    if (!wanted || !load) return setSrc(null)
    const known = SMALL_CACHE.get(row.id)
    if (known && known.until > Date.now()) return setSrc(known.url)
    let gone = false
    load(row.id)
      .then((answer) => {
        if (gone) return
        if (!answer) return setSrc(null)
        SMALL_CACHE.set(row.id, { url: answer.url, until: Date.parse(answer.expiresAt) - 5_000 })
        setSrc(answer.url)
      })
      .catch(() => !gone && setSrc(null))
    return () => {
      gone = true
    }
  }, [row.id, wanted, load, demo])
  return src
}

const styleOf = (row: Pick<InquiryRow, 'picture'>): string | null => (row.picture ? `${row.picture.styleCode} ${row.picture.styleName}` : null)

/**
 * The Picture cell: the style's small preview ("+2" when the request names more styles) that opens the picture large; a request
 * that names no style shows the kind of its files with their count, a link to them; else a placeholder.
 */
export function PictureCell({ row, src, filesHref, t, onOpen }: { row: InquiryRow; src: string | null | undefined; filesHref: string | null; t: Translate; onOpen: () => void }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  const style = styleOf(row)
  if (style) {
    const more = Math.max(0, (row.styleCount ?? 1) - 1)
    const name = t('picture.open', { number: row.number, style })
    return (
      <button type="button" className="fw-sheet-thumb" onClick={onOpen} aria-label={name} title={name}>
        {src && !broken ? <img src={src} alt={t('picture.alt', { style })} loading="lazy" onError={() => setBroken(true)} /> : <Shirt size={18} aria-hidden className={src === undefined ? 'fw-sheet-thumb-wait' : undefined} />}
        {more > 0 && <span className="fw-sheet-thumb-more">{t('picture.more', { count: more })}</span>}
      </button>
    )
  }
  const files = row.fileCounts
  if (files && filesHref && files.photos + files.documents > 0) {
    const photos = files.photos >= files.documents
    const count = photos ? files.photos : files.documents
    const words = t(photos ? 'files.photos' : 'files.documents', { count })
    return (
      <Link className="fw-sheet-thumb fw-inq-thumb-kind" href={filesHref} aria-label={`${t('door.files', { number: row.number })} — ${words}`} title={words} data-door="">
        {photos ? <ImageIcon size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
        <span className="fw-sheet-thumb-more">{count}</span>
      </Link>
    )
  }
  return (
    <span className="fw-sheet-thumb fw-inq-thumb-none" role="img" aria-label={t('picture.noneOf', { number: row.number })} title={t('picture.noneOf', { number: row.number })}>
      <Shirt size={18} aria-hidden />
    </span>
  )
}

/**
 * The picture large: the small preview (the list never loads the original) with the style's code and name, Open style (a real
 * link) and, for a request of several styles, the way to the request. Esc closes and returns to the cell.
 */
export function PictureViewer({ row, src, prefix, requestHref, t, onClose }: { row: InquiryRow; src: string | null | undefined; prefix: string; requestHref: string; t: Translate; onClose: () => void }) {
  const picture = row.picture
  const style = styleOf(row) ?? row.number
  const more = Math.max(0, (row.styleCount ?? 1) - 1)
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={style}
      subtitle={t('picture.viewerOf', { number: row.number })}
      footer={
        <>
          <Button onClick={onClose}>{t('picture.close')}</Button>
          {picture && (
            <Button variant="primary" asChild>
              <Link href={`${prefix}/products/styles/${encodeURIComponent(picture.styleId)}`}>{t('picture.openStyle')}</Link>
            </Button>
          )}
        </>
      }
    >
      <div className="fw-sheet-viewer">
        {src ? (
          <img src={src} alt={t('picture.alt', { style })} />
        ) : (
          <span className="fw-sheet-viewer-none">
            <Shirt size={40} aria-hidden />
            {t('picture.none')}
          </span>
        )}
      </div>
      <p className="fw-sheet-viewer-note">{t('picture.small')}</p>
      {more > 0 && (
        <p className="fw-sheet-viewer-note">
          <Link className="fw-sheet-door" href={requestHref}>
            {t('picture.moreStyles', { count: more })}
          </Link>
        </p>
      )}
    </Modal>
  )
}

/** Phrases said one after the other ("2 photos · 1 document"). */
export const joined = (phrases: readonly Phrase[], say: (phrase: Phrase) => string | null): string => phrases.map((phrase) => say(phrase) ?? '').filter(Boolean).join(' · ')
