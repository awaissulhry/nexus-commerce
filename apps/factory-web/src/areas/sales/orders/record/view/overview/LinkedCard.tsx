'use client'

import Link from 'next/link'
import { Fragment } from 'react'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { dayInstant, readOnlyOnPage, type Phrase } from '../../../model' // F-OO-207: Read-only sees no door (the band's own rule)
import { linkedRowsOf, type LinkCount, type LinkedDoor, type LinkedQuiet, type LinkedRow } from '../../overview/linked'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { useSearchParams } from 'next/navigation'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { OverviewCard } from '../../../../../../lib/record-overview/Overview' // F-CO-K1: the card's frame is the shared overview kit's
// ---- F-CO-K2: its rows are the kit's ONE list (its look comes with it: no stylesheet of the card's own); the rows' words are the
// kit's (useOverviewWords: "None yet: …", "… ›" whose arrow never stands alone on a line — F-OM-fx6, now the kit's door(), S31) ----
import { QuietLine, Row, RowList, useOverviewWords } from '../../../../../../lib/record-overview/Overview'
import { useFlowWords } from '../../flow-words' // owb-of5 step 2: the Customer row (design: Linked records › Customer)
// ---- end F-CO-K2

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx.
 *
 * O6 Linked records — F-OO-207 (11-design §6; review F5, F8; Owner D3, D8): one row per kind — the label, its state as one value
 * that is a real link to the order's own tab ("Work orders  4 · 2 in work · 1 draft ›"), and the door that makes the next record
 * when one is due (Make work orders…, Create shipment…: the band's own dialogs, held in their words). Kinds at zero in one quiet
 * line ("None yet: Shipments · Invoices"); a last quiet line: the quote (or the request, or "Typed by the office"), the deposit
 * when it waits for nothing, the orders of the same quote. Every number is the domain's ONE count rule (overview/linked.ts).
 * Read-only: the same rows, no door.
 * F-CO-K2: drawn with the shared overview kit's ONE list (`RowList`, `Row` — its doors cell always drawn here, empty when no record is
 * due — and `QuietLine`); "None yet", "… ›" and "Could not be read" are the kit's words.
 */
export function LinkedCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const words = useOverviewWords() // F-CO-K2
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
  const f = useFlowWords() // owb-of5
  return (
    <OverviewCard title={t('overview.linked.title')}>
      <RowList label={t('overview.linked.title')}>
        {view.rows.map((row) =>
          row.held ? (
            // F-OP-306 (walk #21): a list held for this reader says the Money tab's own sentence, alone (no label, no number).
            <QuietLine key={row.kind}>{t(row.held.key)}</QuietLine>
          ) : (
            <Row key={row.kind} label={label(row.kind)} doors={row.door ? <DoorView door={row.door} model={model} actions={actions} /> : null}>
              <RowValue row={row} />
            </Row>
          ),
        )}
        {/* owb-of5 step 2 (prototype rec.js Linked records: Customer ›): the order's customer, a door to its page. */}
        {order.party ? (
          <Row label={f('linked.customer')}>
            <Link className="fw-so-link" href={`${model.prefix}/sales/customers/${encodeURIComponent(order.partyId)}`}>
              {words.door(order.party.legalName)}
            </Link>
          </Row>
        ) : null}
        {view.none.length > 0 && <QuietLine>{words.none(view.none.map(label).join(' · '))}</QuietLine>}
        {view.quiet.length > 0 && (
          <QuietLine>
            {view.quiet.map((part, index) => (
              <Fragment key={`${part.kind}-${index}`}>
                {index > 0 ? ' · ' : null}
                <QuietPart part={part} />
              </Fragment>
            ))}
          </QuietLine>
        )}
      </RowList>
    </OverviewCard>
  )
}

/** A row's value: its number and its parts joined with " · ", a real link to its tab (no prefetch: TabLink, F-OP-210). */
function RowValue({ row }: { row: LinkedRow }) {
  const t = useT('orders')
  const words = useOverviewWords() // F-CO-K2: "… ›" and "Could not be read" are the kit's words
  if (row.state === 'reading') return <Skeleton height={16} width={64} />
  if (row.state === 'unread') return <span className="fw-so-hint">{words.unreadMany}</span>
  // Walk #8: a part that holds others says them in it ("3 issued (1 credit note, 1 deposit invoice)").
  const value = [...(row.count !== null ? [String(row.count)] : []), ...row.parts.map((part) => t(part.key, part.of ? { ...part.params, of: part.of.map((inner) => t(inner.key, inner.params)).join(', ') } : part.params))].join(' · ')
  return row.href ? (
    <TabLink className="fw-so-link" href={row.href}>
      {words.door(value)}
    </TabLink>
  ) : (
    <span>{value}</span>
  )
}

/** A part of the quiet line, a link where it opens something. */
function QuietPart({ part }: { part: LinkedQuiet }) {
  const t = useT('orders')
  const kit = useOverviewWords() // F-CO-K2: "{label}: {value}" and "… ›" are the kit's words
  const locale = useLocale() // F-OM-fx5w (N1): the extra deposit's due day
  if (part.kind === 'quote' || part.kind === 'origin') {
    const words = part.kind === 'quote' ? kit.labelled(t('overview.linked.quote'), t('chain.quoteValue', { number: part.number, revision: part.revision })) : t(part.words.key, part.words.params)
    return part.href ? (
      <Link className="fw-so-link" href={part.href}>
        {kit.door(words)}
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
        {kit.door(kit.labelled(t('overview.linked.deposit'), state))}
      </TabLink>
    )
  }
  return (
    <Link className="fw-so-link" href={part.href}>
      {kit.door(kit.labelled(t('overview.linked.sameQuote'), part.number))}
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
