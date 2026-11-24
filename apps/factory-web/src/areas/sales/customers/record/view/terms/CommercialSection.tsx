'use client'

import type { ReactElement, ReactNode } from 'react'
import Link from 'next/link'
import { Clock, Eye, Lock, Pencil, Truck } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { Facts, Fold } from '../../../../orders/record/money/view/parts'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../orders/record/view/production/Kit'
import { sourceWords, type CompanyRow, type EndedCompanyRow, type Fact } from '../../terms/commercial'
import { said, termsKitId, type Say } from '../../terms/model'
import type { TermsTabActions, TermsTabModel } from '../../terms/tab'
import { actItem, menuOf, useTermsSay } from './say'

/**
 * F-CT-304 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §5.2; 18-lead-settles Z2, Z11, Z21, Z24–Z26, Z29, Z31) —
 * section 2, Commercial terms (#party-commercial): How it pays · Ordering rules · Delivery — three groups that STACK at every room
 * (Z21), their facts Money's own Facts (a fact Money also shows LOOKS the same), their columns joining one at a time by the room — then
 * "With each of our companies" (two or more of our companies): one row per company, where each term comes from, its ⋯ (Set terms
 * for…, Back to the customer's terms…). Head: Change terms… · Change delivery… · ⋯ · ⓘ. The facts are the terms IN FORCE with the
 * company the reader works in (the ONE helper). A read that failed says so where it is used; the rest still draws. Draws its model.
 */

