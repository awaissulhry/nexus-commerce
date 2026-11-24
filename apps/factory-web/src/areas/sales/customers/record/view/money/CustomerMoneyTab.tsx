'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import type { MenuItemDef } from '@nexus/ui/components'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { MoneyAnswer } from '../../../../orders/record/money/view/parts'
import { keepNumbers, sentenceOf } from '../../../../orders/record/money/view/say'
import { word } from '../../../../orders/record/money/word'
import { Section } from '../../../../orders/record/view/production/Kit'
import { balanceOf } from '../../money/balance'
import { collectOf, type CollectInPlace, type CollectRow } from '../../money/collect'
import { documentsOf, type DocumentChip, type DocumentsRead } from '../../money/documents' // F-CM-202
import { otherCompanyHref, receivablesHref, recordPaymentForCustomerHref, workAllOrdersHref } from '../../money/doors'
import { moneyAnswerOf } from '../../money/head'
import { MONEY_TAB_NAMESPACES, type LazyRead, type MoneyRead, type MoneyTabInput, type Part } from '../../money/model'
import { kitId, NOTHING_YET, type CustomerMoneySectionId } from '../../money/sections'
import type { DockPick } from '../WorkTab'
import { BalanceSection } from './BalanceSection'
import { CollectSection } from './CollectSection'
import { DocumentsSection } from './DocumentsSection' // F-CM-202
import { ReceivedSection } from './ReceivedSection' // F-CM-203
import { receivedOf, type GiveBackMove, type PaymentsRead } from '../../money/received' // F-CM-203
import type { CreditBalanceRead } from '../../money/api' // F-CM-203
import type { Refund } from '../../../../../finance/payments/refunds/api' // F-CM-203
import { creditOf } from '../../money/credit' // F-CM-301
import { chaseOf, type StopRow } from '../../money/chase' // F-CM-302
import { marginOf, priceCheckOf } from '../../money/worth' // F-CM-303
import type { LimitRow } from '../../../../../finance/receivables/credit/api' // F-CM-301
import type { CommercialTerms } from '../../../terms/api' // F-CM-301
import type { ReceivablesSettings } from '../../../../../finance/receivables/api' // F-CM-302
import type { CustomerTrust } from '../../../../../finance/receivables/reminder-stops/api' // F-CM-302
import type { OrderRow } from '../../../../orders/api' // F-CM-303
import type { Margins } from '../../../../../finance/margins/api' // F-CM-303
import { CreditSection } from './CreditSection' // F-CM-301
import { ChaseSection } from './ChaseSection' // F-CM-302
import { PriceCheckSection } from './PriceCheckSection' // F-CM-303
import { MarginSection } from './MarginSection' // F-CM-303
import { useSayIn } from './say'
import '../../../../orders/record/money/view/money.css'
import './customer-money.css'

/**
 * F-CM-101 (customer page › MONEY tab, 10-design §1; 18-lead-settles Z18) — the tab's LAYOUT, and only that. Its root is the Production
 * kit's size container with the order Money's own class and ours (`fw-pt fw-om fw-cm`: every section chooses by the ROOM the tab has,
 * never the screen, so the thread dock re-lays it at once). Under the tab's ONE answer (the shared MoneyAnswer: the money wall said
 * once), the sections STACK at every room: Balance (#balance) · To collect (#collect) — the next sections join in cm-w2 and cm-w3 —
 * and the sections with nothing share ONE card at the foot ("Nothing here yet"; one alone keeps its own one-line section). A section
 * without its right is LEFT OUT. The address `#<id>` lands, and lands again as each read above it arrives (the order page's own way).
 * Draws its models (money/*.ts); reads nothing.
 */

export interface CustomerMoneyTabProps {
  readonly input: MoneyTabInput
  /** `/w/<company>`: every door names this customer. */
  readonly prefix: string
  /** When the server counted the ageing ("Counts as of 10:44"). */
  readonly asOf: string | null
  /** A section's Try again: the page's money reads, or one of the tab's own. */
  readonly onRetry: (read: MoneyRead) => void
  /** Show in the thread: the row's order docks beside the tab. */
  readonly onPick?: (pick: DockPick) => void
  /** cm-w2: an act in place on a To-collect row (the order's own windows through the money door). */
  readonly onAct?: (act: CollectInPlace, row: CollectRow) => void
  /** F-CM-202: the reads made when their section nears the room, and their controls. */
  readonly lazy?: LazyParts
}

