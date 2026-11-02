'use client'

import { useEffect, useState } from 'react'
import { Scale } from 'lucide-react'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Pill, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import type { TrackedBundle } from '../api'
import { BUNDLES_NAMESPACE, nextWords, PLACE_TONE, placeWords, stuckWords } from '../model'

/** Small parts of the Bundles page and record. Views only: they fetch nothing. */

export type Words = (key: string, params?: Record<string, string | number>) => string

/** Where a bundle is: the word in its tone, the next operation under it, the stuck wait as a tag. */
export function PlaceCell({ row }: { row: Pick<TrackedBundle, 'place' | 'qualityReason' | 'operation' | 'next' | 'subcontract' | 'stuck'> }) {
  const t = useT(BUNDLES_NAMESPACE)
  const place = placeWords(row)
  const next = nextWords(row)
  const stuck = stuckWords(row)
  return (
    <span className="fw-pr-cell">
      <span className="fw-pr-inline">
        <Pill tone={PLACE_TONE[row.place]}>{t(place.key, place.params)}</Pill>
        {stuck && <Tag tone="danger">{t(stuck.key, stuck.params)}</Tag>}
      </span>
      {next && <span className="fw-pr-cell-sub">{t(next.key, next.params)}</span>}
    </span>
  )
}

/**
 * The law beside the panel (design "LegalBasisNote (new)": a DS part not built yet, composed here from the DS LawRef, as
 * Floor rules does): the design's sentence, in the page's language, with the Statuto's article in plain words.
 */
export function LegalBasisNote() {
  const t = useT(BUNDLES_NAMESPACE)
  const ds = useDsWords()
  return (
    <aside className="fw-bd-law" aria-label={t('patterns.lawLabel')}>
      <Scale size={16} aria-hidden />
      <p className="fw-pr-hint">{t('patterns.law')}</p>
      <LawRef law={t('patterns.lawName')} plain={t('patterns.lawPlain')} labels={ds.lawRef} />
    </aside>
  )
}

/**
 * The bare QR inside LabelPreview's square: drawn from the DS's own QR model (`QrCode/qrCodeModel`, loaded when a code is
 * drawn), an `<svg>` that fills its box. The DS gap "QrCode without its caption" the floor's ticket and the badge named.
 */
export function TicketQr({ value, label }: { value: string; label: string }) {
  const [drawing, setDrawing] = useState<{ path: string; box: number } | null>(null)
  useEffect(() => {
    let live = true
    import('@nexus/ui/components/QrCode/qrCodeModel')
      .then(({ qrMatrix, qrPath, qrBox }) => {
        if (!live) return
        const matrix = qrMatrix(value, 'M')
        setDrawing({ path: qrPath(matrix), box: qrBox(matrix) })
      })
      .catch(() => live && setDrawing(null))
    return () => {
      live = false
    }
  }, [value])
  if (!drawing) return <span className="fw-bd-qr" aria-hidden="true" />
  return (
    <svg className="fw-bd-qr" role="img" aria-label={label} viewBox={`0 0 ${drawing.box} ${drawing.box}`} shapeRendering="crispEdges">
      <path className="fw-bd-qr-dark" d={drawing.path} />
    </svg>
  )
}
