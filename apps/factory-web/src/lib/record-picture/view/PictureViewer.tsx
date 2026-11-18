'use client'

import Link from 'next/link'
import { Shirt } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../i18n/ds-parts'
import { useT } from '../../i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { ReadPictures } from '../cache'
import { moreOf, styleWords, type PictureSource, type RowPicture } from '../model'
import { useRecordPicture } from '../use-record-picture'
import { RECORD_PICTURE_NS } from './RecordPicture'
import '../record-picture.css'

export interface PictureViewerProps {
  readonly source: PictureSource
  readonly recordId: string
  readonly number: string
  readonly picture?: RowPicture | null
  readonly styleCount?: number
  readonly read?: ReadPictures | null
  readonly demo?: string
  readonly held?: { readonly url: string; readonly expiresAt: string } | null
  /** The company's address prefix (`/w/<company>`): the style's link. */
  readonly prefix: string
  /** The record's own page ("Open SO-2026-0142": the photo is never a dead end on a board); none on the record's own page. */
  readonly recordHref?: string | null
  /** Where the record's other styles are ("+2 more styles: open its lines"); default the record's page. */
  readonly linesHref?: string | null
  readonly onClose: () => void
}

/**
 * F-SA-211 (12-lists-board §2.3) — the picture large: ONE design-system Modal (medium, centred) with the style's code and name, the
 * small preview (fit; the full picture is on the style — never the original here), the way to the record's other styles, and
 * Close · Open <record> · Open style (primary). Esc closes and gives the focus back to the part that opened it (the Modal's).
 */
export function PictureViewer(props: PictureViewerProps) {
  return (
    <WithMessages namespaces={[RECORD_PICTURE_NS]}>
      <Viewer {...props} />
    </WithMessages>
  )
}

function Viewer({ source, recordId, number, picture: own, styleCount: count, read, demo, held, prefix, recordHref, linesHref, onClose }: PictureViewerProps) {
  const t = useT(RECORD_PICTURE_NS)
  const { picture, styleCount, src } = useRecordPicture({ source, recordId, picture: own, styleCount: count, read, demo, held })
  const style = styleWords(picture)
  const more = moreOf(styleCount)
  const lines = linesHref ?? recordHref ?? null
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={style ?? number}
      subtitle={t('viewerOf', { number })}
      footer={
        <>
          <Button onClick={onClose}>{t('close')}</Button>
          {recordHref && (
            <Button asChild>
              <Link href={recordHref}>{t('openRecord', { number })}</Link>
            </Button>
          )}
          {picture && (
            <Button variant="primary" asChild>
              <Link href={`${prefix}/products/styles/${encodeURIComponent(picture.styleId)}`}>{t('openStyle')}</Link>
            </Button>
          )}
        </>
      }
    >
      <div className="fw-rp-viewer" aria-busy={src === undefined || undefined}>
        {src ? (
          <img src={src} alt={t('alt', { style: style ?? number })} />
        ) : (
          <span className="fw-rp-viewer-none">
            <Shirt size={40} aria-hidden />
            {t('none')}
          </span>
        )}
      </div>
      <p className="fw-rp-note">{t('small')}</p>
      {more > 0 && lines && (
        <p className="fw-rp-note">
          <Link className="fw-rp-door" href={lines}>
            {t('moreStyles', { count: more })}
          </Link>
        </p>
      )}
    </Modal>
  )
}
