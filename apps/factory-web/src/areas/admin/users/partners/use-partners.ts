'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveBus } from '../../../../shell/live/use-live'
import type { User } from '../../shared/api'
import type { Loaded } from '../../shared/model'
import { isStepUpCancelled } from '../../shared/step-up'
import type { PortalNotice } from '../../../sales/customers/portal/model'
import { changePartnerStatus, listOrganisations, type Organisations, type PersonAction } from './api'
import { partnerCan, partnerProblem, partnersCountChange, type PartnerTile } from './model'
import type { PartnersAudienceActions, PartnersAudienceModel } from './view/PartnersPeople'

/**
 * Admin › Users "Partners" (B-W2b-180), the container part the Users page mounts: reads the partner organisations and their
 * counts (`GET /partners`, partners.view) beside the page's own people read (whose PARTNER rows it is given), keeps the
 * Partners tile, page and selection, and runs a bulk action as one partner-route call per person
 * (`POST /partners/:partyId/people/:userId/suspend|reactivate|deactivate`: the organisation's seats count once) behind the
 * page's step-up. Live: a partner event reads the counts and the people again.
 */
export function usePartnersAudience({
  api,
  permissions,
  prefix,
  users,
  query,
  guard,
  reload,
}: {
  api: ApiClient
  permissions: readonly string[]
  prefix: string
  users: Loaded<User>
  query: string
  guard: <T>(sentence: string, work: () => Promise<T>) => Promise<T>
  reload: () => void
}): { model: PartnersAudienceModel | null; actions: PartnersAudienceActions } {
  const can = useMemo(() => partnerCan(permissions), [permissions])
  const [organisations, setOrganisations] = useState<{ value: Organisations | null; problem: string | null }>({ value: null, problem: null })
  const [tile, setTile] = useState<PartnerTile | null>(null)
  const [pages, setPages] = useState(1)
  const [bulk, setBulk] = useState<PersonAction | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<PortalNotice | null>(null)
  const [now, setNow] = useState(() => new Date().toISOString())

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      setOrganisations({ value: await listOrganisations(api), problem: null })
      setNow(new Date().toISOString())
    } catch (error) {
      setOrganisations({ value: null, problem: partnerProblem(error) })
    }
  }, [api, can.view])
  useEffect(() => {
    void load()
  }, [load])

  useLiveBus(
    {
      onChange: (change) => {
        if (!partnersCountChange(change)) return
        void load()
        reload()
      },
      onReconnect: () => void load(),
    },
    can.view,
  )

  const run = async (action: PersonAction, rows: readonly User[], reason: string): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    let count = 0
    const refused: Array<{ name: string; problem: string }> = []
    try {
      for (const user of rows) {
        if (!user.partyId) continue
        try {
          await guard(`stepUp.sentence.${action}`, () => changePartnerStatus(api, user.partyId!, user.id, action, { version: user.version, ...(reason ? { reason } : {}) }))
          count += 1
        } catch (error) {
          if (isStepUpCancelled(error)) throw error
          refused.push({ name: user.displayName, problem: partnerProblem(error) })
        }
      }
    } catch {
      setBusy(false)
      return false
    }
    setBusy(false)
    setBulk(null)
    setNotice({ key: `done.${action}`, tone: refused.length === 0 ? 'success' : count === 0 ? 'danger' : 'warning', params: { count }, ...(refused.length > 0 ? { refused } : {}) })
    reload()
    void load()
    return true
  }

  return {
    model: can.view ? { prefix, users, organisations, tile, query, pages, now, can, bulk, busy, dialogProblem, notice } : null,
    actions: {
      onTile: (next) => {
        setTile(next)
        setPages(1)
      },
      onMore: () => setPages((current) => current + 1),
      onRetry: () => {
        setOrganisations({ value: null, problem: null })
        void load()
        reload()
      },
      onBulk: (next) => {
        setBulk(next)
        setDialogProblem(null)
      },
      onRun: run,
      onDismissNotice: () => setNotice(null),
    },
  }
}
