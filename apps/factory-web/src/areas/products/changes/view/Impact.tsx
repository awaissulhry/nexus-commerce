'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Banner, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import type { OrderView, RequestView, StyleDriftView } from '../api'
import { WIP_DISPOSITIONS, workOrderHref, type Phrase, type WipDisposition, type WipLine } from '../model'
import { useWords } from '../parts'

export interface DriftPart {
  value: StyleDriftView | null
  problem: string | null
}

/** "2 bundles cut (14 pieces), 1 worked (6 pieces)" (MES-006): what of a work order is already made. */
export function MadeText({ made }: { made: { cut: { bundles: number; pieces: number }; worked: { bundles: number; pieces: number } } }) {
  const { t } = useWords()
  if (made.cut.bundles === 0 && made.worked.bundles === 0) return <span className="fw-chg-hint">{t('impact.nothingMade')}</span>
  return <span>{t('impact.made', { cut: made.cut.bundles, cutPieces: made.cut.pieces, worked: made.worked.bundles, workedPieces: made.worked.pieces })}</span>
}

/** One drift row of B-W2b-220's read. */
export type DriftRow = StyleDriftView['rows'][number]

/**
 * The open quotes and orders whose lines are on another revision than the one in force (B-W2b-220's drift). B-W2b-245 (the
 * style's Versions & changes, "Orders on older revisions"): `hrefOf` opens each record, `extra` adds one column (the cost
 * difference, drawn by the caller with its grain).
 */
export function DriftTable({ drift, onRetry, hrefOf, extra }: { drift: DriftPart | null; onRetry?: () => void; hrefOf?: (row: DriftRow) => string | null; extra?: { label: string; cell: (row: DriftRow) => ReactNode } }) {
  const { t } = useWords()
  if (!drift) return null
  if (drift.problem)
    return (
      <Banner
        tone="warning"
        title={t('impact.driftFailed')}
        action={
          onRetry ? (
            <Button size="sm" variant="quiet" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          ) : undefined
        }
      >
        {t(drift.problem)}
      </Banner>
    )
  if (!drift.value)
    return (
      <p className="fw-chg-hint" role="status">
        <Spinner size={14} /> {t('common.loading')}
      </p>
    )
  const rows = drift.value.rows
  return (
    <div className="fw-chg-stack">
      {rows.length === 0 ? (
        <p className="fw-chg-hint">{t('impact.noDrift')}</p>
      ) : (
        <SummaryTable
          label={t('impact.drift')}
          columns={[t('impact.col.record'), t('impact.col.line'), t('impact.col.pieces'), t('impact.col.revision'), t('impact.col.differs'), ...(extra ? [extra.label] : [])]}
          align={['left', 'left', 'right', 'left', 'left', ...(extra ? (['right'] as const) : [])]}
          widths={['24%', '16%', '10%', '18%', undefined, ...(extra ? ['16%'] : [])]}
          stackOnPhone
          rows={rows.map((row) => {
            const record = `${t(`document.${row.kind}`)} ${row.number}`
            const href = hrefOf?.(row) ?? null
            return {
              id: `${row.documentId}-${row.lineId}`,
              cells: [
                href ? (
                  <Link className="fw-chg-link fw-chg-code" href={href}>
                    {record}
                  </Link>
                ) : (
                  record
                ),
                [String(row.seq), row.colourway].filter(Boolean).join(' · '),
                String(row.pieces),
                row.revision && row.against ? t('impact.revisionMove', { from: row.revision.revision, to: row.against.revision }) : '—',
                row.differs.length === 0 ? t('impact.same') : row.differs.map((entry) => t(`section.${entry.section}`)).join(', '),
                ...(extra ? [extra.cell(row)] : []),
              ],
            }
          })}
        />
      )}
      {drift.value.held.length > 0 && <p className="fw-chg-hint">{t('impact.held', { kinds: drift.value.held.map((kind) => t(`document.${kind}`)).join(', ') })}</p>}
    </div>
  )
}

