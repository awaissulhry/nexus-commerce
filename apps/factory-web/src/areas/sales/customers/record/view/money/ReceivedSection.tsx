'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Banknote, Info } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import type { Refund } from '../../../../../finance/payments/refunds/api'
import { money } from '../../../../quotes/model'
import { Fold } from '../../../../orders/record/money/view/parts'
import { keepNumbers } from '../../../../orders/record/money/view/say'
import { word } from '../../../../orders/record/money/word'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../orders/record/view/production/Kit'
import { dayTagOf } from '../../money/collect'
import type { Part } from '../../money/model'
import { PAYMENTS_SHOWN, refundsMadeOf, type GiveBackMove, type GiveBackRow, type PaymentItem, type ReceivedModel } from '../../money/received'
import type { MoneyTabInput } from '../../money/model'
import { kitId } from '../../money/sections'
import type { CustomerSay } from '../../money/say'

/**
 * F-CM-203 (customer page › MONEY tab, cm-w2 W2.3; 10-design §5.4; 18-lead-settles Z7, Z18, Z22, Z25) — section 4, Payments & refunds
 * (#received): the "On account" box (#on-account) with Refund… (Finance's own window, in place) and Place it › (the payment's record);
 * To give back (#give-back): a refund to make with Mark made… and ⋯ Cancel…, a credit note with money left with Refund… — every window
 * Finance's own (RefundDialogs, opened by the container); Payments received, the first 3 then "Show n more payments"; Refunds made,
 * folded (read when it opens), ⋯ Void… on a made one. The ⓘ says Finance calls the money on account the customer's credit balance (Z22).
 * Draws its model (money/received.ts); reads nothing.
 */
export interface ReceivedSectionProps {
  readonly model: ReceivedModel
  readonly input: MoneyTabInput
  readonly made: Part<readonly Refund[]> | null
  readonly sayIn: (currency: string) => CustomerSay
  readonly unit: string
  readonly menu: readonly MenuItemDef[]
  readonly onRetry: () => void
  readonly onRetryMade: () => void
  /** The fold opened: read the refunds made. */
  readonly onFold: () => void
  readonly onMorePayments: () => void
  /** Finance's Refund… window, opened on a credit note or a payment (its id), or on nothing chosen (null). Absent: not drawn. */
  readonly onRefund?: (start: string | null) => void
  /** Finance's Mark made… / Cancel… / Void… window on a refund. Absent: not drawn. */
  readonly onMove?: (refund: Refund, move: GiveBackMove) => void
}

