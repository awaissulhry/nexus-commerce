'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fixedDepartments, type DepartmentAnswer } from '../../../../../lib/department/model'
import { keptDepartments, resetDepartments, wantDepartments } from '../../../../../lib/department/use-departments'
import { useDepartmentWords } from '../../../../../lib/department/words'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { StyleView } from '../../api'
import { createStyleRoute, saveProductRoute, updateStyleRoute } from '../builder/api'
import { mayManage } from '../builder/manage'
import { productBody, refusalOf, routeBody, type BuilderState } from '../builder/model'
import { RouteBuilderWindow, type BuilderOpen } from '../builder/RouteBuilderWindow'
import { RouteView, type RouteViewModel } from '../view/RouteView'
import { deleteStyleRoute, readRoute, type RouteRouting, type StyleRouteView } from './api'
import { answerOf, chosenRouteOf, deptLooksOf, forWhomOf, problemKeyOf, routeChipsOf, routeEditHeld, routeRowsOf, ruleNotesOf, rulesOfChosen, totalMinutesOf, type RouteEditFacts, type Words } from './model'
import { useOfficeReach } from './office'

/**
 * owb-pd6 step 6.1 (S4) — the container of the Route tab's face: it reads the revision's routing with the route fields
 * (route/api.ts) and the factory's departments (lib/department, one read per tab), keeps the chosen chip, takes a model or customer
 * route out, and tells the record (`onChanged`) after every write so the record's own reads (the depth under "More", the release
 * check, the revision's version) follow. A new `routingVersion` from the record (any write elsewhere) reads the route again.
 * Step 6.2: "Edit this route…" opens the builder on the chosen route (the product's: its kept steps keep their `stepId`; a model or
 * customer route: its name and who it is for), "New route…" on a copy of the product's route; the builder opens only when nothing
 * holds it (routeEditHeld: product.routing.manage on a DRAFT, the departments read) and saves with this container's call per mode.
 * Step 6.3: the builder's Manage switch for production.departments.manage; a department added, renamed, closed or opened there comes
 * back here, so the steps table shows the new name at once.
 */

export interface RouteContainerProps {
  readonly style: StyleView
  readonly revisionId: string | null
  /** product.routing.manage. */
  readonly manage: boolean
  /** The record runs a write. */
  readonly busy: boolean
  /** The record routing's revision version: a new one reads the route again. */
  readonly routingVersion: number | null
  /** After a route write: the record reads again. */
  readonly onChanged: () => void
  /** Opens the record's "Start revision n" window; null: the person may not start one now. */
  readonly onStartRevision: (() => void) | null
}

type Read = { status: 'reading' } | { status: 'ready'; routing: RouteRouting } | { status: 'failed'; problem: string }

