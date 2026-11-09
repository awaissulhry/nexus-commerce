'use client'

import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import '../account.css'

/**
 * One card of an account page (the customer's Account, B-W2b-196; the supplier's Profile, B-W2b-193): its head, a skeleton
 * in its shape while it loads ("Still loading…" after about a second), the problem in our words with Try again when it
 * failed (a failed read is never drawn as empty). Words: `portal-account`.
 */

export type CardState = 'loading' | 'error' | 'ready'

export function AccountCard({ id, title, description, state, slow, failed, onRetry, children, action, footer }: { id: string; title: string; description?: string | undefined; state: CardState; slow?: boolean | undefined; failed?: string | undefined; onRetry?: (() => void) | undefined; children?: ReactNode; action?: ReactNode; footer?: ReactNode }) {
  const t = useT('portal-account')
  return (
    <section id={id} className="fw-pacc-section" aria-labelledby={`${id}-title`}>
      <Card header={<span id={`${id}-title`}>{title}</span>} headingLevel={2} description={description} headerAction={action}>
        {state === 'loading' ? (
          <div className="fw-pacc-loading" role="status" aria-label={t('state.loading')}>
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} height={36} />
            ))}
            {slow ? <span className="fw-pacc-muted">{t('state.slow')}</span> : null}
          </div>
        ) : state === 'error' ? (
          <div className="fw-pacc-failed" role="alert">
            <AlertCircle size={18} aria-hidden />
            <span>{failed ?? t('state.failed')}</span>
            {onRetry ? <Button size="sm" onClick={onRetry}>{t('state.retry')}</Button> : null}
          </div>
        ) : (
          children
        )}
        {state === 'ready' ? footer : null}
      </Card>
    </section>
  )
}
