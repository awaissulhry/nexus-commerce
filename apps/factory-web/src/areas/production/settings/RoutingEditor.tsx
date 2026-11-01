'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi } from '../../../lib/session/context'
import { useLive } from '../../_shared/buying/hooks'
import { useCellSaves } from './use-cell-saves'
import { RoutingView, type RouteDialog, type RoutingModel } from './view/RoutingView'
import { createRoute, editRoute, listHelpCodes, listOffCodes, listRoutes, listTeams, type HelpCode, type OffCode, type Route, type RouteEdit, type SiteTeam } from './w2b-api'
import { escalationEdit, routeWithEdit, w2bProblem } from './w2b-model'

const OWN_ECHO_MS = 5000

/**
 * Floor rules & codes › Help-call routing (B-W2b-58 over B-W2b-35's API): reads the site's help-call types
 * (production.calls.view), the site's teams to pick (people.view; else the group shows as text), the company's active
 * off-standard codes the waiting may book to (production.offstandard.view) and the help-call reason codes (a new type is
 * one of them); saves each cell at the version read (production.calls.manage), switches many off or on, adds a type.
 * Live `help_call_type.changed` from someone else → "Changed by someone else · Reload".
 */
export function RoutingEditor({ site, companyId, people, offstd }: { site: { id: string; code: string; name: string } | null; companyId: string | null; people: boolean; offstd: boolean }) {
  const api = useOfficeApi()
  const siteId = site?.id ?? null
  const [load, setLoad] = useState<RoutingModel['load']>({ status: 'loading' })
  const [routes, setRoutes] = useState<Route[] | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [teams, setTeams] = useState<SiteTeam[] | null>(null)
  const [codes, setCodes] = useState<OffCode[] | null>(null)
  const [helpCodes, setHelpCodes] = useState<HelpCode[] | null>(null)
  const [notice, setNotice] = useState<RoutingModel['notice']>(null)
  const [dialog, setDialog] = useState<RouteDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const routesRef = useRef<Route[] | null>(null)
  routesRef.current = routes
  const pickRef = useRef({ teams, codes })
  pickRef.current = { teams, codes }
  const ownUntil = useRef(0)
  const createKey = useRef(newIdempotencyKey())

  const read = useCallback(async () => {
    if (!siteId) return
    const [answer, siteTeams, offCodes, reasons] = await Promise.allSettled([
      listRoutes(api, siteId),
      people ? listTeams(api, siteId) : Promise.reject(new Error('no people.view')),
      offstd ? listOffCodes(api, companyId) : Promise.reject(new Error('no production.offstandard.view')),
      listHelpCodes(api),
    ])
    if (answer.status === 'rejected') {
      setLoad({ status: 'error', problem: w2bProblem(answer.reason).key })
      return
    }
    setRoutes([...answer.value.types].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)))
    setCanManage(answer.value.canManage)
    setTeams(siteTeams.status === 'fulfilled' ? siteTeams.value.filter((team) => team.status === 'ACTIVE') : null)
    setCodes(offCodes.status === 'fulfilled' ? offCodes.value.codes.filter((code) => code.active && code.kind === 'OFF_STANDARD') : null)
    setHelpCodes(reasons.status === 'fulfilled' ? reasons.value : null)
    setLoad({ status: 'ready' })
    setChangedElsewhere(false)
  }, [api, siteId, companyId, people, offstd])

  useEffect(() => {
    setLoad({ status: 'loading' })
    setRoutes(null)
    void read()
  }, [read])

  useLive(
    (change) => {
      if (change.type !== 'help_call_type.changed' || Date.now() < ownUntil.current) return
      setChangedElsewhere(true)
    },
    () => void read(),
  )

  const rowNow = useCallback((id: string) => routesRef.current?.find((row) => row.id === id), [])
  const putRow = useCallback((row: Route) => setRoutes((current) => (current ? current.map((entry) => (entry.id === row.id ? row : entry)) : current)), [])
  const cells = useCellSaves<Route>(rowNow, putRow, () => setChangedElsewhere(true))

  const save = (row: Route, field: string, edit: RouteEdit) => {
    ownUntil.current = Date.now() + OWN_ECHO_MS
    cells.save(row.id, field, (current) => routeWithEdit(current, edit, pickRef.current.teams ?? [], pickRef.current.codes ?? []), (version, key) => editRoute(api, row.id, { ...edit, version }, key))
  }

  const model: RoutingModel = { site: site ? { code: site.code, name: site.name } : null, load, routes, canManage, teams, codes, helpCodes, marks: cells.marks, notice, busy, dialog, changedElsewhere }

  return (
    <RoutingView
      model={model}
      actions={{
        onRetry: () => {
          setLoad({ status: 'loading' })
          void read()
        },
        onReload: () => {
          cells.clear()
          void read()
        },
        onTeam: (row, teamId) => {
          if ((row.responder.team?.id ?? null) !== teamId) save(row, 'team', { responderTeamId: teamId })
        },
        onEscalate: (row, value) => {
          const outcome = escalationEdit(rowNow(row.id) ?? row, value)
          if (!outcome) return
          if ('problem' in outcome) cells.refuse(row.id, 'escalate', outcome.problem)
          else save(row, 'escalate', outcome.edit)
        },
        onWaiting: (row, codeId) => {
          if ((row.waitingCode?.id ?? null) !== codeId) save(row, 'waiting', { offStandardCodeId: codeId })
        },
        onActive: (row, next) => save(row, 'active', { active: next }),
        onActiveMany: (ids, active) => {
          for (const id of ids) {
            const row = rowNow(id)
            if (row && row.active !== active) save(row, 'active', { active })
          }
        },
        onDialog: (next) => {
          if (next?.kind === 'new' && dialog?.kind !== 'new') createKey.current = newIdempotencyKey()
          setDialog(next)
        },
        onCreate: () => {
          if (dialog?.kind !== 'new' || busy || !siteId) return
          const draft = dialog.draft
          setBusy(true)
          ownUntil.current = Date.now() + OWN_ECHO_MS
          createRoute(api, { siteId, code: draft.code, kind: draft.kind, responderTeamId: draft.teamId || null, escalateAfterMinutes: draft.escalate === '' ? null : draft.escalate }, createKey.current)
            .then((route) => {
              setRoutes((current) => [...(current ?? []), route])
              setDialog(null)
              setNotice({ tone: 'success', key: 'fr.route.new.done', params: { code: route.code } })
            })
            .catch((error: unknown) => setDialog({ ...dialog, problem: w2bProblem(error).key }))
            .finally(() => setBusy(false))
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
