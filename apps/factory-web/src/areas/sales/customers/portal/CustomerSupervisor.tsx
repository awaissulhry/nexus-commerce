'use client'

import { useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { useCustomerSupervisor } from './limits/use-limits'
import type { PortalNotice } from './model'
import { CustomerSupervisorCard } from './view/CustomerSupervisorCard'

/**
 * F-SA-272 — "Who looks after <customer>"'s container on the customer's Overview (end check: a view fetches nothing): the card's reads
 * and its Apply (limits/use-limits.ts useCustomerSupervisor), live on its supervisor's change; the card (view/CustomerSupervisorCard)
 * draws what it is given. Read with partners.view, changed with production.brand.manage.
 */
export function CustomerSupervisor({ partyId, name }: { partyId: string; name: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const enabled = session.permissions.includes('partners.view')
  const [notice, setNotice] = useState<PortalNotice | null>(null)
  const supervisor = useCustomerSupervisor({ api, partyId, enabled, supervise: session.permissions.includes('production.brand.manage'), onNotice: setNotice })
  useLiveBus({ onChange: supervisor.onLive }, enabled)
  if (!supervisor.model) return null
  return <CustomerSupervisorCard model={supervisor.model} actions={supervisor.actions} name={name} notice={notice} onDismissNotice={() => setNotice(null)} />
}
