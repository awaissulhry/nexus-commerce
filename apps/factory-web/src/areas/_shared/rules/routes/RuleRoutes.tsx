'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { addRoute, getRoutes, removeRoute } from './api'
import { newRouteDraft, routeProblem, routesReadProblem, type RouteDraft } from './model'
import { RoutesPanel, type RoutesModel } from './view/RoutesPanel'

/**
 * A rule's routes, the container (B-W2b-435; ANA-041): reads them with the choices (GET /alerts/rules/:id/routes), adds one
 * (POST …/routes) and removes one (DELETE /alerts/routes/:routeId); reads again on `alert.route_added` / `alert.route_removed`
 * of this rule. The rule dialog mounts it for a rule that exists.
 */
export function RuleRoutes({ ruleId }: { readonly ruleId: string }) {
  const api = useOfficeApi()
  const [read, setRead] = useState<RoutesModel['read']>({ status: 'loading' })
  const [draft, setDraft] = useState<RouteDraft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<RoutesModel['notice']>(null)

  const load = useCallback(async () => {
    try {
      const value = await getRoutes(api, ruleId)
      setRead({ status: 'ready', data: value })
      setDraft((current) => current ?? (value.choices ? newRouteDraft(value.choices) : null))
    } catch (error) {
      setRead({ status: 'error', problem: routesReadProblem(error) })
    }
  }, [api, ruleId])
  useEffect(() => {
    void load()
  }, [load])
  const live = useLiveBus({ onChange: (change) => (change.type === 'alert.route_added' || change.type === 'alert.route_removed') && change.fields.ruleId === ruleId && void load(), onReconnect: () => void load() })

  const act = async (kind: string, work: () => Promise<unknown>, done: string) => {
    setBusy(kind)
    setNotice(null)
    try {
      await work()
      setNotice({ key: done, tone: 'success' })
      await load()
    } catch (error) {
      setNotice({ key: routeProblem(error), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  const model = useMemo<RoutesModel>(() => ({ read, draft, busy, offline: live === 'offline', notice }), [read, draft, busy, live, notice])
  return (
    <RoutesPanel
      model={model}
      actions={{
        onDraft: (change) => setDraft((current) => (current ? { ...current, ...change } : current)),
        onAdd: () => draft && void act('add', () => addRoute(api, ruleId, { scope: draft.scope, scopeId: draft.scopeId, ...(draft.who === 'ROLE' ? { roleId: draft.roleId } : { userId: draft.userId }) }), 'routes.done.added'),
        onRemove: (routeId) => void act(routeId, () => removeRoute(api, routeId), 'routes.done.removed'),
        onRetry: () => void load(),
      }}
    />
  )
}
