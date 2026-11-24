'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import type { MenuItemDef } from '@nexus/ui/components'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { MoneyAnswer } from '../../../../orders/record/money/view/parts'
import { keepNumbers, sentenceOf } from '../../../../orders/record/money/view/say'
import { word } from '../../../../orders/record/money/word'
import { Section } from '../../../../orders/record/view/production/Kit'
import { statementOf } from '../../../money/model'
import { balanceOf } from '../../money/balance'
import { collectOf, type CollectInPlace, type CollectRow } from '../../money/collect'
import { otherCompanyHref, receivablesHref, workAllOrdersHref } from '../../money/doors'
import { moneyAnswerOf } from '../../money/head'
import { MONEY_TAB_NAMESPACES, type MoneyRead, type MoneyTabInput, type Part } from '../../money/model'
import { kitId, NOTHING_YET, type CustomerMoneySectionId } from '../../money/sections'
import type { DockPick } from '../WorkTab'
import { BalanceSection } from './BalanceSection'
import { CollectSection } from './CollectSection'
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
}

export function CustomerMoneyTab(props: CustomerMoneyTabProps) {
  return (
    <WithMessages namespaces={MONEY_TAB_NAMESPACES}>
      <CustomerMoneyBody {...props} />
    </WithMessages>
  )
}

const stateOf = (part: Part<unknown> | null): string => (!part ? '-' : part.value !== null ? 'v' : part.problem ? 'p' : 'r')

function CustomerMoneyBody({ input, prefix, asOf, onRetry, onPick, onAct }: CustomerMoneyTabProps) {
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
  const partyId = input.party.id

  // ---- the sections drawn, and those with nothing (their quiet lines share ONE card at the foot) ----
  const collectEmpty = !!collect && !collect.reading && !collect.problem && collect.rows.length === 0
  const present = new Set<string>(['balance', ...(collect && !collectEmpty ? ['collect'] : [])])
  const none: { readonly id: CustomerMoneySectionId; readonly title: string; readonly line: string }[] = collectEmpty ? [{ id: 'collect', title: say(word('cm.collect.title')), line: say(word('cm.none.collect')) }] : []

  // ---- the landing: `#<id>` comes into view, and again as each read above it arrives ----
  const landing = [input.ageing, input.openItems, input.refunds, input.stops, input.reminders, input.summary, input.shipped].map(stateOf).join('')
  useEffect(() => {
    const id = typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [landing])

  // ---- the heads' ⋯: doors with this customer chosen, each with its right (cm-w1 stand-ins: Statement ›, Change limit ›) ----
  const receivables: MenuItemDef[] = can.receivables ? [{ id: 'receivables', label: say(word('cm.door.receivables')), href: receivablesHref(prefix, partyId) }] : []
  const balanceMenu: MenuItemDef[] = [
    ...receivables,
    ...(can.receivables && input.company ? [{ id: 'statement', label: say(word('tab.openStatement')), href: statementOf(prefix, partyId, input.company.id, unit) }] : []),
    ...(can.creditLimits ? [{ id: 'changeLimit', label: say(word('tab.changeLimit')), href: receivablesHref(prefix, partyId) }] : []),
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
      <BalanceSection model={balance} present={present} sayIn={sayIn} unit={unit} asOf={asOf} menu={balanceMenu} failed={pageFailed} onRetry={() => onRetry('page')} />
      {collect && present.has('collect') ? (
        <CollectSection model={collect} sayIn={sayIn} unit={unit} companyId={input.company?.id ?? null} menu={receivables} onRetry={() => onRetry('page')} onPick={onPick} onAct={onAct} allOrdersHref={workAllOrdersHref(prefix, partyId)} />
      ) : null}
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
