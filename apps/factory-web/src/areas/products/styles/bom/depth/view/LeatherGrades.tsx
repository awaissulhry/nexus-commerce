'use client'

import Link from 'next/link'
import { SummaryTable } from '@nexus/ui/components'
import { Spinner, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { PiecesModel } from '../../../record/pieces/pieces-model'
import { leatherPieces } from '../model'
import '../bom-depth.css'

/**
 * The leather section's "Grade mix and minimum grade per pattern piece" (B-W2b-241 on B-W2b-95's pattern pieces and
 * B-W2b-80's leather grades; design style.bom.leather): for one leather line, the pattern pieces cut from it with the
 * lowest grade each may be cut from, and the grade mix — per minimum grade, best first, how many pieces of a garment need
 * that grade or better and their share. Cutting refuses a hide below a piece's minimum; the pieces are changed in Files &
 * patterns › Pattern pieces (the link).
 */
export function LeatherGrades({ pieces, lineId, filesHref, locale }: { pieces?: PiecesModel; lineId: string; filesHref: string; locale: 'it' | 'en' }) {
  return (
    <WithMessages namespaces={['products-bom-depth']}>
      <Grades pieces={pieces} lineId={lineId} filesHref={filesHref} locale={locale} />
    </WithMessages>
  )
}

function Grades({ pieces, lineId, filesHref, locale }: { pieces?: PiecesModel; lineId: string; filesHref: string; locale: 'it' | 'en' }) {
  const t = useT('products-bom-depth')
  const part = pieces?.part
  if (!part || part.status === 'idle') return null
  if (part.status === 'loading')
    return (
      <p className="fw-bmd-hint" role="status">
        <Spinner size={14} /> {t('grades.loading')}
      </p>
    )
  if (part.status === 'error') return <p className="fw-bmd-hint">{t('grades.failed')}</p>
  const read = leatherPieces(part.value, lineId, locale)
  const link = (
    <Link className="fw-bmd-link" href={filesHref}>
      {t('grades.edit')}
    </Link>
  )
  if (read.pieces.length === 0)
    return (
      <p className="fw-bmd-hint">
        {t('grades.none')} {link}
      </p>
    )
  return (
    <div className="fw-bmd-stack">
      <p className="fw-bmd-label">
        <b>{t('grades.mix')}</b>
      </p>
      <ul className="fw-bmd-mix" aria-label={t('grades.mix')}>
        {read.mix.map((row) => (
          <li key={row.grade?.id ?? 'any'}>
            <Tag tone={row.grade ? 'info' : 'neutral'}>{row.grade ? t('grades.orBetter', { grade: row.grade.label }) : t('grades.any')}</Tag>{' '}
            <span className="fw-bmd-num">{t('grades.share', { count: row.pieces, total: read.total, pct: row.pct })}</span>
          </li>
        ))}
      </ul>
      <SummaryTable
        label={t('grades.table')}
        density="compact"
        stackOnPhone
        columns={[t('grades.col.piece'), t('grades.col.qty'), t('grades.col.min'), t('grades.col.sizes')]}
        align={[undefined, 'right', undefined, undefined]}
        rows={read.pieces.map((piece) => ({
          id: piece.id,
          cells: [piece.name, String(piece.quantity), piece.minGrade ? t('grades.orBetter', { grade: piece.minGrade.label }) : t('grades.any'), piece.sizes.length === 0 ? t('grades.everySize') : piece.sizes.join(', ')],
        }))}
      />
      <p className="fw-bmd-hint">
        {t('grades.rule')} {link}
      </p>
    </div>
  )
}
