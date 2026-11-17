'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Shirt } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import type { QuoteListRow } from '../../api'
// The Orders sheet's thumb and viewer styles (one look for every list's Picture), and Incoming's cached small-preview read.
import '../../../orders/list/sheet/sheet.css'
import { useRequestPicture, type PictureLoader } from '../../../inquiries/view/cells'

/**
 * TH-6 part B (B-TH-257 follow-up; O-SAL-QUO-LIST.grid-F01, as the Orders sheet's B-TH-017 and Incoming's B-TH-216): the quote row's
 * Picture — the small preview (~320 px, never the original) of the main picture of the current version's first line's style, "+2"
 * when the quote holds more styles, a button that opens the picture large; no file for this reader (no files.read, or no main
 * picture yet): the style's placeholder; no line yet: a neutral placeholder. Words: the `sales` catalogue (`list.picture.*`).
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export type { PictureLoader } from '../../../inquiries/view/cells'

/** The small preview of a quote row: undefined while read, null for the placeholder. */
export const useQuotePicture = (row: Pick<QuoteListRow, 'id' | 'picture'>, load: PictureLoader | undefined, demo: string | undefined): string | null | undefined => useRequestPicture({ id: row.id, picture: row.picture ?? null }, load, demo)

const styleOf = (row: Pick<QuoteListRow, 'picture'>): string | null => (row.picture ? `${row.picture.styleCode} ${row.picture.styleName}` : null)

export function QuotePictureCell({ row, load, demo, t, onOpen }: { row: QuoteListRow; load: PictureLoader | undefined; demo: string | undefined; t: Translate; onOpen: () => void }) {
  const src = useQuotePicture(row, load, demo)
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  const style = styleOf(row)
  if (!style) {
    return (
      <span className="fw-sheet-thumb" role="img" aria-label={t('list.picture.noneOf', { number: row.number })} title={t('list.picture.noneOf', { number: row.number })}>
        <Shirt size={18} aria-hidden />
      </span>
    )
  }
  const more = Math.max(0, (row.styleCount ?? 1) - 1)
  const name = t('list.picture.open', { number: row.number, style })
  return (
    <button type="button" className="fw-sheet-thumb" onClick={onOpen} aria-label={name} title={name}>
      {src && !broken ? <img src={src} alt={t('list.picture.alt', { style })} loading="lazy" onError={() => setBroken(true)} /> : <Shirt size={18} aria-hidden className={src === undefined ? 'fw-sheet-thumb-wait' : undefined} />}
      {more > 0 && <span className="fw-sheet-thumb-more">{t('list.picture.more', { count: more })}</span>}
    </button>
  )
}

/** The picture large: the small preview with the style's code and name, Open style (a real link), the quote for its other styles. */
export function QuotePictureViewer({ row, load, demo, prefix, quoteHref, t, onClose }: { row: QuoteListRow; load: PictureLoader | undefined; demo: string | undefined; prefix: string; quoteHref: string; t: Translate; onClose: () => void }) {
  const src = useQuotePicture(row, load, demo)
  const picture = row.picture ?? null
  const style = styleOf(row) ?? row.number
  const more = Math.max(0, (row.styleCount ?? 1) - 1)
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={style}
      subtitle={t('list.picture.viewerOf', { number: row.number })}
      footer={
        <>
          <Button onClick={onClose}>{t('list.picture.close')}</Button>
          {picture && (
            <Button variant="primary" asChild>
              <Link href={`${prefix}/products/styles/${encodeURIComponent(picture.styleId)}`}>{t('list.picture.openStyle')}</Link>
            </Button>
          )}
        </>
      }
    >
      <div className="fw-sheet-viewer">
        {src ? (
          <img src={src} alt={t('list.picture.alt', { style })} />
        ) : (
          <span className="fw-sheet-viewer-none">
            <Shirt size={40} aria-hidden />
            {t('list.picture.none')}
          </span>
        )}
      </div>
      <p className="fw-sheet-viewer-note">{t('list.picture.small')}</p>
      {more > 0 && (
        <p className="fw-sheet-viewer-note">
          <Link className="fw-sheet-door" href={quoteHref}>
            {t('list.picture.moreStyles', { count: more })}
          </Link>
        </p>
      )}
    </Modal>
  )
}
