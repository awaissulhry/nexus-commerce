'use client'

import { useState } from 'react'
import Link from 'next/link'
import { MessageSquarePlus } from 'lucide-react'
import { Field, type MenuItemDef } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Tag } from '@nexus/ui/primitives'
import { DetailModal, Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { ReadinessPill } from '../../../../../production/work-orders/daily/view/DailyParts'
import type { ReadinessRow } from '../../../../../production/work-orders/daily/api'
import { dayInstant } from '../../../model'
import type { MtmGroupRead, WorkOrderOwn, Words } from '../../overview/api'
import { say } from '../../overview/model'
import { priorityRushBodyOf, priorityRushHeld, sizeTableOf, workshopsOf, PRIORITY_MAX, PRIORITY_MIN } from '../../production/work-detail'
import { statusKeyOf, unitStateKeyOf, unitsOf, workDatesOf, WO_TONE } from '../../production/work'
import { LineMenuButton } from '../LineMenu'

const WORK_ORDERS_NS = 'production-work-orders'

/** One entry of the window's walk: a work order of this order, or a made-to-measure group (its units). */
export type DetailEntry = { readonly kind: 'wo'; readonly id: string; readonly row: WorkOrderOwn } | { readonly kind: 'mtm'; readonly id: string; readonly group: MtmGroupRead }

/**
 * F-PT-105 (order PRODUCTION tab, 10-design §4 "Detail", D2) — a work order's centred window (the DS DetailModal, ‹ › and the keys walk
 * the work orders — Overview's Progress by line pattern): its status and rush, THIS order's pieces per size (Ordered · Cut · Sewn ·
 * Checked; a step the server does not send yet is left out), the plan's end and "after due" (the read's risk facts), the materials'
 * readiness with its hint, the outside workshops with their days, the floor's last told time; a made-to-measure group's units by number
 * and state — never the rider. The same ⋯ as the row (each act closes the window first: one dialog at a time).
 */
export function WorkOrderDetail({ entries, openId, orderNumber, readiness, toldAt, menuOf, onAsk, hrefOf, onGo, onClose }: {
  entries: readonly DetailEntry[]
  openId: string
  orderNumber: string
  readiness: ReadonlyMap<string, ReadinessRow>
  /** The floor's last told time per work order (the later of the server's and this page's writes). */
  toldAt: (workOrderId: string) => string | null
  menuOf: (row: WorkOrderOwn, close: () => void) => MenuItemDef[]
  onAsk: ((row: WorkOrderOwn) => void) | null
  hrefOf: (row: WorkOrderOwn) => string
  onGo: (id: string) => void
  onClose: () => void
}) {
  const t = useT('orders')
  const entry = entries.find((item) => item.id === openId) ?? null
  if (!entry) return null
  const nav = { ids: entries.map((item) => item.id), current: entry.id, onGo, noun: t('productionTab.detail.noun') }
  if (entry.kind === 'mtm') return <UnitsDetail group={entry.group} orderNumber={orderNumber} nav={nav} onClose={onClose} />
  const row = entry.row
  const items = menuOf(row, onClose)
  return (
    <DetailModal
      open
      onClose={onClose}
      title={t('productionTab.detail.title', { number: row.number, order: orderNumber })}
      subtitle={[row.style?.code ?? null, row.colourways.map((colour) => colour.name || colour.code).join(', ') || null, row.site?.name ?? null, row.line?.name ?? null].filter(Boolean).join(' · ')}
      meta={
        <span className="fw-pt-inline">
          <Pill tone={WO_TONE[row.status] ?? 'neutral'}>{t(statusKeyOf(row.status))}</Pill>
          {row.held && row.status !== 'ON_HOLD' ? <Tag tone="warning">{t('productionTab.detail.held')}</Tag> : null}
          {row.rush ? <Tag tone="neutral">{t('productionTab.wo.rush')}</Tag> : null}
        </span>
      }
      actions={items.length > 0 ? <LineMenuButton label={t('wo.acts', { number: row.number })} items={items} /> : undefined}
      nav={nav}
      footer={
        <span className="fw-pt-inline">
          {onAsk ? (
            <Button size="sm" onClick={() => onAsk(row)}>
              <MessageSquarePlus size={14} aria-hidden /> {t('productionTab.wo.ask', { number: row.number })}
            </Button>
          ) : null}
          <Button size="sm" asChild>
            <Link href={hrefOf(row)}>{t('productionTab.detail.open')}</Link>
          </Button>
        </span>
      }
    >
      <WorkOrderBody row={row} readiness={readiness.get(row.id) ?? null} toldAt={toldAt(row.id)} />
    </DetailModal>
  )
}

function WorkOrderBody({ row, readiness, toldAt }: { row: WorkOrderOwn; readiness: ReadinessRow | null; toldAt: string | null }) {
  const t = useT('orders')
  const r = useT(WORK_ORDERS_NS)
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const dates = workDatesOf(row)
  const table = row.sharedWithOtherCustomers ? null : sizeTableOf(row.cells)
  const shops = workshopsOf(row)
  return (
    <div className="fw-pt-detail">
      {row.sharedWithOtherCustomers && row.rights?.why ? <p className="fw-pt-hint">{say(row.rights.why as Words, locale)}</p> : null}
      <p className="fw-pt-inline">
        {dates.planEnd ? t('productionTab.detail.plan', { end: day(dates.planEnd), due: dates.due ? day(dates.due) : '—' }) : dates.due ? t('productionTab.wo.due', { date: day(dates.due) }) : t('productionTab.wo.noDue')}
        {dates.afterDue ? <Tag tone="danger">{t('productionTab.wo.afterDue')}</Tag> : null}
        {dates.planned === false ? <span className="fw-pt-sub">{t('productionTab.wo.notPlanned')}</span> : null}
      </p>
      {readiness ? (
        <p className="fw-pt-inline">
          <ReadinessPill word={readiness.word} date={readiness.date} /> <span className="fw-pt-sub">{r(`readiness.hint.${readiness.word}`)}</span>
        </p>
      ) : null}
      {table ? (
        <div className="fw-pt-sizes">
          <table aria-label={t('productionTab.detail.sizes')}>
            <thead>
              <tr>
                <th scope="col">{t('productionTab.detail.sizes')}</th>
                {table.sizes.map((size) => (
                  <th key={size} scope="col">
                    {size}
                  </th>
                ))}
                <th scope="col">{t('productionTab.detail.total')}</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((line) => (
                <tr key={line.step}>
                  <th scope="row">{t(`productionTab.detail.step.${line.step}`)}</th>
                  {line.values.map((value, index) => (
                    <td key={table.sizes[index]}>{value ?? '—'}</td>
                  ))}
                  <td>
                    <b>{line.total ?? '—'}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {shops.map((shop) => (
        <p key={shop.name} className="fw-pt-sub">
          {shop.back && shop.since ? t('productionTab.detail.workshopBack', { name: shop.name, since: day(shop.since), back: day(shop.back) }) : t('productionTab.detail.workshop', { name: shop.name })}
        </p>
      ))}
      {toldAt ? <p className="fw-pt-sub">{t('productionTab.wo.toldAt', { time: formatDateTime(toldAt, { locale }) })}</p> : null}
    </div>
  )
}

/** A made-to-measure group: its units by number and state (B-PT-003; a draft unit "not released yet", B6) — the rider never shown. */
function UnitsDetail({ group, orderNumber, nav, onClose }: { group: MtmGroupRead; orderNumber: string; nav: { ids: string[]; current: string; onGo: (id: string) => void; noun: string }; onClose: () => void }) {
  const t = useT('orders')
  const units = unitsOf(group)
  const name = `${group.style?.code ?? '—'} · ${group.colourway?.name ?? group.colourway?.code ?? '—'}`
  return (
    <DetailModal open onClose={onClose} title={t('productionTab.detail.title', { number: name, order: orderNumber })} subtitle={t('productionTab.detail.units', { count: group.units })} nav={nav}>
      <div className="fw-pt-detail">
        {units ? (
          <ul className="fw-pt-units">
            {units.units.map((unit) => (
              <li key={unit.id}>
                <b>{unit.number}</b> · {t(unitStateKeyOf(unit.status))}
              </li>
            ))}
            {units.more > 0 ? <li className="fw-pt-sub">{t('productionTab.detail.unitsMore', { count: units.more })}</li> : null}
          </ul>
        ) : (
          <p className="fw-pt-sub">{group.byStatus.map((entry) => `${t(statusKeyOf(entry.status))} ${entry.count}`).join(' · ')}</p>
        )}
        <p className="fw-pt-hint">{t('productionTab.detail.noRider')}</p>
      </div>
    </DetailModal>
  )
}

/**
 * F-PT-105 (D9) — "Priority and rush…": the work order's priority (a whole number, higher first; 0 is normal) and OUR factory rush,
 * saved in ONE write (the same PATCH as before, the row's version — the acts hook's). Never the customer's urgency.
 */
export function PriorityRushDialog({ row, busy, onSave, onClose }: { row: WorkOrderOwn; busy: boolean; onSave: (body: { priority?: number; rush?: boolean }) => void; onClose: () => void }) {
  const t = useT('orders')
  const current = { priority: row.priority ?? 0, rush: row.rush }
  const [draft, setDraft] = useState({ priority: String(current.priority), rush: current.rush })
  const held = priorityRushHeld(draft, current, busy)
  const go = held ? null : () => onSave(priorityRushBodyOf(draft, current))
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={t('productionTab.priority.title', { number: row.number })}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => go?.()}>
            {t('productionTab.priority.save')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pt-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          go?.()
        }}
      >
        <Field label={t('productionTab.priority.label')} hint={t('productionTab.priority.hint', { min: PRIORITY_MIN, max: PRIORITY_MAX })}>
          <Input size="sm" type="number" inputMode="numeric" min={PRIORITY_MIN} max={PRIORITY_MAX} step={1} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })} />
        </Field>
        <Checkbox checked={draft.rush} onChange={(event) => setDraft({ ...draft, rush: event.target.checked })} label={t('productionTab.priority.rush')} />
        <p className="fw-pt-hint">{t('productionTab.priority.rushHint')}</p>
      </form>
    </Modal>
  )
}
