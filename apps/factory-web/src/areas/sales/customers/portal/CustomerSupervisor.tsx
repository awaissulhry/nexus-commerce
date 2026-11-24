'use client'

import { useMemo } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { useCustomerSupervisor } from './limits/use-limits'
import { useFactoryDesigner } from './designer/use-factory-designer' // F-CP-155
import type { DesignerActions, DesignerModel } from './designer/model'
import type { SupervisorActions, SupervisorModel } from './limits/model'

/**
 * F-SA-272 → F-CO-201 (customer page › Overview, co-w2 W2.1; 13-backend §3.6; lead settle S10) — "Who looks after <customer>": the
 * customer's production read (its supervisor, its backup and its urgency, limits/use-limits.ts useCustomerSupervisor) and the factory
 * designer's slot (F-CP-155, designer/use-factory-designer.ts), read ONCE for the Overview: People's rows and their two Change…
 * windows, and the urgency strip. Read with partners.view (null without: never asked); the supervisor changed with
 * production.brand.manage, the designer with partners.manage over every company the customer works with (no step-up). Live on its
 * supervisor's change. A hook: the Overview's container calls it, its view draws what it is given (a view fetches nothing).
 */
export interface WhoLooksAfter {
  readonly supervisor: { readonly model: SupervisorModel; readonly actions: SupervisorActions } | null
  readonly designer: { readonly model: DesignerModel; readonly actions: DesignerActions } | null
}

export function useWhoLooksAfter(partyId: string): WhoLooksAfter {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const enabled = session.permissions.includes('partners.view')
  const supervisor = useCustomerSupervisor({ api, partyId, enabled, supervise: session.permissions.includes('production.brand.manage') })
  const designer = useFactoryDesigner({ api, partyId, enabled, manage: session.permissions.includes('partners.manage') }) // F-CP-155
  useLiveBus({ onChange: supervisor.onLive }, enabled)
  return useMemo(
    () => ({
      supervisor: supervisor.model ? { model: supervisor.model, actions: supervisor.actions } : null,
      designer: designer.model ? { model: designer.model, actions: designer.actions } : null,
    }),
    [supervisor.model, supervisor.actions, designer.model, designer.actions],
  )
}