export function ReceivedSection({ model, input, made, sayIn, unit, menu, onRetry, onRetryMade, onFold, onMorePayments, onRefund, onMove }: ReceivedSectionProps) {
  const locale = useLocale()
  const say = sayIn(unit)
  const [all, setAll] = useState(false)
  const [folded, setFolded] = useState(true)
  const title = say(word('cm.received.title'))
  const items: MenuItemDef[] = [...menu, { id: 'link', label: say(word('cm.linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('received') }]
  const info = (
    <>
      <p>{say(word('cm.received.info'))}</p>
      <p>{say(word('cm.keys'))}</p>
    </>
  )
  const buttons = model.refundable && onRefund ? [<Button key="refund" size="sm" onClick={() => onRefund(null)}>{say(word('finance-daily:refund.open'))}</Button>] : []
  const head = { id: kitId('received'), title, info, buttons, more: <LineMenuButton label={say(word('cm.received.more'))} items={items} /> }
  const amount = (value: number | null, currency: string) => (value === null ? null : money(value, currency, locale))

  const boxes = model.onAccount.map((box, index) => (
    <div key={box.currency} className="fw-cm-acct" id={index === 0 ? 'on-account' : undefined} tabIndex={-1}>
      <div className="fw-cm-acct-t">
        <span className="fw-pt-label">{say(word('cm.received.onAccountTitle'))}</span>
        <b>{box.amount !== null ? amount(box.amount, box.currency) : say(word('cm.answer.onAccountWords'))}</b>
        <span>{box.from && box.waits !== null ? say(word('cm.received.from', { days: { date: box.from.receivedOn }, words: { days: word('cm.days', { params: { count: box.waits } }) } })) : say(word('cm.received.held'))}</span>
      </div>
      <div className="fw-cm-acct-a">
        {box.refundable && onRefund ? (
          <Button size="sm" onClick={() => onRefund(box.from?.paymentId ?? null)}>
            {say(word('finance-daily:refund.open'))}
          </Button>
        ) : null}
        {box.from && input.can.paymentsRecord && input.can.price ? (
          <Button size="sm" asChild>
            <Link href={box.from.href}>{say(word('cm.received.place'))}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  ))

  const giveBack =
    model.giveBack.length > 0 ? (
      <div className="fw-cm-blk" id="give-back" tabIndex={-1}>
        <h3 className="fw-pt-h3 fw-cm-h3">{say(word('cm.received.giveBackTitle', { params: { count: model.giveBack.length } }))}</h3>
        <div className={`fw-cm-list${input.can.price ? '' : ' is-np'}${model.giveBack.some((row) => row.act) && (onRefund || onMove) ? '' : ' is-na'}`} role="list" aria-label={say(word('cm.balance.giveBack'))}>
          {model.giveBack.map((row) => (
            <GiveBackRowView key={row.anchor} row={row} say={sayIn(row.currency)} amount={amount(row.amount, row.currency)} onRefund={onRefund} onMove={onMove} />
          ))}
        </div>
      </div>
    ) : null

  let paymentsPart: ReactNode = null
  if (model.reading) paymentsPart = <PartReading rows={2} height={30} />
  else if (model.problem) paymentsPart = <PartFailed part={say(word('cm.received.part'))} problem={model.problem} onRetry={onRetry} />
  else if (model.payments.length > 0) {
    const shown = all ? model.payments : model.payments.slice(0, PAYMENTS_SHOWN)
    const hidden = model.payments.length - shown.length
    paymentsPart = (
      <div className="fw-cm-blk">
        <h3 className="fw-pt-h3 fw-cm-h3">{say(word('cm.received.paymentsTitle', { params: { count: model.payments.length } }))}</h3>
        <div className={`fw-cm-list${input.can.price ? '' : ' is-np'} is-na`} role="list" aria-label={say(word('cm.received.title'))}>
          {shown.map((row) => (
            <PaymentRowView key={row.anchor} row={row} say={sayIn(row.currency)} amount={amount(row.amount, row.currency)} />
          ))}
        </div>
        {hidden > 0 ? (
          <Button size="sm" variant="quiet" className="fw-cm-more" onClick={() => setAll(true)}>
            {say(word('cm.more.payments', { params: { count: hidden } }))}
          </Button>
        ) : all && model.more ? (
          <Button size="sm" variant="quiet" className="fw-cm-more" onClick={onMorePayments}>
            {say(word('cm.more.paymentsNext'))}
          </Button>
        ) : all && model.payments.length > PAYMENTS_SHOWN ? (
          <Button size="sm" variant="quiet" className="fw-cm-more" onClick={() => setAll(false)}>
            {say(word('cm.more.fewer'))}
          </Button>
        ) : null}
      </div>
    )
  }

  const madeRows = made?.value ? refundsMadeOf(made.value, input) : null
  const madeLabel = madeRows ? say(word('cm.received.madeCount', { params: { count: madeRows.length } })) : say(word('cm.received.made'))
  const fold = (
    <div className="fw-cm-blk">
      <Fold
        open={!folded}
        onToggle={() => {
          if (folded) onFold()
          setFolded((now) => !now)
        }}
        label={madeLabel}
        hint={say(word('cm.received.madeHint'))}
      />
      {folded ? null : !made || (made.value === null && !made.problem) ? (
        <PartReading rows={1} height={30} />
      ) : made.problem ? (
        <PartFailed part={say(word('cm.received.made'))} problem={made.problem} onRetry={onRetryMade} />
      ) : madeRows && madeRows.length > 0 ? (
        <div className={`fw-cm-list${input.can.price ? '' : ' is-np'} is-na`} role="list" aria-label={madeLabel}>
          {madeRows.map((row) => {
            const rowSay = sayIn(row.refund.currency)
            const menuItems: MenuItemDef[] = row.voidable && onMove ? [{ id: 'void', label: rowSay(word('finance-daily:refunds.move.void.verb')), onSelect: () => onMove(row.refund, 'void') }] : []
            return (
              <div key={row.refund.id} className="fw-cm-row" id={`cm-Refund-${row.refund.id}`} role="listitem" tabIndex={-1}>
                <div className="fw-cm-row-g">
                  <div className="fw-cm-row-k">
                    <span className="fw-cm-row-kt">
                      <Tag tone={row.state.tone}>{rowSay(row.state.word)}</Tag>
                      <b>{keepNumbers(rowSay(row.title))}</b>
                    </span>
                  </div>
                  <div className="fw-cm-row-d">{row.day ? <span>{rowSay(word('cm.received.madeOn', { days: { date: row.day } }))}</span> : null}</div>
                  <div className="fw-cm-row-n" />
                  <div className="fw-cm-row-m">{row.amount !== null ? <span className="fw-om-amt">{amount(row.amount, row.refund.currency)}</span> : null}</div>
                  <div className="fw-cm-row-a" />
                  <div className="fw-cm-row-o">{menuItems.length > 0 ? <LineMenuButton label={rowSay(word('cm.collect.rowMore', { params: { row: rowSay(row.title) } }))} items={menuItems} /> : null}</div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="fw-cm-foot">
          <span>{say(word('cm.received.madeNone'))}</span>
        </p>
      )}
    </div>
  )

  return (
    <Section {...head} answer={model.reading ? say(word('cm.received.reading')) : model.answer.map(say).join(' · ')}>
      <div className="fw-cm-bal">
        {boxes}
        {giveBack}
        {paymentsPart}
        {fold}
      </div>
    </Section>
  )
}

function GiveBackRowView({ row, say, amount, onRefund, onMove }: { row: GiveBackRow; say: CustomerSay; amount: string | null; onRefund?: (start: string | null) => void; onMove?: (refund: Refund, move: GiveBackMove) => void }) {
  const tag = row.late !== null ? dayTagOf(row.late) : null
  const refund = row.refund
  const act = !row.act ? null : row.act.id === 'paid' && refund && onMove ? (
    <Button size="sm" variant="primary" onClick={() => onMove(refund, 'paid')}>
      <Banknote size={13} aria-hidden /> {say(row.act.label)}
    </Button>
  ) : row.act.id === 'refund' && onRefund ? (
    <Button size="sm" onClick={() => onRefund(row.id)}>
      {say(row.act.label)}
    </Button>
  ) : null
  const items: MenuItemDef[] = []
  for (const entry of row.more) {
    if (entry.href) items.push({ id: entry.id, label: say(entry.label), href: entry.href })
    else if ((entry.id === 'cancel' || entry.id === 'void') && refund && onMove) {
      const move = entry.id
      items.push({ id: move, label: say(entry.label), onSelect: () => onMove(refund, move) })
    }
  }
  items.push({ id: 'link', label: say(word('orders:moneyTab.menu.copyLinkRow')), onSelect: () => copyLinkTo(row.anchor) })
  return (
    <div className="fw-cm-row" id={row.anchor} role="listitem" tabIndex={-1}>
      <div className="fw-cm-row-g">
        <div className="fw-cm-row-k">
          <span className="fw-cm-row-kt">
            <Tag tone={row.chip.tone}>{say(row.chip.word)}</Tag>
            <b>{keepNumbers(say(row.title))}</b>
          </span>
          {row.sub ? <span className="fw-pt-sub">{keepNumbers(say(row.sub))}</span> : null}
        </div>
        <div className="fw-cm-row-d">
          {row.due ? <span>{say(word('finance-daily:refunds.dueOn', { days: { date: row.due } }))}</span> : null}
          {tag ? <Tag tone={tag.tone}>{say(tag.word)}</Tag> : null}
        </div>
        <div className="fw-cm-row-n">
          {row.kind === 'note' ? (
            <span>
              <Info size={13} aria-hidden />
              <span>{say(word('finance-daily:refunds.state.toRefund'))}</span>
            </span>
          ) : null}
        </div>
        <div className="fw-cm-row-m">{amount !== null ? <span className="fw-om-amt">{amount}</span> : null}</div>
        <div className="fw-cm-row-a">{act}</div>
        <div className="fw-cm-row-o">
          <LineMenuButton label={say(word('cm.collect.rowMore', { params: { row: say(row.title) } }))} items={items} />
        </div>
      </div>
    </div>
  )
}

function PaymentRowView({ row, say, amount }: { row: PaymentItem; say: CustomerSay; amount: string | null }) {
  const items: MenuItemDef[] = [
    { id: 'open', label: say(word('cm.received.openPayment')), href: row.href },
    { id: 'ref', label: say(word('orders:moneyTab.payment.copyRef')), onSelect: () => void navigator.clipboard?.writeText(row.reference) },
  ]
  return (
    <div className="fw-cm-row" id={row.anchor} role="listitem" tabIndex={-1}>
      <div className="fw-cm-row-g">
        <div className="fw-cm-row-k">
          <span className="fw-cm-row-kt">
            <b>{say(word('cm.day', { days: { date: row.day } }))}</b>
            <span>{say(row.method)}</span>
          </span>
        </div>
        <div className="fw-cm-row-d">
          <span>{keepNumbers(say(word('cm.received.ref', { params: { reference: row.reference } })))}</span>
        </div>
        <div className="fw-cm-row-n">
          <span className="fw-cm-chips">
            {row.placed.map((chip, index) => (
              <Tag key={`${chip.word.key}-${index}`} tone={chip.tone}>
                {keepNumbers(say(chip.word))}
              </Tag>
            ))}
          </span>
        </div>
        <div className="fw-cm-row-m">{amount !== null ? <span className="fw-om-amt">{amount}</span> : null}</div>
        <div className="fw-cm-row-a" />
        <div className="fw-cm-row-o">
          <LineMenuButton label={say(word('cm.collect.rowMore', { params: { row: say(word('cm.received.ofPayment', { days: { date: row.day } })) } }))} items={items} />
        </div>
      </div>
    </div>
  )
}
