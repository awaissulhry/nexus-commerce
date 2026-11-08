'use client'

import { Suspense } from 'react'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalBand, usePortalFrame } from '../../shell/frame'
import { AccountPage } from './AccountPage'
import { AccountClosedView } from './view/AccountClosedView'

/**
 * The Account page's route container (B-W2b-196): its catalogue, and a person whose portal or role does not open it (a
 * supplier's or an adviser's portal, a role without the page) is told so in words, with the way back — never an empty page.
 */
export function AccountRoute() {
  return (
    <WithMessages namespaces={['portal', 'portal-account', 'lists']}>
      <Suspense fallback={null}>
        <AccountGate />
      </Suspense>
    </WithMessages>
  )
}

function AccountGate() {
  const frame = usePortalFrame()
  const opens = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.colleagues.view')
  return opens ? <AccountPage /> : <Closed />
}

function Closed() {
  const t = useT('portal-account')
  const frame = usePortalFrame()
  usePortalBand({ title: t('title'), back: { href: frame.prefix, label: t('closed.home') } })
  return <AccountClosedView model={{ homeHref: frame.prefix, admins: (frame.access?.admins ?? []).map((admin) => admin.displayName) }} />
}