/**
 * A change order's impact (design change.impact; MES-006): each open work order of the style with what is already made and
 * what happens to its work in progress (finish on the old spec, rework, scrap, hold — chosen while the change order is a
 * draft and saved as one list), then the open quotes and orders on older revisions. Without workorders.view the work
 * orders are said to be out of the role, never drawn as none.
 */
export function OrderImpact({
  order,
  lines,
  wipHeld,
  drift,
  prefix,
  canWorkOrders,
  onDisposition,
  onDriftRetry,
}: {
  order: OrderView
  /** The work-in-progress lines as drafted (null: read-only, as the order says). */
  lines: readonly WipLine[] | null
  wipHeld: Phrase | null
  drift: DriftPart | null
  prefix: string
  canWorkOrders: boolean
  onDisposition?: (workOrderId: string, disposition: WipDisposition | '') => void
  onDriftRetry?: () => void
}) {
  const { t, say } = useWords()
  const madeOf = new Map(order.workInProgress.map((line) => [line.workOrder.id, line.made]))
  const shown = lines ?? order.workInProgress.map((line) => ({ workOrderId: line.workOrder.id, number: line.workOrder.number, disposition: line.disposition as WipDisposition | '' }))
  const held = say(wipHeld)
  return (
    <div className="fw-chg-stack">
      <h3 className="fw-chg-h3">{t('impact.workOrders')}</h3>
      {order.openWorkOrders === null && <p className="fw-chg-hint">{t('impact.noWorkOrderRight')}</p>}
      {shown.length === 0 ? (
        order.openWorkOrders !== null && <p className="fw-chg-hint">{t('impact.noWorkOrders')}</p>
      ) : (
        <ul className="fw-chg-picks" aria-label={t('impact.workOrders')}>
          {shown.map((line) => {
            const made = madeOf.get(line.workOrderId)
            return (
              <li key={line.workOrderId} className="fw-chg-pick">
                <span className="fw-chg-cell">
                  {canWorkOrders ? (
                    <Link className="fw-chg-link fw-chg-code" href={workOrderHref(prefix, line.workOrderId)}>
                      {line.number}
                    </Link>
                  ) : (
                    <span className="fw-chg-code">{line.number}</span>
                  )}
                  {made ? <MadeText made={made} /> : <span className="fw-chg-hint">{t('impact.notAssessed')}</span>}
                </span>
                {lines && !held ? (
                  <Select size="sm" aria-label={t('impact.dispositionOf', { number: line.number })} value={line.disposition} onChange={(event) => onDisposition?.(line.workOrderId, event.target.value as WipDisposition | '')}>
                    <option value="">{t('disposition.none')}</option>
                    {WIP_DISPOSITIONS.map((disposition) => (
                      <option key={disposition} value={disposition}>
                        {t(`disposition.${disposition}`)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span>{line.disposition ? t(`disposition.${line.disposition}`) : t('disposition.none')}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {held && lines !== null && <p className="fw-chg-hint">{held}</p>}
      <h3 className="fw-chg-h3">{t('impact.drift')}</h3>
      <DriftTable drift={drift} onRetry={onDriftRetry} />
    </div>
  )
}

/** A change request's impact: the work order where it was seen and what of it is already made (MES-006). */
export function RequestImpact({ request, prefix, canWorkOrders }: { request: RequestView; prefix: string; canWorkOrders: boolean }) {
  const { t } = useWords()
  if (!request.workOrder) return <p className="fw-chg-hint">{t('impact.requestNone')}</p>
  return (
    <KeyValue
      columns={2}
      labelCase="sentence"
      items={[
        {
          label: t('impact.workOrder'),
          value: canWorkOrders ? (
            <Link className="fw-chg-link fw-chg-code" href={workOrderHref(prefix, request.workOrder.id)}>
              {request.workOrder.number}
            </Link>
          ) : (
            request.workOrder.number
          ),
        },
        { label: t('impact.alreadyMade'), value: request.made ? <MadeText made={request.made} /> : t('impact.noWorkOrderRight') },
      ]}
    />
  )
}
