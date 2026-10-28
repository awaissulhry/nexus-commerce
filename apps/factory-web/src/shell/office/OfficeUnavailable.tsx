'use client'

import { useRouter } from 'next/navigation'
import { ServerCrash, ShieldOff } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../lib/i18n/provider'

/**
 * What the office shows when it cannot open: the API did not answer (try again), or the person may not work in the
 * company the address names (go to their own). The code is shown for support, never a message from the API.
 */
export function OfficeUnavailable({ code, ownCompanyHref }: { code: string; ownCompanyHref?: string | null }) {
  const t = useT('shell')
  const router = useRouter()
  const forbidden = code === 'forbidden'
  return (
    <main id="main-content" className="fw-office-unavailable">
      <EmptyState
        icon={forbidden ? <ShieldOff size={28} aria-hidden /> : <ServerCrash size={28} aria-hidden />}
        title={t(forbidden ? 'unavailable.forbidden.title' : 'unavailable.api.title')}
        description={forbidden ? t('unavailable.forbidden.body') : t('unavailable.api.body', { code })}
        action={
          forbidden && ownCompanyHref ? (
            <Button variant="primary" onClick={() => router.push(ownCompanyHref)}>
              {t('unavailable.forbidden.action')}
            </Button>
          ) : (
            <Button onClick={() => router.refresh()}>{t('unavailable.api.action')}</Button>
          )
        }
      />
    </main>
  )
}