/** F-CM-202: the lazy reads the container hands (null: no right). */
export interface LazyParts {
  readonly want: (read: LazyRead) => void
  readonly documents: Part<DocumentsRead> | null
  readonly chip: DocumentChip
  readonly onChip: (chip: DocumentChip) => void
  readonly onMoreDocuments: () => void
  // ── F-CM-203: Payments & refunds ──
  readonly payments: Part<PaymentsRead> | null
  readonly credit: Part<CreditBalanceRead> | null
  readonly refundsMade: Part<readonly Refund[]> | null
  readonly onMorePayments: () => void
  /** Finance's Refund… window (on a credit note's or a payment's id; null: chosen in it). */
  readonly onRefund?: (start: string | null) => void
  /** Finance's Mark made… / Cancel… / Void… window. */
  readonly onMoveRefund?: (refund: Refund, move: GiveBackMove) => void
  // ── F-CM-301…303: the account's sections, and the owners' windows they open in place ──
  readonly creditRow: Part<LimitRow | null> | null
  readonly terms: Part<CommercialTerms> | null
  readonly trust: Part<CustomerTrust> | null
  readonly settings: Part<ReceivablesSettings> | null
  readonly priceRows: Part<readonly OrderRow[]> | null
  readonly margin: Part<Margins> | null
  /** Finance's Change limit / Set a limit window (on the S2 row, or none). */
  readonly onChangeLimit?: (row: LimitRow | null) => void
  /** The Terms tab's own hold window: Put on hold… / Release… (the one hold in force); absent: not drawn. */
  readonly onPlaceHold?: () => void
  readonly onReleaseHold?: () => void
  /** Finance's statement window (sending: its Send step). */
  readonly onStatement?: (sending: boolean) => void
  /** Finance's stop container on a stop's invoice (Lift…). */
  readonly onLift?: (stop: StopRow) => void
}

/** The sections whose read is made when they near the room: their id → their read. */
const LAZY_OF: Readonly<Record<string, LazyRead>> = { invoices: 'documents', received: 'received' /* F-CM-203 */, credit: 'credit', statement: 'statement', 'price-check': 'priceRows', margin: 'margin' /* F-CM-301…303 */ }

export function CustomerMoneyTab(props: CustomerMoneyTabProps) {
  return (
    <WithMessages namespaces={MONEY_TAB_NAMESPACES}>
      <CustomerMoneyBody {...props} />
    </WithMessages>
  )
}

/** A read not handed yet (a design case without it) is still reading. */
const READING_PART: Part<never> = { value: null, problem: null }

const stateOf = (part: Part<unknown> | null): string => (!part ? '-' : part.value !== null ? 'v' : part.problem ? 'p' : 'r')

