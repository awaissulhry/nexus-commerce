'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FileText, Image as ImageIcon, Shirt } from 'lucide-react'
import { useT } from '../../i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { ReadPictures } from '../cache'
import { faceOf, fallbackOf, moreOf, styleWords, type PictureSize, type PictureSource, type RowPicture } from '../model'
import { useRecordPicture } from '../use-record-picture'
import '../record-picture.css'

/** The part's own words (messages/<locale>/record-picture.json). */
export const RECORD_PICTURE_NS = 'record-picture'

export interface RecordPictureProps {
  readonly source: PictureSource
  readonly recordId: string
  /** The record's number in words ("SO-2026-0142"): the part's name says it. */
  readonly number: string
  /** The row's own picture field; undefined: the row names none (the batch read names it); null: no style yet. */
  readonly picture?: RowPicture | null
  /** The record's distinct styles ("+N" = styleCount − 1). */
  readonly styleCount?: number
  readonly size: PictureSize
  /** Incoming: a request that names no style shows the kind of its files with their count, a door to them. */
  readonly fallback?: { readonly photos: number; readonly documents: number; readonly href: string } | null
  /** The page's batch read; none: nothing is read (the placeholder). */
  readonly read?: ReadPictures | null
  /** Design fixtures: the address to draw. */
  readonly demo?: string
  /** A caller that already holds the small address (the order read's lines). */
  readonly held?: { readonly url: string; readonly expiresAt: string } | null
  /** Opens the picture large (the viewer); none: the picture is shown, not a button. */
  readonly onOpen?: () => void
}

/**
 * F-SA-211 (sales page plan N8, picks P13, P18, R9; 12-lists-board §2.3) — a record's style picture, the ONE part every list,
 * board and record page mounts: the style's main picture as its ~320 px small preview (never the original), "+N" when the record
 * has more styles; Incoming without a style: the kind of its files with their count (a link to them); else a shirt placeholder.
 * A picture is a real button that opens it large; a placeholder is an image with words (`role="img"`), never a disabled button.
 * A cell crops; a card, a phone card and a line fit (a garment photo is portrait). Layout only, design-system tokens.
 */
export function RecordPicture(props: RecordPictureProps) {
  return (
    <WithMessages namespaces={[RECORD_PICTURE_NS]}>
      <Picture {...props} />
    </WithMessages>
  )
}

function Picture({ source, recordId, number, picture: own, styleCount: count, size, fallback, read, demo, held, onOpen }: RecordPictureProps) {
  const t = useT(RECORD_PICTURE_NS)
  const { picture, styleCount, src } = useRecordPicture({ source, recordId, picture: own, styleCount: count, read, demo, held })
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  const className = `fw-rp fw-rp-${size === 'lineLarge' ? 'line-large' : size}`
  const face = faceOf(picture, fallback)

  if (face === 'picture' && picture) {
    const style = styleWords(picture) ?? number
    const more = moreOf(styleCount)
    const name = `${t('open', { number })} · ${style}`
    const body = (
      <>
        {src && !broken ? <img src={src} alt={t('alt', { style })} loading="lazy" onError={() => setBroken(true)} /> : <Shirt size={size === 'cell' ? 18 : 24} aria-hidden className={src === undefined ? 'fw-rp-wait' : undefined} />}
        {more > 0 && <span className="fw-rp-more">{t('more', { count: more })}</span>}
      </>
    )
    // F-OO-121 (order overview §2.2): a file that does not answer says so in its title ("The picture file is missing"), on every page.
    const missing = broken ? t('broken') : undefined
    return onOpen ? (
      <button type="button" className={className} onClick={onOpen} aria-label={name} title={missing ?? name} aria-busy={src === undefined || undefined} data-picture="">
        {body}
      </button>
    ) : (
      <span className={className} role="img" aria-label={style} title={missing} aria-busy={src === undefined || undefined}>
        {body}
      </span>
    )
  }

  if (face === 'files' && fallback) {
    const kind = fallbackOf(fallback)!
    const words = t(`files.${kind.kind}`, { count: kind.count })
    return (
      <Link className={`${className} fw-rp-files`} href={fallback.href} aria-label={`${t('files.door')} · ${number} — ${words}`} title={words} data-door="">
        {kind.kind === 'photos' ? <ImageIcon size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
        <span className="fw-rp-more">{kind.count}</span>
      </Link>
    )
  }

  if (face === 'reading') {
    return (
      <span className={`${className} fw-rp-none`} role="img" aria-label={t('reading', { number })} aria-busy>
        <Shirt size={size === 'cell' ? 18 : 24} aria-hidden className="fw-rp-wait" />
      </span>
    )
  }

  return (
    <span className={`${className} fw-rp-none`} role="img" aria-label={t('noneOf', { number })} title={t('noneOf', { number })}>
      <Shirt size={size === 'cell' ? 18 : 24} aria-hidden />
    </span>
  )
}
