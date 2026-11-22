'use client'

import Link from 'next/link'
import { Fragment } from 'react'
import { Card } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { dayInstant, readOnlyOnPage, type Phrase } from '../../../model' // F-OO-207: Read-only sees no door (the band's own rule)
import { linkedRowsOf, type LinkCount, type LinkedDoor, type LinkedQuiet, type LinkedRow } from '../../overview/linked'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { useSearchParams } from 'next/navigation'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import './linked.css' // F-OO-207: the card's own rows

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx.
 *
 * O6 Linked records — F-OO-207 (11-design §6; review F5, F8; Owner D3, D8): one row per kind — the label, its state as one value
 * that is a real link to the order's own tab ("Work orders  4 · 2 in work · 1 draft ›"), and the door that makes the next record
 * when one is due (Make work orders…, Create shipment…: the band's own dialogs, held in their words). Kinds at zero in one quiet
 * line ("None yet: Shipments · Invoices"); a last quiet line: the quote (or the request, or "Typed by the office"), the deposit
 * when it waits for nothing, the orders of the same quote. Every number is the domain's ONE count rule (overview/linked.ts).
 * Read-only: the same rows, no door.
 */
export function LinkedCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const search = useSearchParams()?.toString() ?? '' // F-OP-104: the order's own tabs keep the dock's scope
  const links = model.links ?? null
  /** Complaints or returns from GET …/links: not read on this page or no right: not drawn; still read; could not be read. */
  const linkCount = (pick: (read: Extract<NonNullable<OrderRecordModel['links']>, { state: 'ready' }>['links']) => readonly unknown[] | null): LinkCount =>
    !links ? null : links.state === 'loading' ? 'reading' : links.state === 'error' ? 'unread' : (pick(links.links)?.length ?? null)
  const view = linkedRowsOf({
    order,
    prefix: model.prefix,
    can: model.can,
    complaints: linkCount((read) => read.complaints),
    returns: linkCount((read) => read.returns),
    sameQuote: model.depth?.depth.value?.sameQuote ?? [],
    madeFrom: model.madeFromReading ? undefined : (model.madeFrom ?? null),
    search,
    shipInPlace: !!actions?.onCreateShipment,
    readOnly: readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold }),
  })
  const label = (kind: LinkedRow['kind']) => t(`overview.linked.${kind}`)
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('overview.linked.title')}</h2>
      <ul className="fw-so-linked-list" aria-label={t('overview.linked.title')}>
        {view.rows.map((row) =>
          row.held ? (
            // F-OP-306 (walk #21): a list held for this reader says the Money tab's own sentence, alone (no label, no number).
            <li key={row.kind} className="fw-so-linked-line fw-so-hint">
              {t(row.held.key)}
            </li>
          ) : (
            <li key={row.kind} className="fw-so-ov-row">
              <span className="fw-so-linked-label">{label(row.kind)}</span>
              <RowValue row={row} />
              <span className="fw-so-ov-doors">{row.door ? <DoorView door={row.door} model={model} actions={actions} /> : null}</span>
            </li>
          ),
        )}
        {view.none.length > 0 && <li className="fw-so-linked-line fw-so-hint">{t('linked.none', { kinds: view.none.map(label).join(' · ') })}</li>}
        {view.quiet.length > 0 && (
          <li className="fw-so-linked-line fw-so-hint">
            {view.quiet.map((part, index) => (
              <Fragment key={`${part.kind}-${index}`}>
                {index > 0 ? ' · ' : null}
                <QuietPart part={part} />
              </Fragment>
            ))}
          </li>
        )}
      </ul>
    </Card>
  )
}

/** A row's value: its number and its parts joined with " · ", a real link to its tab (no prefetch: TabLink, F-OP-210). */
function RowValue({ row }: { row: LinkedRow }) {
  const t = useT('orders')
  if (row.state === 'reading') return <Skeleton height={16} width={64} />
  if (row.state === 'unread') return <span className="fw-so-hint">{t('linked.unread')}</span>
  // Walk #8: a part that holds others says them in it ("3 issued (1 credit note, 1 deposit invoice)").
  const value = [...(row.count !== null ? [String(row.count)] : []), ...row.parts.map((part) => t(part.key, part.of ? { ...part.params, of: part.of.map((inner) => t(inner.key, inner.params)).join(', ') } : part.params))].join(' · ')
  return row.href ? (
    <TabLink className="fw-so-link" href={row.href}>
      {t('linked.value', { value })}
    </TabLink>
  ) : (
    <span>{value}</span>
  )
}

/** A part of the quiet line, a link where it opens something. */
function QuietPart({ part }: { part: LinkedQuiet }) {
  const t = useT('orders')
  const locale = useLocale() // F-OM-fx5w (N1): the extra deposit's due day
  if (part.kind === 'quote' || part.kind === 'origin') {
    const words = part.kind === 'quote' ? t('linked.labelled', { label: t('overview.linked.quote'), value: t('chain.quoteValue', { number: part.number, revision: part.revision }) }) : t(part.words.key, part.words.params)
    return part.href ? (
      <Link className="fw-so-link" href={part.href}>
        {t('linked.value', { value: words })}
      </Link>
    ) : (
      <span>{words}</span>
    )
  }
  if (part.kind === 'deposit') {
    // F-OM-fx5w (N1): not needed, an extra deposit open — Money's Totals' own words ("Not needed · an extra deposit is open, due …").
    const state = part.extraDue ? t('moneyTab.totals.fact.notNeededExtraWords', { date: formatDate(dayInstant(part.extraDue), { locale }) }) : t(`gate.state.${part.state}`)
    return (
      <TabLink className="fw-so-link" href={part.href}>
        {t('linked.value', { value: t('linked.labelled', { label: t('overview.linked.deposit'), value: state }) })}
      </TabLink>
    )
  }
  return (
    <Link className="fw-so-link" href={part.href}>
      {t('linked.value', { value: t('linked.labelled', { label: t('overview.linked.sameQuote'), value: part.number }) })}
    </Link>
  )
}

/**
 * The door that makes the next record (F8: only when due): Make work orders… (the page's New work order dialog, its order fixed)
 * or Create shipment… (in place, else Warehouse's page with this order chosen) — held in their own words, as the band holds them.
 */
function DoorView({ door, model, actions }: { door: LinkedDoor; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const say = (held: Phrase) => t(held.key, held.params?.date ? { ...held.params, date: formatDate(dayInstant(String(held.params.date)), { locale }) } : held.params)
  const busy = model.busy ? t('held.busy') : null
  if (door.kind === 'make') {
    return (
      <Button size="sm" heldReason={door.held ? say(door.held) : busy} onClick={() => actions?.makeWorkOrders?.onOpen?.()}>
        {t('bandMenu.makeWorkOrders')}
      </Button>
    )
  }
  if (door.to?.kind === 'warehouse') {
    return (
      <Button size="sm" asChild>
        <Link href={door.to.href}>{t('step.createShipment')}</Link>
      </Button>
    )
  }
  return (
    <Button size="sm" heldReason={door.held ? say(door.held) : busy} onClick={() => actions?.onCreateShipment?.()}>
      {t('step.createShipment')}
    </Button>
  )
}