export function CommercialSection({ model, actions }: { model: TermsTabModel; actions?: TermsTabActions | undefined }) {
  const say = useTermsSay()
  const com = model.commercial
  const title = say(said('terms.title'))
  const marked = new Set(model.marked)
  const buttons = [
    ...(com.head.change.shown
      ? [
          <Button key="terms" size="sm" heldReason={com.head.change.held ? say(com.head.change.held) : null} onClick={() => actions?.onChangeTerms?.()}>
            <Pencil size={14} aria-hidden /> {say(said('ct.com.changeTerms'))}
          </Button>,
        ]
      : []),
    ...(com.head.delivery.shown
      ? [
          <Button key="delivery" size="sm" heldReason={com.head.delivery.held ? say(com.head.delivery.held) : null} onClick={() => actions?.onChangeDelivery?.()}>
            <Truck size={14} aria-hidden /> {say(said('ct.com.changeDelivery'))}
          </Button>,
        ]
      : []),
  ]
  const more = menuOf([
    [...com.menu.setFor.map((item) => actItem(`set-${item.companyId}`, said('ct.com.setTermsFor', { params: { company: item.name } }), item.act, say, () => actions?.onCompanyTerms?.(item.companyId))), com.menu.po ? actItem('po', said('ct.com.poAct'), com.menu.po.act, say, () => actions?.onCompanyTerms?.(com.menu.po!.companyId)) : null],
    [com.ended.length > 0 ? { id: 'ended', label: say(com.endedOpen ? said('ct.com.hideEnded') : said('ct.com.endedFold', { params: { count: com.ended.length } })), onSelect: () => actions?.onFold?.('ended', !com.endedOpen) } : null],
    [
      com.menu.library ? { id: 'library', label: say(said('ct.com.library')), href: com.menu.library } : null,
      com.menu.priceList ? { id: 'list', label: say(said('ct.com.priceListDoor', { params: { code: com.menu.priceList.code } })), href: com.menu.priceList.href } : null,
      com.menu.money ? { id: 'money', label: say(said('ct.com.moneyDoor')), href: com.menu.money } : null,
    ],
    [com.menu.history ? { id: 'history', label: say(said('ct.com.history')), href: com.menu.history } : null, { id: 'link', label: say(said('ct.copyLink', { params: { section: title } })), onSelect: () => actions?.onCopyLink?.('party-commercial') }],
  ])
  const head = {
    id: termsKitId('party-commercial'),
    title,
    buttons,
    more: <LineMenuButton label={say(said('ct.more', { params: { section: title } }))} items={more} />,
    info: (
      <>
        <p>{say(said('ct.com.info.what'))}</p>
        <p>{say(said('ct.com.info.companies'))}</p>
        <p>{say(said('ct.com.info.po'))}</p>
        <p>{say(said('ct.com.info.copies'))}</p>
        <p>{say(said('ct.keys'))}</p>
      </>
    ),
  }
  if (com.reading)
    return (
      <Section {...head} answer={say(said('ct.reading'))}>
        <PartReading rows={4} height={30} />
      </Section>
    )
  if (com.problem)
    return (
      <Section {...head}>
        <PartFailed part={say(said('ct.com.part'))} problem={com.problem} onRetry={actions?.onRetryTerms} />
      </Section>
    )
  if (com.blank)
    return (
      <Section {...head} answer={com.answer.map(say).join(' ') /* whole sentences, one after the other (the picture's) */}>
        {null}
      </Section>
    )
  const poExtra = (
    <>
      {com.poChange.shown && com.poCompanyId ? (
        <Button size="sm" variant="link" heldReason={com.poChange.held ? say(com.poChange.held) : null} onClick={() => actions?.onCompanyTerms?.(com.poCompanyId!)}>
          {say(said('ct.com.change'))}
        </Button>
      ) : null}
      {com.poWaiting.length > 0 ? (
        <span className="fw-ctr-wpo">
          {com.poWaiting.map((row) => (
            <span key={row.id} id={row.anchor} className={`fw-ctr-wi${marked.has(row.anchor) ? ' is-mark' : ''}`}>
              <Clock size={13} aria-hidden />
              <Link className="fw-pt-link" href={row.href}>
                {`${say(row.quote)} ›`}
              </Link>
              <span>{say(said('ct.com.waitsForIt'))}</span>
            </span>
          ))}
        </span>
      ) : com.poWaitingCount > 0 ? (
        <span className="fw-ctr-wpo">
          <span className="fw-ctr-wi">
            <Clock size={13} aria-hidden />
            <span>{say(said('ct.com.waitsForCount', { params: { count: com.poWaitingCount } }))}</span>
          </span>
        </span>
      ) : null}
    </>
  )
  return (
    <Section {...head} answer={com.answer.map(say).join(' ') /* whole sentences, one after the other (the picture's) */}>
      <div className="fw-ctr-gw">
        <div className="fw-ctr-grp">
          <div className="fw-ctr-g is-pays">
            <h3 className="fw-pt-h3">{say(said('ct.com.pays'))}</h3>
            <BalancedFacts facts={factsOf(com.pays, say)} />
            {com.noPrice ? (
              <p className="fw-pt-hint">
                <Lock size={13} aria-hidden />
                <span>{say(said('terms.noPrice'))}</span>
              </p>
            ) : null}
          </div>
          <div className="fw-ctr-g is-order">
            <h3 className="fw-pt-h3">{say(said('ct.com.order'))}</h3>
            <BalancedFacts facts={factsOf(com.order, say, { po: poExtra })} />
            {com.companiesProblem ? <PartFailed part={say(said('ct.com.companiesPart'))} problem={com.companiesProblem} onRetry={actions?.onRetryCompanies} /> : null}
          </div>
          <div className="fw-ctr-g is-deliv">
            <h3 className="fw-pt-h3">{say(said('ct.com.delivery'))}</h3>
            <BalancedFacts facts={factsOf(com.delivery, say)} />
            {com.deliveryProblem ? <PartFailed part={say(said('ct.com.carrierPart'))} problem={com.deliveryProblem} onRetry={actions?.onRetryCarrier} /> : com.deliveryReading ? <PartReading rows={1} height={30} /> : null}
          </div>
        </div>
      </div>
      {com.companies ? (
        <div className="fw-pt-blk">
          <h3 className="fw-pt-h3">{say(said('ct.com.companies'))}</h3>
          <CompanyList rows={com.companies} marked={marked} say={say} actions={actions} />
          {com.ended.length > 0 ? (
            <div className="fw-ctr-foldw">
              <Fold open={com.endedOpen} onToggle={() => actions?.onFold?.('ended', !com.endedOpen)} label={say(said('ct.com.endedFold', { params: { count: com.ended.length } }))} />
            </div>
          ) : null}
          {com.endedOpen && com.ended.length > 0 ? <EndedList rows={com.ended} say={say} /> : null}
        </div>
      ) : null}
      <p className="fw-ctr-foot">
        <Eye size={13} aria-hidden />
        <span>{say(com.foot)}</span>
      </p>
    </Section>
  )
}

/** The rules' facts as Money's Facts takes them (label → value; a value may be a door, with its sub-lines and source). */
/**
 * ct-fx3 G-W06 (walk W-06; AAA "no dead space"): Money's facts, unchanged, in a box that says how many they are — terms.css balances the
 * columns by that count (6 → 3 + 3, never 5 + a lone one with a hole), by the box's own room.
 */
export function BalancedFacts({ facts }: { facts: readonly { key: string; label: string; value: ReactNode }[] }): ReactElement {
  return (
    <div className="fw-ctr-fx" data-n={facts.length}>
      <Facts facts={facts} />
    </div>
  )
}

function factsOf(facts: readonly Fact[], say: Say, extra: Readonly<Record<string, ReactNode>> = {}): Array<{ key: string; label: string; value: ReactNode }> {
  return facts.map((fact) => ({ key: fact.key, label: say(fact.label), value: <FactValue fact={fact} say={say} extra={extra[fact.key]} /> }))
}

