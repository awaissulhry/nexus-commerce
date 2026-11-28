'use client'

import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalBand, usePortalFrame } from '../../shell/frame'
import { AccountClosedView } from '../account/view/AccountClosedView'
import { PeoplePage } from './PeoplePage'

/**
 * Your people's route container (owb-po4.3): its catalogues, and a person whose portal or role does not open it (a supplier's or an
 * adviser's portal, a role without portal.colleagues.view) is told so in words, with the way back — never an empty page.
 */
export function PeopleRoute() {
  return (
    <WithMessages namespaces={['portal', 'portal-account', 'lists']}>
      <PeopleGate />
    </WithMessages>
  )
}

function PeopleGate() {
  const frame = usePortalFrame()
  const opens = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.colleagues.view')
  return opens ? <PeoplePage /> : <Closed />
}

function Closed() {
  const t = useT('portal-account')
  const frame = usePortalFrame()
  usePortalBand({ title: t('people.title'), back: { href: frame.prefix, label: t('closed.home') } })
  return <AccountClosedView model={{ homeHref: frame.prefix, admins: (frame.access?.admins ?? []).map((admin) => admin.displayName), title: t('people.closed') }} />
}
