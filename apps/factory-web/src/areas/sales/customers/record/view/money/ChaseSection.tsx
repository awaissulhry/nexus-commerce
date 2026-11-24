'use client'

import Link from 'next/link'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import { keepNumbers } from '../../../../orders/record/money/view/say'
import { word } from '../../../../orders/record/money/word'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Quiet, Section } from '../../../../orders/record/view/production/Kit'
import type { ChaseModel, ReminderRow, StopRow } from '../../money/chase'
import { kitId } from '../../money/sections'
import type { CustomerSay } from '../../money/say'

/**
 * F-CM-302 (customer page › MONEY tab, cm-w3 W3.2; 10-design §5.6) — section 6, Statement & reminders (#statement): reminders OFF said
 * once; the reminders (ONE act: Review in Finance › — a door) and the stops in force (ONE act: Lift… — Finance's own stop container, in
 * place) side by side from 1200 px of the section. Head: Statement… (Finance's own window, in place; only with the price grain) · ⋯
 * Their figures › · Ri.Ba. › · Open in Finance › Receivables & credit › · Copy link. Draws its model; reads nothing.
 */
export interface ChaseSectionProps {
  readonly model: ChaseModel
  readonly sayIn: (currency: string) => CustomerSay
  readonly unit: string
  readonly menu: readonly MenuItemDef[]
  readonly onRetry: () => void
  /** Finance's Statement window, in place. Absent: not drawn. */
  readonly onStatement?: () => void
  /** Finance's stop container on the stop's invoice (Lift…). Absent: not drawn. */
  readonly onLift?: (stop: StopRow) => void
}

