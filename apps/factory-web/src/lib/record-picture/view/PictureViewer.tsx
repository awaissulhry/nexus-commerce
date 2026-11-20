'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Shirt } from 'lucide-react'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../i18n/ds-parts'
import { useT } from '../../i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { ReadPictures } from '../cache'
import { moreOf, styleWords, type PictureSource, type RowPicture } from '../model'
import { useRecordPicture } from '../use-record-picture'
import { RECORD_PICTURE_NS, RecordPicture } from './RecordPicture'
import { tilePicture, tileWords, useRecordStyles, type ReadStyles, type StyleTile } from '../styles' // F-CP-110
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
  /** F-CP-110: the host's read of the record's lines — with "+N" the viewer shows every style in a strip; none: the lines door only. */
  readonly readStyles?: ReadStyles | null
  readonly onClose: () => void
}

/**
 * F-SA-211 (12-lists-board §2.3) — the picture large: ONE design-system Modal (medium, centred) with the style's code and name, the
 * small preview (fit; the full picture is on the style — never the original here), the way to the record's other styles, and
 * Close · Open <record> · Open style (primary). Esc closes and gives the focus back to the part that opened it (the Modal's).
 * F-CP-110 (customer page C2c): with "+N" and a host read, a strip "Styles of this order" — each line's picture with its style and
 * colour; a click shows it large and Open style follows it; reading: skeleton tiles; failed: words, Try again and the lines door.
 */
export function PictureViewer(props: PictureViewerProps) {
  return (
    <WithMessages namespaces={[RECORD_PICTURE_NS]}>
      <Viewer {...props} />
    </WithMessages>
  )
}

function Viewer({ source, recordId, number, picture: own, styleCount: count, read, demo, held, prefix, recordHref, linesHref, readStyles, onClose }: PictureViewerProps) {
  const t = useT(RECORD_PICTURE_NS)
  const { picture: first, styleCount, src: firstSrc } = useRecordPicture({ source, recordId, picture: own, styleCount: count, read, demo, held })
  const more = moreOf(styleCount)
  const lines = linesHref ?? recordHref ?? null
  // ---- F-CP-110: every style of the record (read once when it has "+N"); the tile picked is shown large and Open style follows it.
  const styles = useRecordStyles(readStyles, recordId, more > 0)
  const [shown, setShown] = useState<StyleTile | null>(null)
  const picture = shown ? tilePicture(shown) : first
  const src = shown ? (shown.small?.url ?? null) : firstSrc
  const style = styleWords(picture)
  // ---- end F-CP-110
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
      <div className="fw-rpic-viewer" aria-busy={src === undefined || undefined}>
        {src ? (
          <img src={src} alt={t('alt', { style: style ?? number })} />
        ) : (
          <span className="fw-rpic-viewer-none">
            <Shirt size={40} aria-hidden />
            {t('none')}
          </span>
        )}
      </div>
      <p className="fw-rpic-note">{t('small')}</p>
      {/* F-CP-110: the styles of this record, each its own picture (never a price). */}
      {styles.state.status !== 'off' && (
        <section className="fw-rpic-styles" aria-label={t('styles', { number })} aria-busy={styles.state.status === 'reading' || undefined}>
          <h3 className="fw-rpic-styles-h">{t('styles', { number })}</h3>
          {styles.state.status === 'reading' ? (
            <ul className="fw-rpic-strip">
              {Array.from({ length: Math.min(more + 1, 6) }, (_, index) => (
                <li key={index}>
                  <Skeleton width={40} height={40} />
                </li>
              ))}
            </ul>
          ) : styles.state.status === 'failed' ? (
            <p className="fw-rpic-note" role="status">
              {t('stylesFailed')}{' '}
              <Button size="sm" variant="quiet" onClick={styles.retry}>
                {t('retry')}
              </Button>
            </p>
          ) : (
            <ul className="fw-rpic-strip">
              {styles.state.tiles.map((tile) => (
                <li key={tile.key} className={shown?.key === tile.key ? 'fw-rpic-tile is-shown' : 'fw-rpic-tile'}>
                  <RecordPicture source={source} recordId={tile.key} number={number} picture={tilePicture(tile)} styleCount={1} size="line" read={null} held={tile.small} onOpen={() => setShown(tile)} />
                  <span className="fw-rpic-tile-words">{tileWords(tile)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {more > 0 && lines && (styles.state.status === 'off' || styles.state.status === 'failed') && (
        <p className="fw-rpic-note">
          <Link className="fw-rpic-door" href={lines}>
            {t('moreStyles', { count: more })}
          </Link>
        </p>
      )}
    </Modal>
  )
}
