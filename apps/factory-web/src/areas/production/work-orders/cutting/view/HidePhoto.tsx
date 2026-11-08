'use client'

import { Camera } from 'lucide-react'
import { Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { CutEntry } from '../../../_shared/api'
import { quantityText } from '../../../_shared/model'
import '../hide-photo.css'

/** The photo the container read for the open entry: its address while it lives, or why it is not shown. */
export interface HidePhotoState {
  readonly entryId: string
  readonly url: string | null
  readonly problem: string | null
}

const NS = 'production-cutboard'

/**
 * SCR-071 wo-cutlog's W2b part (B-W2b-130; design "row → docked drawer (pieces, hide photo W2b)"): the photo of the hide taken at
 * the cutting table before the cut (B-W2b-103; a picture of the leather, never of a person: COL-017) and the thickness measured
 * there. An entry without a photo says so; the photo's address lives a minute and is read again on each open.
 */
export function HidePhoto({ entry, photo }: { entry: CutEntry & { photoFileId?: string | null; measuredThicknessMm?: string | null }; photo: HidePhotoState | null }) {
  return (
    <WithMessages namespaces={[NS]}>
      <Photo entry={entry} photo={photo} />
    </WithMessages>
  )
}

function Photo({ entry, photo }: { entry: CutEntry & { photoFileId?: string | null; measuredThicknessMm?: string | null }; photo: HidePhotoState | null }) {
  const t = useT(NS)
  const locale = useLocale()
  if (entry.reversalOfId) return null
  return (
    <section className="fw-hp" aria-label={t('photo.title')}>
      <h3 className="fw-pr-h3">{t('photo.title')}</h3>
      {entry.measuredThicknessMm && <span className="fw-pr-hint">{t('photo.thickness', { mm: quantityText(entry.measuredThicknessMm, locale) })}</span>}
      {!entry.photoFileId ? (
        <p className="fw-pr-hint">
          <Camera size={14} aria-hidden /> {t('photo.none')}
        </p>
      ) : !photo || (!photo.url && !photo.problem) ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('photo.loading')}
        </p>
      ) : photo.url ? (
        <figure className="fw-hp-figure">
          {/* A presigned address of the tenant's own store (next/image would proxy and cache it beyond its minute). */}
          <img className="fw-hp-img" src={photo.url} alt={t('photo.alt', { hide: entry.hideCode })} />
          <figcaption className="fw-pr-hint">{t('photo.caption', { hide: entry.hideCode, lot: entry.lotCode })}</figcaption>
        </figure>
      ) : (
        <p className="fw-pr-hint">{t(photo.problem === 'error.forbidden' ? 'photo.forbidden' : 'photo.failed')}</p>
      )}
    </section>
  )
}
