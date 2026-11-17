'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { CutLog, WorkOrder } from '../../../_shared/api'
import type { Replacement } from '../../../cutting/api'
import { areaNumber, CUTTING_NAMESPACE, lotYields, percent, recutEntries, recutHeld, unitWord, type LotHide } from '../../../cutting/model'
import { againstPlan, areaBalance, feedbackHeld, ORDER_TONE, orderHref, ORDERS_NAMESPACE, planPhrase, underPlan } from '../../../cutting/orders/model'
import { say } from '../../../cutting/view/CutDialogs'
import { leatherMaterials } from '../../daily/model'
import type { CutOrderOfWorkOrder } from '../model'
import type { CutPartsActions, CutPartsModel } from '../use-cut-parts'

/**
 * F-PR-06 — what only the Cut record drew, now on the work order's Cutting & bundles tab (O-CUT-rec: the same fact once): the
 * recuts asked for scrapped pieces with Mark cut (by a live cut log entry of its cell), the cut orders this work order is in (its
 * fabric lays; "shared with another work order", named only as the API named it for this reader), and the yield per lot and
 * supplier with Raise with the supplier and the leather's issued against used against returned. The Cut record's words (the
 * `cutting` and `cutting-orders` catalogues). Never who cut.
 */

// ---- recuts (the Cut record's Pieces tab) ---------------------------------------------------------------------------------------

