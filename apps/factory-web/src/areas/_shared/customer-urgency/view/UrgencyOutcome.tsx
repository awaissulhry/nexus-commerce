'use client'

import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { UrgencyOutcome as Outcome } from '../model'
import '../../../production/_shared/production.css'

/**
 * F-CW-302 — what a set-back, lock or unlock did, MOVED as it is from the work order's Customer card (F-PR-05b): the orders done by
 * number, each one not done with why (the API's words), the rest counted and never named (PW-10). Words: `production`
 * (`customerCard.urgency.outcome.*`) — the host provides that catalogue.
 */
export function UrgencyOutcome({ outcome, onDismiss }: { outcome: Outcome | null; onDismiss?: () => void }) {
  const t = useT('production')
  const locale = useLocale()
  if (!outcome) return null
  const tone = outcome.notDone.length === 0 ? 'success' : outcome.done.length === 0 ? 'warning' : 'info'
  return (
    <Banner
      tone={tone}
      title={outcome.done.length > 0 ? t(`customerCard.urgency.outcome.${outcome.act}`, { numbers: outcome.done.join(', ') }) : t('customerCard.urgency.outcome.none')}
      action={
        <Button size="sm" variant="quiet" onClick={() => onDismiss?.()}>
          {t('common.dismiss')}
        </Button>
      }
    >
      {outcome.notDone.length > 0 && (
        <ul className="fw-pr-list">
          {outcome.notDone.map((row) => (
            <li key={row.number}>{t('customerCard.urgency.outcome.notDone', { number: row.number, why: row.words ? row.words[locale] : t('customerCard.urgency.outcome.unchanged') })}</li>
          ))}
        </ul>
      )}
      {outcome.notShown > 0 && <p className="fw-pr-hint">{t('customerCard.urgency.outcome.notShown', { count: outcome.notShown })}</p>}
    </Banner>
  )
}
