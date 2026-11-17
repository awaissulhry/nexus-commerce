'use client'

import { Banner, KeyValue, type KeyValueItem } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import type { ImpactView } from '../ask-model'
import { useOrderWords } from '../words'
import { Loading, ReadFailed } from './parts'

/**
 * F-PR-13 — "What it means" before Send (production plan §3: "Before Send it sees: what is frozen, priced or not, earliest date";
 * 06-tree B.2 P-ORD-ask step 3; wall PW-P06): the headline in our words, what the freeze rules hold of what is asked (the API's
 * words, its own lines only), the cost (an amount only for a price role; others read "A price may apply"), the earliest date
 * (an estimate, a date only), what the kind may do to the date, and — for a change of sizes or quantities — that after we release
 * a line a size change means we cancel it and make it again. Drawn in the Ask dialog, the change and the cancel pop-ups alike.
 */

export interface AskImpactModel {
  state: 'loading' | 'error' | 'ready'
  view: ImpactView | null
}

export function AskImpact({ model, onRetry }: { model: AskImpactModel; onRetry?: () => void }) {
  const { t, locale, day } = useOrderWords()
  if (model.state === 'loading') return <Loading rows={2} height={40} />
  if (model.state === 'error' || !model.view) return <ReadFailed title={t('ask.impact.failed')} onRetry={onRetry} />
  const view = model.view
  const items: KeyValueItem[] = [
    { label: t('ask.impact.cost'), value: t(view.cost.key, view.cost.params) },
    ...(view.earliest
      ? [{ label: t('ask.impact.earliestLabel'), value: [t(view.earliest.key, view.earliest.date ? { date: day(view.earliest.date) } : undefined), ...(view.earliest.partial ? [t('ask.impact.partial')] : [])].join(' ') }]
      : []),
  ]
  return (
    <section className="fw-pord-stack" aria-label={t('ask.impact.title')}>
      <h3 className="fw-pord-h3">{t('ask.impact.title')}</h3>
      <Banner tone={view.headline.tone} title={t(view.headline.key)} />
      {view.frozen.length > 0 ? (
        <ul className="fw-pord-requests" aria-label={t('ask.impact.frozenLabel')}>
          {view.frozen.map((item, index) => (
            <li key={index} className="fw-pord-request-head">
              <Pill tone={item.blocked ? 'danger' : 'warning'}>{t(item.blocked ? 'ask.impact.state.BLOCKED' : 'ask.impact.state.CHANGE_REQUEST')}</Pill>
              <span>{item.words[locale]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <KeyValue labelCase="sentence" items={items} />
      {view.notes.map((key) => (
        <p key={key} className="fw-pord-sub">
          {t(key)}
        </p>
      ))}
      {view.afterRelease ? <p className="fw-pord-strong">{t('ask.impact.afterRelease')}</p> : null}
    </section>
  )
}
