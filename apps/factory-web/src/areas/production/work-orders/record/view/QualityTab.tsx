'use client'

import Link from 'next/link'
import { ArrowRight, Share2 } from 'lucide-react'
import { Card, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder } from '../../../_shared/api'
import type { Phrase } from '../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../record-model'
import { NotReleased, PartState } from './WorkOrderRecordView'
import { ScrapCard } from '../../daily/view/DailyParts'
// ---- F-PR-06: Quality is the one scrap home; Share with the customer held on a mixed work order ----
import { customerFactOf } from '../overview/model'
import { scrapPageHref, shareAddress, shareHeld } from '../quality/model'
// ---- end F-PR-06

const INSPECTION_TONE = { OPEN: 'info', PASSED: 'success', FAILED: 'danger', CANCELLED: 'neutral' } as const

/**
 * Quality (design wo-inspections; 06-tree A.4 Tab 5): the work order's one scrap home (F-PR-06: scrap, rework and holds per
 * operation and reason, and the door to Scrap & rework where scrapped garments are replaced — Labour & cost keeps one scrap value
 * line), the final inspections of the work order (state, lot size, garments released, an overridden result marked; its report
 * shared with the customer in the report window, held on a work order of several customers) and per size what was finished,
 * labelled and released for shipping. Inspecting and releasing are Quality's own screens (SCR-075, SCR-076) and the floor's
 * bench (SCR-097).
 */
export function QualityTab({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  if (workOrder.status === 'DRAFT') return <NotReleased what={t('quality.what')} />
  // B-W2a-46 (wo-scrap): scrap, rework and holds of the work order, beside the inspections. F-PR-06: the one scrap home, with the
  // door to Scrap & rework (Replace scrapped quantity) for those who read it.
  const scrap = model.daily ? (
    <div className="fw-pr-stack">
      <ScrapCard prefix={model.prefix} daily={model.daily} actions={actions?.daily} />
      {model.daily.can.scrapView && (
        <Link className="fw-pr-link" href={scrapPageHref(model.prefix, workOrder.number)}>
          {t('quality.scrapPage')} <ArrowRight size={12} aria-hidden />
        </Link>
      )}
    </div>
  ) : null
  const fact = customerFactOf(workOrder)
  if (model.quality === null)
    return (
      <div className="fw-pr-stack">
        <p className="fw-pr-hint">{t('quality.noRight')}</p>
        {scrap}
      </div>
    )
  const final = model.quality.value
  if (!final) return <PartState label={t('tab.quality')} problem={model.quality.problem} onRetry={() => actions?.onRetryPart?.('quality')} />
  return (
    <div className="fw-pr-stack">
    {scrap}
    <div className="fw-pr-cards">
      <Card padded className="fw-pr-card">
        <h2 className="fw-pr-h2">{t('quality.inspections')}</h2>
        {final.inspections.length === 0 ? (
          <p className="fw-pr-hint">{t('quality.none')}</p>
        ) : (
          <SummaryTable
            label={t('quality.inspections')}
            stackOnPhone
            columns={[t('quality.col.inspection'), t('quality.col.status'), t('quality.col.lot'), t('quality.col.released'), t('quality.col.decided'), t('quality.col.report')]}
            align={[undefined, undefined, 'right', 'right', 'right', 'left']}
            density="roomy"
            rows={final.inspections.map((inspection) => ({
              id: inspection.id,
              cells: [
                <span key="i" className="fw-pr-inline">
                  {inspection.inspectionNumber ?? t('quality.number', { n: final.inspections.indexOf(inspection) + 1 })}
                  {inspection.overridden && <Tag tone="warning">{t('quality.overridden')}</Tag>}
                </span>,
                <Pill key="s" tone={INSPECTION_TONE[inspection.status]}>
                  {t(`quality.status.${inspection.status}`)}
                </Pill>,
                String(inspection.lotSize),
                String(inspection.released),
                inspection.decidedAt ? formatDateTime(inspection.decidedAt, { locale }) : '—',
                <ShareButton key="r" held={shareHeld(fact, inspection, !!model.shareReports)} href={shareAddress(model.prefix, inspection.id)} />,
              ],
            }))}
          />
        )}
      </Card>
      <Card padded className="fw-pr-card">
        <h2 className="fw-pr-h2">{t('quality.sizes')}</h2>
        <SummaryTable
          label={t('quality.sizes')}
          stackOnPhone
          columns={[t('quality.col.size'), t('quality.col.pieces'), t('quality.col.labels'), t('quality.col.released'), t('quality.col.releasable')]}
          align={[undefined, 'right', 'right', 'right', 'right']}
          rows={final.cells.map((cell) => ({
            id: cell.workOrderSizeId,
            cells: [`${cell.colourwayCode} ${cell.size}`, String(cell.pieces), String(cell.labelsPrinted), String(cell.released), String(cell.releasable)],
          }))}
        />
        <p className="fw-pr-hint">{t('quality.hint')}</p>
      </Card>
    </div>
    </div>
  )
}

/** F-PR-06: Share with the customer… opens the inspection's report window on its share part; held in words (the wall first). */
function ShareButton({ held, href }: { held: Phrase | null; href: string }) {
  const t = useT('production')
  if (held) {
    return (
      <Button size="sm" heldReason={t(held.key, held.params)}>
        <Share2 size={13} aria-hidden /> {t('quality.share.open')}
      </Button>
    )
  }
  return (
    <Button size="sm" asChild>
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Share2 size={13} aria-hidden /> {t('quality.share.open')}
      </a>
    </Button>
  )
}
