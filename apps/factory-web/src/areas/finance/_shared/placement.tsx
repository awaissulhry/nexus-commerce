'use client'

import { EmptyState } from '@nexus/ui/components'
import { Button, Checkbox, Input, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { OpenItem } from './api'
import { amountText, dayInstant, itemLabel, leftToPlace, money, parseAmount, placementProblems, suggestPlacement } from './model'

/**
 * Where a payment goes (the design's "NEW MatchPanel", composed): the customer's open deposit requests and invoices,
 * oldest first, each with what it still asks; tick an item or type an amount; "Suggest" fills oldest first; what is left
 * to place is always in view. The typed amounts are text (the person's own way of writing them) until they are sent.
 */
export function Placement({
  items,
  problem,
  amount,
  currency,
  typed,
  setTyped,
  onRetry,
  price,
}: {
  items: readonly OpenItem[] | null
  problem: string | null
  amount: number
  currency: string
  typed: Record<string, string>
  setTyped: (next: Record<string, string>) => void
  onRetry?: () => void
  price: boolean
}) {
  const t = useT('finance')
  const locale = useLocale()
  if (problem)
    return (
      <EmptyState
        title={t('match.failed')}
        description={t(problem)}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          ) : undefined
        }
      />
    )
  if (!items)
    return (
      <p className="fw-fin-hint" role="status">
        <Spinner size={12} /> {t('match.loading')}
      </p>
    )
  if (items.length === 0) return <EmptyState title={t('match.none.title')} description={t('match.none.body')} />
  const plan = planOf(typed)
  const left = leftToPlace(amount, plan)
  const problems = placementProblems(items, plan, amount)
  return (
    <div className="fw-fin-stack-tight">
      <div className="fw-fin-left" role="status" aria-live="polite">
        <span>{t('match.left')}</span>
        <b>{price ? money(left, currency, locale) : '—'}</b>
        <Button
          size="sm"
          variant="link"
          onClick={() => {
            const suggested = suggestPlacement(items, amount)
            setTyped(Object.fromEntries(Object.entries(suggested).map(([id, value]) => [id, amountText(value, locale)])))
          }}
        >
          {t('match.suggest')}
        </Button>
      </div>
      {problems.total && <p className="fw-fin-hint">{t(problems.total)}</p>}
      <ol className="fw-fin-rows" aria-label={t('match.label')}>
        {items.map((item) => {
          const label = itemLabel(item)
          const on = typed[item.id] !== undefined
          return (
            <li key={item.id} className="fw-fin-row is-item">
              <Checkbox
                checked={on}
                onChange={(event) => {
                  const next = { ...typed }
                  if (event.target.checked) next[item.id] = amountText(Math.max(0, Math.min(item.openAmount ?? 0, Math.max(left, 0))) || (item.openAmount ?? 0), locale)
                  else delete next[item.id]
                  setTyped(next)
                }}
                label={
                  <span className="fw-fin-stack-tight">
                    <span>{t(label.key, label.params)}</span>
                    <span className="fw-fin-cell-sub">
                      {t(`${item.target === 'INVOICE' ? 'match.invoiceSub' : 'match.depositSub'}${item.dueDate ? '' : 'NoDue'}`, { date: formatDate(dayInstant(item.date), { locale }), due: item.dueDate ? formatDate(dayInstant(item.dueDate), { locale }) : '', open: price ? money(item.openAmount, item.currency, locale) : '—' })}
                    </span>
                  </span>
                }
              />
              {on && (
                <Input
                  size="sm"
                  inputMode="decimal"
                  aria-label={t('match.amountFor', { item: t(label.key, label.params) })}
                  value={typed[item.id]}
                  onChange={(event) => setTyped({ ...typed, [item.id]: event.target.value })}
                  aria-invalid={problems.items[item.id] ? true : undefined}
                />
              )}
              {on && problems.items[item.id] && <span className="fw-fin-cell-sub">{t(problems.items[item.id]!)}</span>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** The typed amounts as minor units (an empty or wrong one counts as 0: its own problem says so). */
export function planOf(typed: Readonly<Record<string, string>>): Record<string, number> {
  return Object.fromEntries(Object.entries(typed).map(([id, text]) => [id, parseAmount(text) ?? 0]))
}
