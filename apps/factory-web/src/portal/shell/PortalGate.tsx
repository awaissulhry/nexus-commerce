'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ServerCrash, UsersRound } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../lib/i18n/provider'
import { signOutPortal } from './api'
import { browserApi } from '../../lib/api/browser'
import { signInHref } from './model'

/**
 * What the portal shows when its frame cannot open (B-W2b-173):
 *  - `sign-in`  no portal session (or the first visit's terms are due): to the sign-in page (B-W2b-164), which brings the
 *               person back here — the WHOLE address, the anchor of a mailed link included (`#task:<id>`), which only
 *               the browser knows;
 *  - `other`    the address names another organisation than the one signed in: its own Home, or sign in again;
 *  - `api`      the API did not answer: try again (the code for support, never the API's words).
 */
export function PortalGate({ kind, code, ownHref }: { kind: 'sign-in' | 'other' | 'api'; code?: string; ownHref?: string }) {
  const t = useT('portal')
  const router = useRouter()
  useEffect(() => {
    if (kind === 'sign-in') window.location.replace(signInHref(`${window.location.pathname}${window.location.search}${window.location.hash}`))
  }, [kind])
  if (kind === 'sign-in') {
    return (
      <main id="main-content" className="fw-pgate" aria-busy="true">
        <p className="fw-pdialog-text">
          <a href={signInHref(null)}>{t('gate.signIn')}</a>
        </p>
      </main>
    )
  }
  if (kind === 'other') {
    return (
      <main id="main-content" className="fw-pgate">
        <EmptyState
          icon={<UsersRound size={28} aria-hidden />}
          title={t('gate.otherTitle')}
          description={t('gate.other')}
          action={
            <>
              {ownHref ? (
                <Button variant="primary" onClick={() => router.push(ownHref)}>
                  {t('gate.ownHome')}
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`
                  void signOutPortal(browserApi())
                    .catch(() => undefined)
                    .finally(() => window.location.assign(signInHref(next)))
                }}
              >
                {t('gate.switch')}
              </Button>
            </>
          }
        />
      </main>
    )
  }
  return (
    <main id="main-content" className="fw-pgate">
      <EmptyState icon={<ServerCrash size={28} aria-hidden />} title={t('gate.apiTitle')} description={t('gate.api', { code: code ?? '—' })} action={<Button onClick={() => router.refresh()}>{t('state.retry')}</Button>} />
    </main>
  )
}