function CustomerMoneyBody({ input, prefix, asOf, onRetry, onPick, onAct, lazy }: CustomerMoneyTabProps) {
  const sayIn = useSayIn()
  const unit = input.party.currency ?? 'EUR'
  const say = sayIn(unit)
  const can = input.can
  const price = can.price
  const priceDiffer = input.priceDiffer
  // F-CP-141 → F-CM-104: the line only for a price holder, and only when an order's prices differ (0, reading or failed: no line).
  const differ = price && can.orders && priceDiffer !== null && priceDiffer > 0 ? priceDiffer : null
  const ruled: MoneyTabInput = { ...input, priceDiffer: differ }
  const answer = moneyAnswerOf(ruled)
  const balance = balanceOf(ruled, prefix)
  const collect = collectOf(ruled, prefix)
  const chip = lazy?.chip ?? 'all'
  const documents = documentsOf(ruled, lazy?.documents ?? null, chip, prefix) // F-CM-202
  const received = receivedOf(ruled, lazy?.payments ?? null, lazy?.credit ?? null, prefix) // F-CM-203
  const credit = creditOf(ruled, lazy?.creditRow ?? null, lazy?.terms ?? READING_PART, prefix) // F-CM-301
  // F-CM-302: Statement… only when there is something to state (a document or a payment) and only with the price grain (in the rule).
  const hasDocuments = (input.ageing?.value ?? []).some((row) => row.invoices > 0) || (lazy?.documents?.value?.rows.length ?? 0) > 0 || (lazy?.payments?.value?.rows.length ?? 0) > 0
  const chase = chaseOf(ruled, lazy?.trust ?? null, lazy?.settings ?? null, prefix, hasDocuments)
  const priceCheck = priceCheckOf(ruled, lazy?.priceRows ?? null, prefix) // F-CM-303
  const margin = marginOf(ruled, lazy?.margin ?? READING_PART, prefix) // F-CM-303
  const partyId = input.party.id

  // ---- the sections drawn, and those with nothing (their quiet lines share ONE card at the foot) ----
  const collectEmpty = !!collect && !collect.reading && !collect.problem && collect.rows.length === 0
  // F-CM-202: Invoices with nothing goes to the foot only under "All" (a chip with nothing keeps its section, so the chips stay).
  const documentsEmpty = !!documents && !documents.reading && !documents.problem && documents.rows.length === 0 && chip === 'all'
  // F-CM-203: Payments & refunds with nothing at all (no payment, nothing on account, nothing to give back) goes to the foot.
  const receivedEmpty = !!received && !received.reading && !received.problem && received.payments.length === 0 && received.onAccount.length === 0 && received.giveBack.length === 0
  // F-CM-302…303: nothing to list (and no Statement… to offer), no price to compare, no order to count — each a line at the foot.
  // The account's sections are drawn by the container (its lazy reads); a design case without them draws none of them.
  const account = !!lazy
  const chaseEmpty = account && !!chase && !chase.reading && !chase.problem && chase.reminders.length === 0 && chase.stops.length === 0 && !chase.off && !chase.statement
  const priceEmpty = account && !!priceCheck && !priceCheck.differ && !priceCheck.missing && !priceCheck.calm
  const marginEmpty = account && !!margin && !margin.reading && !margin.problem && !margin.tiles && !margin.below && !margin.twoCurrencies
  const present = new Set<string>([
    'balance',
    ...(collect && !collectEmpty ? ['collect'] : []),
    ...(documents && !documentsEmpty ? ['invoices'] : []),
    ...(received && !receivedEmpty ? ['received', ...(received.onAccount.length > 0 ? ['on-account'] : []), ...(received.giveBack.length > 0 ? ['give-back'] : [])] : []),
    ...(account ? ['credit'] : []),
    ...(account && chase && !chaseEmpty ? ['statement'] : []),
    ...(account && priceCheck && !priceEmpty ? ['price-check'] : []),
    ...(account && margin && !marginEmpty ? ['margin'] : []),
  ])
  const none: { readonly id: CustomerMoneySectionId; readonly title: string; readonly line: string }[] = [
    ...(collectEmpty ? [{ id: 'collect' as const, title: say(word('cm.collect.title')), line: say(word('cm.none.collect')) }] : []),
    ...(documentsEmpty ? [{ id: 'invoices' as const, title: say(word('orders:moneyTab.invoices.title')), line: say(word('cm.none.invoices')) }] : []),
    ...(receivedEmpty ? [{ id: 'received' as const, title: say(word('cm.received.title')), line: say(word('cm.none.received')) }] : []),
    ...(chaseEmpty ? [{ id: 'statement' as const, title: say(word('cm.chase.title')), line: say(word('cm.none.statement')) }] : []),
    ...(priceEmpty ? [{ id: 'price-check' as const, title: say(word('orders:moneyTab.price.title')), line: say(word('cm.none.priceCheck')) }] : []),
    ...(marginEmpty ? [{ id: 'margin' as const, title: say(word('cm.margin.title')), line: say(word('cm.none.margin')) }] : []),
  ]

  // ---- the landing: `#<id>` comes into view, and again as each read above it arrives ----
  const landing = [input.ageing, input.openItems, input.refunds, input.stops, input.reminders, input.summary, input.shipped, lazy?.documents ?? null, lazy?.payments ?? null, lazy?.terms ?? null, lazy?.priceRows ?? null].map(stateOf).join('')
  useEffect(() => {
    const id = typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [landing])

  // ---- F-CM-202: a lazy section's read is made when it nears the room (600 px ahead); without an observer, at once ----
  const want = lazy?.want
  const lazyIds = [...present].filter((id) => LAZY_OF[id]).join(',')
  useEffect(() => {
    if (!want || !lazyIds) return
    const ids = lazyIds.split(',')
    if (typeof IntersectionObserver === 'undefined') {
      for (const id of ids) want(LAZY_OF[id]!)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting && LAZY_OF[entry.target.id]) want(LAZY_OF[entry.target.id]!)
    }, { rootMargin: '600px 0px' })
    for (const id of ids) {
      const element = document.getElementById(id)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [want, lazyIds])

  // ---- the heads' ⋯: doors with this customer chosen, each with its right (F-CM-301/302: the cm-w1 stand-ins went — Statement… and
  // Change limit… open in place now) ----
  const receivables: MenuItemDef[] = can.receivables ? [{ id: 'receivables', label: say(word('cm.door.receivables')), href: receivablesHref(prefix, partyId) }] : []
  const onStatement = lazy?.onStatement
  const balanceMenu: MenuItemDef[] = [
    ...(chase?.statement && can.statementsSend && onStatement ? [{ id: 'send', label: say(word('cm.chase.sendStatement')), onSelect: () => onStatement(true) }] : []),
    ...receivables,
  ]
  const creditMenu: MenuItemDef[] = can.receivables || can.credit ? [{ id: 'receivables', label: say(word('cm.door.receivables')), href: receivablesHref(prefix, partyId) }] : []
  // F-CM-302: Their figures (Finance › Bank: no customer term there — it opens on a new comparison) · Ri.Ba. · Receivables & credit.
  const chaseMenu: MenuItemDef[] = [
    { id: 'figures', label: say(word('cm.chase.theirFigures')), href: `${prefix}/finance/bank?figures=new` },
    { id: 'riba', label: say(word('cm.chase.riba')), href: `${prefix}/finance/payments?rows=ribaUnpaid` },
    ...receivables,
  ]
  // F-CM-202: Finance's Invoices list (the whole list, as the order page's door: a customer-chosen address is LATER).
  const invoicesMenu: MenuItemDef[] = [{ id: 'finance', label: say(word('cm.door.invoices')), href: `${prefix}/finance/invoices` }]
  // F-CM-203: Finance › Payments and its Refunds view (the whole lists; a customer-chosen address is LATER).
  const receivedMenu: MenuItemDef[] = [
    { id: 'payments', label: say(word('cm.door.payments')), href: `${prefix}/finance/payments` },
    { id: 'refunds', label: say(word('cm.door.refunds')), href: `${prefix}/finance/payments?rows=refunds` },
  ]
  const pageFailed = input.ageing?.problem ?? input.openItems?.problem ?? null

  // ---- the answer line: one sentence per currency; under it, quiet, the company and another company's line ----
  const title = (
    <span className="fw-cm-ans">
      {answer.reading ? <span className="fw-cm-al">{sentenceOf([say(word('orders:moneyTab.head.reading'))])}</span> : null}
      {answer.lines.map((line) => {
        const sayLine = sayIn(line.currency ?? unit)
        return (
          <span key={line.currency ?? 'one'} className="fw-cm-al">
            {line.currency ? (
              <>
                <b>{line.currency}</b>
                {' · '}
              </>
            ) : null}
            {keepNumbers(sentenceOf(line.parts.map(sayLine)))}
          </span>
        )
      })}
      {answer.nothing ? <span className="fw-cm-al">{sentenceOf([say(answer.nothing)])}</span> : null}
      {answer.company || answer.elsewhere.length > 0 ? (
        <span className="fw-pt-sub">
          {answer.company ? sentenceOf([say(answer.company)]) : null}
          {answer.elsewhere.map((also) => (
            <span key={also.company.id} className="fw-cm-also">
              {' '}
              {sentenceOf([say(also.words)])}{' '}
              <Link className="fw-pt-link" href={otherCompanyHref(also.company.code, partyId)}>
                {say(also.door)}
              </Link>
            </span>
          ))}
        </span>
      ) : null}
      {answer.failed ? <span className="fw-pt-sub">{say(answer.failed)}</span> : null}
    </span>
  )

  return (
    <div className="fw-pt fw-om fw-cm">
      <MoneyAnswer tone={answer.tone} reading={answer.reading} title={title} below={answer.wall.map(say)} />
      <BalanceSection model={balance} present={present} sayIn={sayIn} unit={unit} asOf={asOf} menu={balanceMenu} failed={pageFailed} onRetry={() => onRetry('page')} recordPaymentHref={can.paymentsRecord && can.price ? recordPaymentForCustomerHref(prefix, partyId) : null /* F-CM-204 */} {...(chase?.statement && onStatement ? { onStatement: () => onStatement(false) } : {}) /* F-CM-302 */} />
      {collect && present.has('collect') ? (
        <CollectSection model={collect} sayIn={sayIn} unit={unit} companyId={input.company?.id ?? null} menu={receivables} onRetry={() => onRetry('page')} onPick={onPick} onAct={onAct} allOrdersHref={workAllOrdersHref(prefix, partyId)} />
      ) : null}
      {documents && lazy && present.has('invoices') ? (
        <DocumentsSection model={documents} price={can.price} chip={chip} onChip={lazy.onChip} onMore={lazy.onMoreDocuments} sayIn={sayIn} unit={unit} companyId={input.company?.id ?? null} menu={invoicesMenu} onRetry={() => onRetry('documents')} onPick={onPick} />
      ) : null}
      {received && lazy && present.has('received') ? (
        <ReceivedSection
          model={received}
          input={ruled}
          made={lazy.refundsMade}
          sayIn={sayIn}
          unit={unit}
          menu={receivedMenu}
          onRetry={() => onRetry('received')}
          onRetryMade={() => onRetry('refundsMade')}
          onFold={() => lazy.want('refundsMade')}
          onMorePayments={lazy.onMorePayments}
          onRefund={lazy.onRefund}
          onMove={lazy.onMoveRefund}
        />
      ) : null}
      {/* F-CM-301…303: the account — Credit & terms, Statement & reminders, Price check, Margin & cost */}
      {lazy && present.has('credit') ? (
        <CreditSection model={credit} sayIn={sayIn} unit={unit} menu={creditMenu} onRetry={() => onRetry('credit')} {...(lazy.onChangeLimit ? { onChangeLimit: () => lazy.onChangeLimit!(lazy.creditRow?.value ?? null) } : {})} {...(lazy.onPlaceHold ? { onPlaceHold: lazy.onPlaceHold } : {})} {...(lazy.onReleaseHold ? { onReleaseHold: lazy.onReleaseHold } : {})} />
      ) : null}
      {chase && lazy && present.has('statement') ? <ChaseSection model={chase} sayIn={sayIn} unit={unit} menu={chaseMenu} onRetry={() => onRetry('statement')} {...(onStatement ? { onStatement: () => onStatement(false) } : {})} {...(lazy.onLift ? { onLift: lazy.onLift } : {})} /> : null}
      {priceCheck && lazy && present.has('price-check') ? <PriceCheckSection model={priceCheck} sayIn={sayIn} unit={unit} onRetry={() => onRetry('priceRows')} /> : null}
      {margin && lazy && present.has('margin') ? <MarginSection model={margin} sayIn={sayIn} unit={unit} onRetry={() => onRetry('margin')} /> : null}
      {none.length === 1 ? (
        <Section id={kitId(none[0]!.id)} title={none[0]!.title} answer={none[0]!.line}>
          {null}
        </Section>
      ) : none.length > 1 ? (
        <Section id={kitId(NOTHING_YET)} title={say(word('cm.none.title'))}>
          <ul className="fw-cm-none">
            {none.map((entry) => (
              <li key={entry.id} id={entry.id}>
                <b>{entry.title}</b>
                <span>{entry.line}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}