export function ChaseSection({ model, sayIn, unit, menu, onRetry, onStatement, onLift }: ChaseSectionProps) {
  const say = sayIn(unit)
  const title = say(word('cm.chase.title'))
  const items: MenuItemDef[] = [...menu, { id: 'link', label: say(word('cm.linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('statement') }]
  const info = (
    <>
      <p>{say(word('cm.chase.info'))}</p>
      <p>{say(word('cm.keys'))}</p>
    </>
  )
  const buttons = model.statement && onStatement ? [<Button key="statement" size="sm" onClick={onStatement}>{say(word('cm.chase.statement'))}</Button>] : []
  const head = { id: kitId('statement'), title, info, buttons, more: <LineMenuButton label={say(word('cm.chase.more'))} items={items} /> }
  if (model.reading)
    return (
      <Section {...head} answer={say(word('cm.chase.reading'))}>
        <PartReading rows={2} height={30} />
      </Section>
    )
  if (model.problem)
    return (
      <Section {...head}>
        <PartFailed part={say(word('cm.chase.part'))} problem={model.problem} onRetry={onRetry} />
      </Section>
    )
  const both = model.reminders.length > 0 && model.stops.length > 0
  return (
    <Section {...head} answer={model.answer.map(say).join(' · ')}>
      <div className="fw-cm-bal">
        {model.off ? <Quiet>{say(model.off)}</Quiet> : null}
        {model.reminders.length > 0 || model.stops.length > 0 ? (
          <div className={`fw-cm-two${both ? ' is-two' : ''}`}>
            {model.reminders.length > 0 ? (
              <div>
                <h3 className="fw-pt-h3 fw-cm-h3">{say(word('cm.chase.remindersTitle', { params: { count: model.reminders.length } }))}</h3>
                <div className={`fw-cm-list${model.reminders.some((row) => row.amount !== null) ? '' : ' is-np'}`} role="list" aria-label={say(word('cm.chase.remindersTitle', { params: { count: model.reminders.length } }))}>
                  {model.reminders.map((row) => (
                    <ReminderRowView key={row.anchor} row={row} say={sayIn(row.currency)} menu={menu} />
                  ))}
                </div>
              </div>
            ) : null}
            {model.stops.length > 0 ? (
              <div>
                <h3 className="fw-pt-h3 fw-cm-h3">{say(word('cm.chase.stopsTitle', { params: { count: model.stops.length } }))}</h3>
                <div className={`fw-cm-list is-np${model.stops.some((row) => row.liftable) && onLift ? '' : ' is-na'}`} role="list" aria-label={say(word('cm.chase.stopsTitle', { params: { count: model.stops.length } }))}>
                  {model.stops.map((row) => (
                    <StopRowView key={row.anchor} row={row} say={say} onLift={onLift} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  )
}

function ReminderRowView({ row, say, menu }: { row: ReminderRow; say: CustomerSay; menu: readonly MenuItemDef[] }) {
  const locale = useLocale()
  return (
    <div className="fw-cm-row" id={row.anchor} role="listitem" tabIndex={-1}>
      <div className="fw-cm-row-g">
        <div className="fw-cm-row-k">
          <span className="fw-cm-row-kt">
            <b>{say(row.title)}</b>
            <Pill tone={row.state.tone}>{say(row.state.word)}</Pill>
          </span>
          {row.invoices.length > 0 ? <span className="fw-pt-sub">{keepNumbers(say(word('cm.chase.forInvoices', { params: { invoices: row.invoices.join(', ') } })))}</span> : null}
        </div>
        <div className="fw-cm-row-d">
          <span>{say(row.when)}</span>
        </div>
        <div className="fw-cm-row-n">
          {row.notes.map((note) => (
            <span key={note.key} className="is-warning">
              <span>{say(note)}</span>
            </span>
          ))}
        </div>
        <div className="fw-cm-row-m">
          {row.amount !== null ? <span className="fw-om-amt">{money(row.amount, row.currency, locale)}</span> : null}
          {row.interest !== null ? <span className="fw-cm-of">{say(word('cm.chase.interest', { money: { amount: row.interest } }))}</span> : null}
        </div>
        <div className="fw-cm-row-a">
          <Button size="sm" asChild>
            <Link href={row.href}>{say(word('cm.chase.review'))}</Link>
          </Button>
        </div>
        <div className="fw-cm-row-o">
          <LineMenuButton label={say(word('cm.collect.rowMore', { params: { row: say(row.title) } }))} items={[...menu, { id: 'link', label: say(word('orders:moneyTab.menu.copyLinkRow')), onSelect: () => copyLinkTo(row.anchor) }]} />
        </div>
      </div>
    </div>
  )
}

function StopRowView({ row, say, onLift }: { row: StopRow; say: CustomerSay; onLift?: (stop: StopRow) => void }) {
  const items: MenuItemDef[] = [
    { id: 'invoice', label: say(word('orders:moneyTab.plan.menu.openInvoice', { params: { number: row.invoice.number ?? '—' } })), href: row.invoice.href },
    { id: 'link', label: say(word('orders:moneyTab.menu.copyLinkRow')), onSelect: () => copyLinkTo(row.anchor) },
  ]
  return (
    <div className="fw-cm-row" id={row.anchor} role="listitem" tabIndex={-1}>
      <div className="fw-cm-row-g">
        <div className="fw-cm-row-k">
          <span className="fw-cm-row-kt">
            <Pill tone="warning">{say(row.reason)}</Pill>
            <Link className="fw-pt-link" href={row.invoice.href}>
              <span className="fw-om-num">{row.invoice.number ?? '—'}</span> ›
            </Link>
          </span>
          {row.note ? <span className="fw-pt-sub">{row.note}</span> : null}
        </div>
        <div className="fw-cm-row-d">
          <span>{say(row.until)}</span>
        </div>
        <div className="fw-cm-row-n">
          <span>
            <span>{say(row.recorded)}</span>
          </span>
        </div>
        <div className="fw-cm-row-m" />
        <div className="fw-cm-row-a">
          {row.liftable && onLift ? (
            <Button size="sm" onClick={() => onLift(row)}>
              {say(word('finance-payments-depth:stops.liftMenu'))}
            </Button>
          ) : null}
        </div>
        <div className="fw-cm-row-o">
          <LineMenuButton label={say(word('cm.collect.rowMore', { params: { row: say(row.reason) } }))} items={items} />
        </div>
      </div>
    </div>
  )
}
