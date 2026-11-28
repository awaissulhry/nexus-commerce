'use client'

import { Banknote } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { Section } from '../../../../../../lib/record-sections/Kit'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import type { PaymentNotice } from '../../band/api'
import { openNoticesOf } from '../../band/model'
import { useFlowWords } from '../../flow-words'
import './flow-money.css'

/**
 * owb-of6 step 3 (design plan § 5m; R37: the customer's "I paid" is a NOTICE, it changes nothing owed) — the Money tab's new parts:
 *  - "The customer says it paid": one row per notice (the step, the day, how, the note; the amount only with the price grain) with
 *    Recorded / Dismiss for payments.record. RECORDED does not record a payment: the person then records it with today's
 *    Record a payment… (its fresh code kept). Sales: the same rows in words, no amount, no button.
 *  - "Paid too much" when the order's total went below what is paid (price grain only).
 *  - The Waiting entry on Changes: open notices, a door to Money.
 * Draws its model; fetches nothing (the container reads and answers).
 */

const dayOf = (value: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value)

export function NoticesSection({ notices, may, price, busy, problem, onAnswer }: { readonly notices: readonly PaymentNotice[]; /** payments.record */ readonly may: boolean; /** the price grain */ readonly price: boolean; readonly busy: string | null; readonly problem: string | null; readonly onAnswer?: (noticeId: string, state: 'RECORDED' | 'DISMISSED') => void }) {
  const f = useFlowWords()
  const locale = useLocale()
  const open = openNoticesOf(notices)
  const amountOf = (notice: PaymentNotice): string | null => (price && notice.amount !== undefined ? new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency: notice.currency }).format(notice.amount / 100) : null)
  return (
    <Section id="payment-notices" title={f('notices.title')} answer={open > 0 ? f('notices.open', { count: open }) : f('notices.none')} info={<p>{f('notices.info')}</p>}>
      {problem ? <Banner tone="danger" title={problem === 'notices.failed' ? f('notices.failed') : problem} /> : null}
      <ul className="fw-flow-notices">
        {notices.map((notice) => {
          const amount = amountOf(notice)
          return (
            <li key={notice.id} className="fw-flow-notice">
              <Banknote size={16} aria-hidden />
              <span className="fw-flow-notice-words">
                {f('notices.row', { day: formatDate(dayOf(notice.paidOn), { locale }), step: notice.step?.words ?? f('notices.noStep') })}
                {amount ? ` · ${amount}` : ''}
                {notice.method ? ` · ${notice.method}` : ''}
                {notice.note ? <span className="fw-so-hint"> · {notice.note}</span> : null}
              </span>
              <Tag tone={notice.state === 'OPEN' ? 'warning' : notice.state === 'RECORDED' ? 'success' : 'neutral'}>{f(`notices.state.${notice.state}`)}</Tag>
              {/* A button you may not use is not drawn: only payments.record answers; sales reads the words. */}
              {may && notice.state === 'OPEN' ? (
                <span className="fw-flow-notice-acts">
                  <Button size="sm" variant="secondary" heldReason={busy ? f('notices.busy') : null} onClick={() => onAnswer?.(notice.id, 'RECORDED')}>
                    {f('notices.recorded')}
                  </Button>
                  <Button size="sm" variant="quiet" heldReason={busy ? f('notices.busy') : null} onClick={() => onAnswer?.(notice.id, 'DISMISSED')}>
                    {f('notices.dismiss')}
                  </Button>
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      {may && notices.some((notice) => notice.state === 'RECORDED') ? <p className="fw-pt-quiet">{f('notices.thenRecord')}</p> : null}
    </Section>
  )
}

/** "€ 40,00 is paid too much" — the order's total went below what is paid (price grain only; the amount in minor units). */
export function PaidTooMuch({ over, currency }: { readonly over: number; readonly currency: string }) {
  const f = useFlowWords()
  const locale = useLocale()
  const amount = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency }).format(over / 100)
  return <Banner tone="warning" title={f('money.paidTooMuch', { amount })} />
}

/** The Waiting entry on Changes: "The customer says it paid · 1", a door to Money's notices. */
export function NoticesWaitingRow({ count, href }: { readonly count: number; readonly href: string }) {
  const f = useFlowWords()
  return (
    <div className="fw-oc-grp" role="group" aria-labelledby="fw-oc-g-notices">
      <div className="fw-oc-grp-h">
        <h3 id="fw-oc-g-notices">{f('notices.waiting', { count })}</h3>
      </div>
      <p className="fw-pt-quiet">
        <TabLink className="fw-pt-link" href={href}>
          {f('notices.open', { count })} ›
        </TabLink>
      </p>
    </div>
  )
}