export function RecutsCard({ log, cut, actions }: { log: CutLog | null; cut: CutPartsModel; actions?: CutPartsActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const locale = useLocale()
  const part = cut.recuts
  if (!part) return null
  const recuts = part.value ?? []
  return (
    <Card padded className="fw-pr-card">
      <h2 className="fw-pr-h2">{t('recuts.title')}</h2>
      {part.problem ? (
        <EmptyState
          title={t('part.failed', { part: t('recuts.title') })}
          description={t(part.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('recuts')}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !part.value ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('part.loading', { part: t('recuts.title') })}
        </p>
      ) : recuts.length === 0 ? (
        <p className="fw-pr-hint">{t('recuts.none')}</p>
      ) : (
        <ul className="fw-pr-list">
          {recuts.map((recut) => (
            <li key={recut.id} className="fw-pr-inline">
              <Pill tone={recut.status === 'OPEN' ? 'info' : 'success'}>{t(`recuts.status.${recut.status}`)}</Pill>
              <span>{t('recuts.what', { quantity: recut.quantity, part: recut.part ?? t('recuts.whole'), cell: `${recut.cell.colourwayCode} ${recut.cell.size}` })}</span>
              <span className="fw-pr-hint">
                {recut.reason} · {formatDateTime(recut.createdAt, { locale })}
              </span>
              {recut.status === 'OPEN' && (
                <Button size="sm" heldReason={say(t, recutHeld(recut, log, cut.can, cut.busy))} onClick={() => actions?.onRecut?.(recut.id)}>
                  {t('recuts.markCut')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="fw-pr-hint">{t('recuts.hint')}</p>
      {cut.recut && <RecutDialog log={log} cut={cut} recut={recuts.find((row) => row.id === cut.recut) ?? null} actions={actions} />}
    </Card>
  )
}

function RecutDialog({ log, cut, recut, actions }: { log: CutLog | null; cut: CutPartsModel; recut: Replacement | null; actions?: CutPartsActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const tp = useT('production')
  const locale = useLocale()
  const entries = recut && log ? recutEntries(log, recut) : []
  const [entryId, setEntryId] = useState(entries[0]?.id ?? '')
  const held = recut ? (say(t, recutHeld(recut, log, cut.can, cut.busy)) ?? (entryId ? null : t('recuts.held.entry'))) : t('held.loading')
  return (
    <Modal
      open
      onClose={() => actions?.onRecut?.(null)}
      title={t('recuts.dialog.title')}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onRecut?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => recut && actions?.onRecutDone?.(recut.id, entryId)}>
            {cut.busy ? <Spinner size={12} /> : null} {t('recuts.dialog.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pr-dialog">
        {cut.problem && <Banner tone="danger" title={say(t, cut.problem)} />}
        {recut && <p>{t('recuts.what', { quantity: recut.quantity, part: recut.part ?? t('recuts.whole'), cell: `${recut.cell.colourwayCode} ${recut.cell.size}` })}</p>}
        <Field label={t('recuts.dialog.entry')} hint={t('recuts.dialog.entryHint')}>
          <Select size="sm" value={entryId} onChange={(event) => setEntryId(event.target.value)}>
            {entries.length === 0 && <option value="">{t('recuts.dialog.noEntry')}</option>}
            {entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${formatDateTime(entry.serverTime, { locale })} · ${entry.hideCode} · ${entry.station?.code ?? tp('cutting.office')}`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

// ---- the cut orders of this work order: its fabric lays (the Cut record's Lay or hides) ------------------------------------

export function CutOrdersCard({ prefix, orders, onRetry }: { prefix: string; orders: CutPartsModel['orders']; onRetry?: () => void }) {
  const o = useT(ORDERS_NAMESPACE)
  const tp = useT('production')
  if (!orders) return null
  return (
    <Card padded className="fw-pr-card">
      <h2 className="fw-pr-h2">{o('ofWorkOrder.title')}</h2>
      {orders.problem ? (
        <EmptyState
          title={o('part.failed', { part: o('ofWorkOrder.title') })}
          description={o(orders.problem)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {o('common.retry')}
              </Button>
            ) : undefined
          }
        />
      ) : !orders.value ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {o('part.loading', { part: o('ofWorkOrder.title') })}
        </p>
      ) : orders.value.length === 0 ? (
        <p className="fw-pr-hint">{o('ofWorkOrder.none')}</p>
      ) : (
        <ul className="fw-pr-list">
          {orders.value.map((row: CutOrderOfWorkOrder) => {
            const plan = planPhrase(row.order)
            return (
              <li key={row.order.id} className="fw-pr-cell">
                <span className="fw-pr-inline">
                  <Link className="fw-pr-link" href={orderHref(prefix, row.order.id)}>
                    {row.order.number}
                  </Link>
                  <Pill tone={ORDER_TONE[row.order.status]}>{o(`status.${row.order.status}`)}</Pill>
                  <span className="fw-pr-hint">
                    {o(`kind.${row.order.kind}`)} · {[row.order.material.item.code, row.order.material.colour?.code].filter(Boolean).join(' · ')} · {o(plan.key, plan.params)}
                  </span>
                </span>
                {row.others.length > 0 && <span className="fw-pr-cell-sub">{tp('cutting.sharedWith', { count: row.others.length, numbers: row.others.map((other) => other.number).join(', ') })}</span>}
              </li>
            )
          })}
        </ul>
      )}
      <p className="fw-pr-hint">{o('ofWorkOrder.hint')}</p>
    </Card>
  )
}

// ---- yield per lot and supplier, issued against used against returned (the Cut record's Yield) -------------------------------

export function LotYieldCard({ prefix, workOrder, hides, plannedPct, log, claims }: { prefix: string; workOrder: Pick<WorkOrder, 'spec'>; hides: readonly (LotHide & { readonly hide: { readonly id: string } })[]; plannedPct: string | null; log: CutLog | null; claims: boolean }) {
  const t = useT(CUTTING_NAMESPACE)
  const o = useT(ORDERS_NAMESPACE)
  const locale = useLocale()
  const lots = lotYields(hides)
  const units = [...new Set(leatherMaterials(workOrder).map((material) => material.baseUom))]
  const sums = log ? areaBalance(log, { hides }, units.length === 1 ? (units[0] ?? '') : '') : []
  if (lots.length === 0 && sums.length === 0) return null
  return (
    <Card padded className="fw-pr-card">
      <h2 className="fw-pr-h2">{t('yield.byLot')}</h2>
      {lots.length > 0 && (
        <SummaryTable
          label={t('yield.byLot')}
          density="roomy"
          stackOnPhone
          columns={[t('yield.col.lot'), t('yield.col.supplier'), t('yield.col.hides'), t('yield.col.used'), t('yield.col.pattern'), t('yield.col.yield'), o('feedback.col.plan'), o('feedback.col.action')]}
          align={[undefined, undefined, 'right', 'right', 'right', 'right', 'right', 'left']}
          rows={lots.map((lot) => {
            const points = againstPlan(lot.yieldPct, plannedPct)
            const held = feedbackHeld(lot, claims)
            return {
              id: lot.lotId,
              cells: [
                lot.supplierLotRef ? `${lot.lotCode} (${lot.supplierLotRef})` : lot.lotCode,
                lot.supplier ?? '—',
                String(lot.hides),
                `${areaNumber(String(lot.used), locale)} ${unitWord(lot.uom)}`,
                `${areaNumber(String(lot.pattern), locale)} ${unitWord(lot.uom)}`,
                percent(lot.yieldPct, locale),
                points === null ? '—' : <Tag key="plan" tone={underPlan(points) ? 'warning' : 'neutral'}>{o('feedback.points', { points: `${points > 0 ? '+' : points < 0 ? '−' : ''}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.abs(points))}` })}</Tag>,
                held ? (
                  <Button key="feedback" size="sm" variant={underPlan(points) ? 'primary' : undefined} heldReason={o(held.key, held.params)}>
                    {o('feedback.raise')}
                  </Button>
                ) : (
                  <Button key="feedback" size="sm" variant={underPlan(points) ? 'primary' : undefined} asChild>
                    <Link href={`${prefix}/purchasing/claims?lot=${encodeURIComponent(lot.lotId)}&new=1`}>{o('feedback.raise')}</Link>
                  </Button>
                ),
              ],
            }
          })}
        />
      )}
      {lots.length > 0 && <p className="fw-pr-hint">{o('feedback.hint')}</p>}
      {sums.length > 0 && (
        <>
          <h3 className="fw-pr-h3">{o('balance.title')}</h3>
          <SummaryTable
            label={o('balance.title')}
            stackOnPhone
            columns={[o('balance.col.unit'), o('balance.col.hides'), o('balance.col.issued'), o('balance.col.used'), o('balance.col.waste'), o('balance.col.returned'), o('balance.col.left')]}
            align={['left', 'right', 'right', 'right', 'right', 'right', 'right']}
            rows={sums.map((sum) => ({
              id: sum.uom || 'unit',
              cells: [unitWord(sum.uom) || '—', String(sum.hides), areaNumber(String(sum.issued), locale), areaNumber(String(sum.cut), locale), areaNumber(String(sum.waste), locale), areaNumber(String(sum.returned), locale), areaNumber(String(sum.left), locale)],
            }))}
          />
          <p className="fw-pr-hint">{o('balance.hint')}</p>
        </>
      )}
      <p className="fw-pr-hint">{t('yield.hint')}</p>
    </Card>
  )
}
