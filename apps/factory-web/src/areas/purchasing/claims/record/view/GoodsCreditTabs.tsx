'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ExternalLink, Landmark } from 'lucide-react'
import { Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, money, quantity } from '../../../../_shared/buying/model'
import type { Claim, ClaimLine } from '../../api'
import type { ClaimRecordActions, ClaimRecordModel } from '../../model'

/** The stock move reasons a line's move may carry, in our words (factory-db StockMoveReason), else "other". */
const MOVE_REASONS = ['SUPPLIER_RETURN', 'ADJUSTMENT', 'SCRAP', 'COUNT', 'ISSUE', 'RETURN', 'TRANSFER', 'RECEIPT', 'OPENING'] as const
const moveReason = (reason: string) => ((MOVE_REASONS as readonly string[]).includes(reason) ? reason : 'OTHER')

/**
 * Goods returned (design rec "Supplier claim › Goods returned": return DDT, stock moves, carrier): each line that went
 * back with when, how much and from where, the DDT it travelled with (a replacement after a cancelled one is the live
 * one), and the claim's return DDTs (cancelled ones marked) each with its PDF in a new tab (the design's "Return DDT
 * (PDF)"). Empty: "Nothing returned — claim only".
 */
export function GoodsTab({ claim, model, actions }: { claim: Claim; model: ClaimRecordModel; actions?: ClaimRecordActions }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const gone = claim.lines.filter((line) => line.move !== null)
  const pdfHeld = model.can.files ? null : t('held.permissionPlain', { permission: 'files.read' })
  const columns = useMemo<ColDef<ClaimLine>[]>(() => {
    const DdtCell = ({ data }: ICellRendererParams<ClaimLine>) => {
      if (!data) return null
      const live = data.liveDdt ?? (data.ddt && !data.ddt.cancelled ? data.ddt : null)
      return (
        <span className="fw-by-cell">
          <span>{live ? live.number : data.ddt ? data.ddt.number : '—'}</span>
          {data.ddt?.cancelled && <span className="fw-by-cell-sub">{live ? t('goods.replaced', { number: data.ddt.number }) : t('goods.cancelled')}</span>}
        </span>
      )
    }
    const WhenCell = ({ data }: ICellRendererParams<ClaimLine>) => (data?.move ? <span>{formatDateTime(data.move.occurredAt, place)}</span> : null)
    const LotCell = ({ data }: ICellRendererParams<ClaimLine>) =>
      data ? (
        <span className="fw-by-cell">
          {data.lot ? (
            <Link className="fw-by-link" href={`${model.prefix}/warehouse/lots/${data.lot.id}`}>
              {data.lot.code}
            </Link>
          ) : (
            <span>{data.item.code}</span>
          )}
          <span className="fw-by-cell-sub">{data.hide ? (data.hide.state === 'RETURNED' ? t('goods.hideReturned', { code: data.hide.code }) : data.hide.code) : data.item.name}</span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<ClaimLine>) =>
      data?.move ? (
        <span className="fw-by-num">
          {quantity(data.move.quantity, locale, 4)} {t(`uom.${data.move.uom}`)}
        </span>
      ) : null
    const MoveCell = ({ data }: ICellRendererParams<ClaimLine>) =>
      data?.move ? (
        <span className="fw-by-cell">
          <span>{t(`moveReason.${moveReason(data.move.reason)}`)}</span>
          <span className="fw-by-cell-sub">{data.move.fromLocation ? t('goods.from', { place: data.move.fromLocation.code }) : ''}</span>
        </span>
      ) : null
    return [
      { colId: 'seq', headerName: t('lines.col.seq'), field: 'seq', minWidth: 58, maxWidth: 70, type: 'rightAligned' },
      { colId: 'ddt', headerName: t('goods.col.ddt'), minWidth: 130, flex: 0.9, cellRenderer: DdtCell },
      { colId: 'when', headerName: t('goods.col.when'), minWidth: 150, flex: 1, cellRenderer: WhenCell },
      { colId: 'lot', headerName: t('goods.col.lot'), minWidth: 150, flex: 1.1, cellRenderer: LotCell },
      { colId: 'quantity', headerName: t('goods.col.quantity'), minWidth: 120, flex: 0.8, cellRenderer: QuantityCell },
      { colId: 'move', headerName: t('goods.col.move'), minWidth: 160, flex: 1, cellRenderer: MoveCell },
    ]
  }, [t, locale, model.prefix, model.timeZone])

  if (gone.length === 0 && claim.ddts.length === 0) {
    return (
      <Card padded>
        <EmptyState title={claim.kind === 'RETURN' ? t('goods.noneYet.title') : t('goods.none.title')} description={claim.kind === 'RETURN' ? t('goods.noneYet.body') : t('goods.none.body')} />
      </Card>
    )
  }

  return (
    <div className="fw-by-stack">
      <Card padded>
        <div className="fw-by-card">
          <h2 className="fw-by-h2">{t('goods.ddts')}</h2>
          {claim.ddts.length === 0 ? (
            <p className="fw-by-hint">{t('goods.noDdt')}</p>
          ) : (
            <ul className="fw-by-list">
              {claim.ddts.map((ddt) => (
                <li key={ddt.id} className="fw-by-card-head">
                  <span className="fw-by-inline">
                    <b>{ddt.number}</b>
                    <span className="fw-by-hint">{[formatDate(dayAt(ddt.documentDate), place), t(`ddtReason.${ddt.reason === 'RETURN' ? 'RETURN' : 'OTHER'}`), t('goods.ddtLines', { count: ddt.lineIds.length })].join(' · ')}</span>
                    {ddt.cancelled && <Tag tone="danger">{t('goods.cancelled')}</Tag>}
                  </span>
                  <Button size="sm" heldReason={pdfHeld} onClick={() => actions?.onOpenDdt?.(ddt.id)} aria-label={t('goods.openPdfOf', { number: ddt.number })}>
                    <ExternalLink size={13} aria-hidden /> {t('goods.openPdf')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <ListFrame<ClaimLine> label={t('goods.label')} rows={gone} rowId={(line) => line.id} columns={columns} listKey={null} count={t('goods.count', { count: gone.length, total: claim.lines.length })} state={gone.length === 0 ? <p className="fw-by-hint">{t('goods.notYet')}</p> : undefined} />
    </div>
  )
}

/**
 * Credit (design rec "Supplier claim › Credit": the credit expected (cost grain) and the credit note received through
 * SDI, matched in Finance, and the difference). The match itself comes with the supplier invoice screens (B-W2a-62):
 * until then the panel says so and "Open in Finance" is held with that reason. A replacement expects no credit; a role
 * without the cost grain reads that the values need it (the fields are not drawn).
 */
export function CreditTab({ claim, model }: { claim: Claim; model: ClaimRecordModel }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  if (claim.remedy === 'REPLACEMENT') {
    return (
      <Card padded>
        <EmptyState title={t('credit.replacement.title')} description={t('credit.replacement.body')} />
      </Card>
    )
  }
  const financeHeld = t('credit.financeLater')
  return (
    <div className="fw-by-stack">
      <Card padded>
        <div className="fw-by-card">
          <div className="fw-by-card-head">
            <h2 className="fw-by-h2">{t('credit.title')}</h2>
            <Button size="sm" heldReason={financeHeld}>
              <Landmark size={13} aria-hidden /> {t('credit.openFinance')}
            </Button>
          </div>
          {model.can.cost ? (
            <KeyValue
              dense
              columns={3}
              labelCase="sentence"
              items={[
                { label: t('credit.expected'), value: claim.credit.expected != null ? money(claim.credit.expected, claim.credit.currency, locale) : t('credit.none'), hint: claim.status === 'ACCEPTED' ? t('credit.agreedHint') : t('credit.askedHint') },
                { label: t('credit.value'), value: claim.credit.value != null ? money(claim.credit.value, claim.credit.currency, locale) : '—', hint: t('credit.valueHint') },
                { label: t('credit.remedy'), value: claim.remedy ? t(`remedy.${claim.remedy}`) : t('remedy.none') },
              ]}
            />
          ) : (
            <p className="fw-by-hint">{t('credit.noCost')}</p>
          )}
          {/* The design's "NEW MatchPanel" (area-local stand-in until the supplier invoice screens): asked ⇄ matched. */}
          <div className="fw-cl-match" role="group" aria-label={t('credit.matchLabel')}>
            <div className="fw-cl-match-side">
              <span className="fw-cl-match-label">{t('credit.asked')}</span>
              <span className="fw-cl-match-value">{model.can.cost ? (claim.credit.expected != null ? money(claim.credit.expected, claim.credit.currency, locale) : t('credit.none')) : t('credit.hidden')}</span>
            </div>
            <div className="fw-cl-match-side">
              <span className="fw-cl-match-label">{t('credit.matched')}</span>
              <span className="fw-cl-match-value">{t('credit.notMatched')}</span>
            </div>
            <div className="fw-cl-match-side">
              <span className="fw-cl-match-label">{t('credit.difference')}</span>
              <span className="fw-cl-match-value">—</span>
            </div>
          </div>
          <p className="fw-by-hint">{t('credit.matchWhere')}</p>
        </div>
      </Card>
    </div>
  )
}
