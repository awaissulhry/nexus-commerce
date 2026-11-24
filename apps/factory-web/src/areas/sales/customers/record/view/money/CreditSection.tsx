'use client'

import type { CSSProperties } from 'react'
import Link from 'next/link'
import { PauseCircle } from 'lucide-react'
import { ProgressBar, type MenuItemDef } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import { Facts } from '../../../../orders/record/money/view/parts'
import { word } from '../../../../orders/record/money/word'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../orders/record/view/production/Kit'
import type { CreditModel } from '../../money/credit'
import { kitId } from '../../money/sections'
import type { CustomerSay } from '../../money/say'

/**
 * F-CM-301 (customer page › MONEY tab, cm-w3 W3.1; 10-design §5.5) — section 5, Credit & terms (#credit): the hold in force across the
 * section first (Release… — the Terms tab's own window, when its host is there), what waits for credit (a customer with a limit), then
 * Credit | Terms side by side from 900 px of the section: the cells (Limit · Used · Free or Over by), the share of the limit, the overdue
 * part — and the terms with "Edit in Terms & requirements ›". Head: Change limit… / Set a limit… (Finance's one editor, in place;
 * hidden without its right) · ⋯ Put on hold… · Open in Finance › Receivables & credit › · Copy link. Draws its model; reads nothing.
 */
export interface CreditSectionProps {
  readonly model: CreditModel
  readonly sayIn: (currency: string) => CustomerSay
  readonly unit: string
  readonly menu: readonly MenuItemDef[]
  readonly onRetry: () => void
  /** Finance's Change limit window, in place. Absent: not drawn. */
  readonly onChangeLimit?: () => void
  /** The Terms tab's own hold window: put on hold / release (one state with Terms). Absent: not drawn (cm-w3 W3.1 connector). */
  readonly onHold?: (kind: 'place' | 'release') => void
}

export function CreditSection({ model, sayIn, unit, menu, onRetry, onChangeLimit, onHold }: CreditSectionProps) {
  const locale = useLocale()
  const say = sayIn(model.currency || unit)
  const title = say(word('cm.credit.title'))
  const items: MenuItemDef[] = [
    ...(model.mayHold && !model.hold && onHold ? [{ id: 'hold', label: say(word('sales-customers-depth:hold.place')), onSelect: () => onHold('place') }] : []),
    ...menu,
    { id: 'link', label: say(word('cm.linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('credit') },
  ]
  const info = (
    <>
      <p>{say(word('cm.credit.info'))}</p>
      <p>{say(word('cm.keys'))}</p>
    </>
  )
  const buttons = model.change && onChangeLimit ? [<Button key="limit" size="sm" onClick={onChangeLimit}>{say(word(model.change === 'set' ? 'cm.credit.set' : 'tab.changeLimit'))}</Button>] : []
  const head = { id: kitId('credit'), title, info, buttons, more: <LineMenuButton label={say(word('cm.credit.more'))} items={items} /> }
  if (model.reading)
    return (
      <Section {...head} answer={say(word('cm.credit.reading'))}>
        <PartReading rows={3} />
      </Section>
    )
  const pair = model.cells !== null
  return (
    <Section {...head} answer={model.answer.map(say).join(' · ')}>
      <div className="fw-cm-bal">
        {model.problem ? <PartFailed part={say(word('cm.credit.part'))} problem={model.problem} onRetry={onRetry} /> : null}
        {model.hold ? (
          <div className="fw-cm-hold" role="status">
            <PauseCircle size={14} aria-hidden />
            <span>
              <b>{say(word('cm.credit.onHold', { words: { reason: model.hold.reason } }))}</b>
              {model.hold.words ? <span>{model.hold.words}</span> : null}
              <span>{model.hold.since ? say(model.hold.since) : null}</span>
              <span>{say(model.hold.stops)}</span>
            </span>
            {model.mayHold && onHold ? (
              <Button size="sm" onClick={() => onHold('release')}>
                {say(word('sales-customers-depth:hold.release'))}
              </Button>
            ) : null}
          </div>
        ) : null}
        {model.waiting ? (
          <p className="fw-cm-foot">
            <b>{say(word('sales-credit:col.held'))}</b>
            <span>{model.waiting.map(say).join(' · ')}</span>
          </p>
        ) : null}
        <div className={`fw-cm-two${pair ? ' is-pair' : ''}`}>
          {model.cells ? (
            <div>
              <h3 className="fw-pt-h3 fw-cm-h3">{say(word('tab.credit'))}</h3>
              <dl className="fw-cm-cells" style={{ '--n': model.cells.length } as CSSProperties}>
                {model.cells.map((cell) => (
                  <div key={cell.key} className={cell.danger ? 'is-danger' : undefined}>
                    <dt>{say(cell.label)}</dt>
                    <dd>{money(cell.amount, model.currency, locale)}</dd>
                  </div>
                ))}
              </dl>
              {model.usedPct !== null ? (
                <div className="fw-cm-used">
                  <ProgressBar value={model.usedPct} ariaLabel={say(word('sales-credit:row.usedOf', { params: { pct: model.usedPct } }))} />
                  <span>
                    {say(word('sales-credit:row.usedOf', { params: { pct: model.usedPct } }))} · {say(word('cm.credit.usedIs'))}
                  </span>
                </div>
              ) : null}
              {model.overdue ? <p className="fw-cm-foot">{say(model.overdue)}</p> : null}
            </div>
          ) : null}
          <div>
            <h3 className="fw-pt-h3 fw-cm-h3">
              {say(word('cm.credit.terms'))}
              <Link className="fw-pt-link" href={model.termsHref}>
                {`${say(word('tab.editTerms'))} ›`}
              </Link>
            </h3>
            <Facts facts={model.facts.map((fact) => ({ key: fact.key, label: say(fact.label), value: say(fact.value) }))} />
          </div>
        </div>
      </div>
    </Section>
  )
}