export function RouteContainer({ style, revisionId, manage, busy, routingVersion, onChanged, onStartRevision }: RouteContainerProps) {
  const { api, can } = useOfficeReach()
  const locale = useLocale()
  const t = useT('products-route')
  const sayDept = useDepartmentWords()
  const fixed = useMemo(() => fixedDepartments(sayDept), [sayDept])
  const [read, setRead] = useState<Read>({ status: 'reading' })
  const [rows, setRows] = useState<readonly DepartmentAnswer[] | null>(() => keptDepartments() ?? null)
  const [deptState, setDeptState] = useState<'ready' | 'reading' | 'failed'>(() => (keptDepartments() ? 'ready' : 'reading'))
  const [chosen, setChosen] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const [actProblem, setActProblem] = useState<string | null>(null)
  const [builder, setBuilder] = useState<{ readonly open: BuilderOpen; readonly route: StyleRouteView | null } | null>(null)
  const [round, setRound] = useState(0)
  const again = useCallback(() => setRound((value) => value + 1), [])

  // The route: again after each write here (round) and after the record's own reads (routingVersion).
  useEffect(() => {
    if (!api || !revisionId) return
    const control = new AbortController()
    readRoute(api, style.id, revisionId, control.signal).then(
      (routing) => setRead({ status: 'ready', routing }),
      (error: unknown) => {
        if (!control.signal.aborted) setRead({ status: 'failed', problem: problemKeyOf(error) })
      },
    )
    return () => control.abort()
  }, [api, style.id, revisionId, routingVersion, round])

  // The departments: one read per tab (lib/department), again on a retry.
  useEffect(() => {
    if (!api) return
    let live = true
    wantDepartments(api).then(
      (answer) => {
        if (!live) return
        setRows(answer)
        setDeptState('ready')
      },
      () => {
        if (live) setDeptState((state) => (state === 'ready' ? state : 'failed'))
      },
    )
    return () => {
      live = false
    }
  }, [api, round])

  const revision = style.revisions.find((entry) => entry.id === revisionId) ?? null
  const draft = style.revisions.find((entry) => entry.status === 'DRAFT' && entry.id !== revisionId) ?? null
  const highest = style.revisions.reduce((top, entry) => Math.max(top, entry.revision), 0)
  const facts: RouteEditFacts = { manage, styleStatus: style.status, revision, draft, highest, busy: busy || acting, departments: deptState }
  const looks = useMemo(() => deptLooksOf(rows ?? [], locale), [rows, locale])

  const routing = read.status === 'ready' ? read.routing : null
  const route = routing ? chosenRouteOf(routing, chosen) : null

  const takeOut = async () => {
    if (!api || !revisionId || !route || routeEditHeld(facts)) return
    setActing(true)
    setActProblem(null)
    try {
      await deleteStyleRoute(api, style.id, revisionId, route)
      setChosen(null)
      again()
      onChanged()
    } catch (error) {
      setActProblem(problemKeyOf(error))
    } finally {
      setActing(false)
    }
  }

  // ---- step 6.2: the builder ----
  const product = `${style.code} · ${style.name}`
  const productStart = () => (routing ? [...routing.steps].sort((a, b) => a.seq - b.seq) : [])
  const openEdit = () => {
    if (!routing || !rows || routeEditHeld(facts)) return
    if (route)
      setBuilder({
        route,
        open: { mode: 'route', subtitle: t('builder.subtitle.route', { product, route: route.name }), start: route.steps.map((step) => ({ departmentId: step.departmentId, minutes: step.minutes })), name: route.name, forWhom: route.kind, partyId: route.party?.id ?? null },
      })
    else setBuilder({ route: null, open: { mode: 'product', subtitle: t('builder.subtitle.product', { product }), start: productStart().map((step) => ({ stepId: step.id, departmentId: step.department?.id ?? null, minutes: step.standardMinutes })) } })
  }
  const openNew = () => {
    if (!routing || !rows || routeEditHeld(facts)) return
    setBuilder({ route: null, open: { mode: 'new', subtitle: t('builder.subtitle.new', { product }), start: productStart().map((step) => ({ departmentId: step.department?.id ?? null, minutes: step.standardMinutes })), fresh: true } })
  }
  const saveBuilder = async (state: BuilderState): Promise<Words | null> => {
    if (!api || !revisionId || !routing) return { key: 'problem.unavailable' }
    try {
      if (state.mode === 'product') setRead({ status: 'ready', routing: await saveProductRoute(api, style.id, revisionId, productBody(state, routing.revision.version)) })
      else if (state.mode === 'route' && builder?.route) await updateStyleRoute(api, style.id, revisionId, builder.route.id, { ...routeBody(state), version: builder.route.version })
      else if (state.mode === 'new') {
        const made = await createStyleRoute(api, style.id, revisionId, routeBody(state))
        if (made) setChosen(made)
      } else return { key: 'problem.unavailable' }
      setBuilder(null)
      if (state.mode !== 'product') again()
      onChanged()
      return null
    } catch (error) {
      // Someone else changed the revision meanwhile: read again, so the next Save is made on the new version.
      if ((error as { kind?: string } | null)?.kind === 'conflict') {
        again()
        onChanged()
      }
      return refusalOf(error, 'route') // owb-pd8: NAME_TAKEN = another route of this revision
    }
  }

  const model: RouteViewModel = {
    state: !api ? 'outside' : read.status === 'reading' ? 'reading' : read.status === 'failed' ? 'failed' : 'ready',
    problem: read.status === 'failed' ? read.problem : null,
    chips: routing ? routeChipsOf(routing, chosen) : [],
    chosen: route,
    rows: routing ? routeRowsOf(routing, route, looks, fixed) : [],
    total: routing ? totalMinutesOf(routeRowsOf(routing, route, looks, fixed)) : null,
    notes: routing ? ruleNotesOf(rulesOfChosen(routing, route)) : { errors: [], warnings: [] },
    answer: routing ? answerOf(routing) : [],
    forWhom: forWhomOf(route),
    held: routeEditHeld(facts),
    start: revision && revision.status !== 'DRAFT' && !draft && onStartRevision ? { next: highest + 1 } : null,
    busy: busy || acting,
    actProblem,
  }

  return (
    <>
      <RouteView
        model={model}
        actions={{
          onChoose: (routeId) => {
            setChosen(routeId)
            setActProblem(null)
          },
          onEdit: openEdit,
          onNew: openNew,
          onTakeOut: () => void takeOut(),
          onRetry: again,
          ...(onStartRevision ? { onStartRevision } : {}),
        }}
      />
      {builder && api && rows && (
        <RouteBuilderWindow
          api={api}
          open={builder.open}
          departments={rows}
          fixedParty={style.brand ?? null}
          companyId={style.companyId}
          onSave={saveBuilder}
          onClose={() => setBuilder(null)}
          mayManage={mayManage(can)}
          onDepartments={(next) => {
            // Step 6.3: every mount reads the departments again; this tab shows the new names at once.
            resetDepartments()
            setRows(next)
          }}
        />
      )}
    </>
  )
}