function FactValue({ fact, say, extra }: { fact: Fact; say: Say; extra?: ReactNode }) {
  const words = say(fact.value)
  return (
    <span className="fw-ctr-val" id={fact.anchor}>
      {fact.href ? (
        <Link className="fw-pt-link" href={fact.href}>
          {words}
        </Link>
      ) : (
        <span className={fact.none ? 'fw-ctr-none' : undefined}>{words}</span>
      )}
      {(fact.subs ?? []).map((sub, at) => (
        <span key={at} className="fw-ctr-sub">
          {say(sub)}
        </span>
      ))}
      {fact.source ? (
        <span className="fw-ctr-src">
          <Tag tone={fact.source.from === 'COMPANY' ? 'info' : 'neutral'}>{say(sourceWords(fact.source))}</Tag>
        </span>
      ) : null}
      {extra}
    </span>
  )
}

function SourceCell({ value, none, source, company, say }: { value: string; none?: boolean; source: 'COMPANY' | 'PARTY'; company: string; say: Say }) {
  return (
    <>
      <span className={none ? 'fw-ctr-none' : undefined}>{value}</span>
      {source === 'COMPANY' ? <Tag tone="info" className="fw-ctr-tag">{say(sourceWords({ from: 'COMPANY', company }))}</Tag> : <span className="fw-ctr-sub">{say(said('ct.com.customerDefault'))}</span>}
    </>
  )
}

function CompanyList({ rows, marked, say, actions }: { rows: readonly CompanyRow[]; marked: ReadonlySet<string>; say: Say; actions?: TermsTabActions | undefined }) {
  return (
    <div className="fw-ctr-ls" role="list" aria-label={say(said('ct.com.companiesList'))}>
      <div className="fw-ctr-hd is-c" aria-hidden>
        <div className="fw-ctr-co">{say(said('sales-customers-depth:hold.col.company'))}</div>
        <div className="fw-ctr-pt">{say(said('termsField.paymentTerms'))}</div>
        <div className="fw-ctr-pl">{say(said('termsField.priceList'))}</div>
        <div className="fw-ctr-dep">{say(said('customer-money:cm.credit.deposit'))}</div>
        <div className="fw-ctr-po">{say(said('ct.com.colPo'))}</div>
        <div className="fw-ctr-o" />
      </div>
      {rows.map((row) => {
        const items: MenuItemDef[] = menuOf([
          [actItem('set', said('ct.com.setTermsFor', { params: { company: row.name } }), row.set, say, () => actions?.onCompanyTerms?.(row.id)), actItem('back', said('ct.co.back'), row.back, say, () => actions?.onBackToCustomer?.(row.id))],
          [{ id: 'link', label: say(said('ct.copyRowLink')), onSelect: () => actions?.onCopyLink?.(row.anchor) }],
        ])
        return (
          <div key={row.id} id={row.anchor} className={`fw-ctr-row is-c${marked.has(row.anchor) ? ' is-mark' : ''}`} role="listitem">
            <div className="fw-ctr-co">
              <span className="fw-ctr-name">
                <b>{row.name}</b>
                {row.current ? <Tag tone="info" className="fw-ctr-tag">{say(said('ct.com.youWork'))}</Tag> : null}
              </span>
              <span className="fw-ctr-sub">{say(row.own && row.changed ? said('ct.com.ownSince', { days: { date: row.changed } }) : said('ct.com.usesCustomer'))}</span>
            </div>
            <div className="fw-ctr-pt">
              <SourceCell value={say(row.paymentTerms.value)} none={row.paymentTerms.none} source={row.paymentTerms.source} company={row.name} say={say} />
            </div>
            <div className="fw-ctr-pl">
              <SourceCell value={say(row.priceList.value)} source={row.priceList.source} company={row.name} say={say} />
            </div>
            <div className="fw-ctr-dep">
              <SourceCell value={say(row.deposit.value)} source={row.deposit.source} company={row.name} say={say} />
            </div>
            <div className="fw-ctr-po">{row.po ? <Tag tone="warning" className="fw-ctr-tag">{say(said('ct.com.poTag'))}</Tag> : <span className="fw-ctr-none">{say(said('ct.com.poNot'))}</span>}</div>
            <div className="fw-ctr-o">
              <LineMenuButton label={say(said('ct.co.more', { params: { company: row.name } }))} items={items} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EndedList({ rows, say }: { rows: readonly EndedCompanyRow[]; say: Say }) {
  return (
    <div className="fw-ctr-ls" role="list" aria-label={say(said('ct.com.endedList'))}>
      {rows.map((row) => (
        <div key={row.id} className="fw-ctr-row is-e" role="listitem">
          <div>
            <span className="fw-ctr-name">
              <b>{row.company}</b>
              <span>{say(said('ct.co.endedTerms', { words: { terms: row.terms, deposit: row.deposit } }))}</span>
              {row.po ? <Tag tone="neutral">{say(said('ct.com.poTag'))}</Tag> : null}
            </span>
            {row.ended ? <span className="fw-ctr-sub">{say(row.by ? said('ct.co.endedOn', { days: { date: row.ended }, params: { name: row.by } }) : said('ct.co.endedOnBare', { days: { date: row.ended } }))}</span> : null}
          </div>
        </div>
      ))}
    </div>
  )
}
