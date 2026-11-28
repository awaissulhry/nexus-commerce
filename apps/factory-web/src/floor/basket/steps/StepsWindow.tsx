'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import type { Department } from '../../../lib/department/model'
import { useDepartments } from '../../../lib/department/use-departments'
import { useT } from '../../../lib/i18n/provider'
import { useFloor } from '../../FloorApp'
import type { TaskProblem } from '../../tasks/shared/task-api'
import { changeRoute, fetchBasket, moveBaskets, normalRoute, type RouteTarget } from '../api'
import { deptOf, viewOf, type BasketView } from '../model'
import { BASKET_NS } from '../parts'
import { undoStore } from '../undo/store'
import { chosenOf, editsOf, EMPTY_DRAFT, hereDepartmentOf, hereIndexOf, manyRowsOf, planMany, planOne, READY_KEY, routeViewOf, savedLinesOf, stepRowsOf, turnStep, type BackWhy, type Choice, type ManyBasket, type RouteDraft } from './model'
import type { RouteEditorAction } from '../route/view/RouteEditorView'
import { StepsWindowView, type StepsWindowAction } from './view/StepsWindowView'

/**
 * owb-fl6 steps 1–2 — the Steps window's container: one basket (from its page: the read it has; from the leader's list: read here by its
 * code) or many (Change all on an order: each basket read here, at once). A tap sends fl2's move (`POST /production/baskets/move`; many =
 * one call per target step, as each work order has its own steps), puts the Undo bar's entry, and closes. The route editor sends
 * `POST /production/baskets/route` (or `/route/normal`), online only. A refusal stays in the window, in words.
 */

export type StepsTarget =
  | { readonly kind: 'view'; readonly view: BasketView }
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'order'; readonly salesOrderId: string | null; readonly label: string; readonly codes: readonly string[] }

type Loaded = { readonly state: 'loading' } | { readonly state: 'failed' } | { readonly state: 'one'; readonly view: BasketView } | { readonly state: 'many'; readonly baskets: readonly (ManyBasket & { readonly own: boolean })[] }

type Mode = { readonly kind: 'steps' } | { readonly kind: 'why'; readonly key: string } | { readonly kind: 'route' } | { readonly kind: 'done'; readonly lines: readonly string[] }

export function StepsWindowOf({ open, onClose, target, leader, onChanged }: { readonly open: boolean; readonly onClose: () => void; readonly target: StepsTarget | null; readonly leader: boolean; readonly onChanged: () => void }) {
  const { api, me, floorLocale: locale, sessionEnded } = useFloor()
  const tb = useT(BASKET_NS)
  const feedback = useConfirmFeedback()
  const { departments } = useDepartments(api)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [mode, setMode] = useState<Mode>({ kind: 'steps' })
  const [choice, setChoice] = useState<Choice>({ mode: 'all' })
  const [draft, setDraft] = useState<RouteDraft>(EMPTY_DRAFT)
  const [addOpen, setAddOpen] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!target) return
    if (target.kind === 'view') return setLoaded({ state: 'one', view: target.view })
    setLoaded({ state: 'loading' })
    if (target.kind === 'code') {
      const answer = await fetchBasket(api, target.code, false)
      const view = answer.ok ? viewOf(answer.value) : null
      return setLoaded(view ? { state: 'one', view } : { state: 'failed' })
    }
    const answers = await Promise.all(target.codes.map((code) => fetchBasket(api, code, false)))
    const baskets = answers.flatMap((answer) => {
      const view = answer.ok ? viewOf(answer.value) : null
      return view ? [{ bundleId: view.basket.id, code: view.basket.code, steps: view.route.steps, own: view.route.own }] : []
    })
    setLoaded(baskets.length > 0 ? { state: 'many', baskets } : { state: 'failed' })
  }, [api, target])

  // Each opening starts afresh and reads once (the parent's target is a new object at each of its renders).
  const loadNow = useRef(load)
  loadNow.current = load
  useEffect(() => {
    if (!open) return
    setMode({ kind: 'steps' })
    setChoice({ mode: 'all' })
    setDraft(EMPTY_DRAFT)
    setAddOpen(false)
    setSaid(null)
    void loadNow.current()
  }, [open])

  const one = loaded.state === 'one' ? loaded.view : null
  const many = loaded.state === 'many' ? loaded.baskets : null
  const chosen = useMemo(() => (many ? chosenOf(many, choice) : []), [many, choice])
  const rows = useMemo(() => (one ? stepRowsOf(one.route.steps, locale) : []), [one, locale])
  const manyRows = useMemo(() => (many ? manyRowsOf(chosen, locale) : []), [many, chosen, locale])
  // The route editor's base: this basket, or the chosen basket with the most steps still to come (design fsEditModal).
  const base = one ? one.route.steps : [...chosen].sort((a, b) => b.steps.length - hereIndexOf(b.steps) - (a.steps.length - hereIndexOf(a.steps)))[0]?.steps ?? []
  const routeView = routeViewOf(base, draft, locale)
  if (!me || !target) return null

  const said$ = (found: TaskProblem): string => (found.kind === 'refused' ? found.message || tb('dock.failed') : found.kind === 'offline' ? tb('dock.needsNetwork') : tb('dock.failed'))
  const deptById = (id: string): Department | null => departments.find((dept) => dept.id === id) ?? null

  const act = async (run: () => Promise<TaskProblem | null>) => {
    if (busy) return
    setBusy(true)
    setSaid(null)
    try {
      const found = await run()
      if (found?.kind === 'signedOut') return void sessionEnded()
      if (found) {
        feedback('error')
        setSaid(said$(found))
      }
    } catch {
      feedback('error')
      setSaid(tb('dock.failed'))
    } finally {
      setBusy(false)
    }
  }

  const moveOne = (key: string, why: BackWhy | null) =>
    act(async () => {
      if (!one) return null
      const row = rows.find((candidate) => candidate.key === key)
      if (!row) return null
      const plan = planOne(one.route.steps, rows, row, { leader, why })
      if (plan.kind === 'none') return null
      if (plan.kind === 'refused') return { kind: 'refused', code: plan.why, message: tb(plan.why === 'leaderBack' ? 'steps.leaderBack' : 'steps.packFirst'), fix: null }
      if (plan.kind === 'ask') {
        setMode({ kind: 'why', key })
        return null
      }
      const answer = await moveBaskets(api, { bundleIds: [one.basket.id], toOperationId: plan.move.toOperationId, kind: plan.move.kind, ...(plan.move.reason ? { reason: plan.move.reason } : {}), clientEventId: newIdempotencyKey() })
      if (!answer.ok) return answer.problem
      if (answer.value.moved === 0) return { kind: 'refused', code: 'STAY', message: answer.value.stayWords[0] ?? tb('dock.failed'), fix: null }
      const from = rows.find((candidate) => candidate.state === 'here')
      undoStore.put(me.worker.id, { kind: 'move', groupIds: [answer.value.groupId], code: one.basket.code, count: 1, from: from?.dept ?? null, to: row.dept, toReady: row.key === READY_KEY })
      feedback('success')
      onChanged()
      onClose()
      return null
    })

  const moveMany = (key: string, why: BackWhy | null) =>
    act(async () => {
      if (!many) return null
      const plan = planMany(chosen, key, { leader, why })
      if (plan.ask) {
        setMode({ kind: 'why', key })
        return null
      }
      if (plan.groups.length === 0) return { kind: 'refused', code: 'STAY', message: tb('steps.stay', { count: plan.stay }), fix: null }
      const groupIds: string[] = []
      let moved = 0
      let stay = plan.stay
      for (const group of plan.groups) {
        const answer = await moveBaskets(api, { bundleIds: group.bundleIds, toOperationId: group.toOperationId, kind: group.kind, ...(group.reason ? { reason: group.reason } : {}), clientEventId: newIdempotencyKey() })
        if (!answer.ok) {
          if (groupIds.length === 0) return answer.problem
          continue
        }
        groupIds.push(answer.value.groupId)
        moved += answer.value.moved
        stay += answer.value.stay
      }
      const to = key === READY_KEY ? null : deptById(key) ?? deptOf(chosen.flatMap((basket) => basket.steps).find((step) => step.department?.id === key)?.department ?? null, locale)
      if (groupIds.length > 0) undoStore.put(me.worker.id, { kind: 'move', groupIds, code: null, count: moved, from: null, to, toReady: key === READY_KEY })
      feedback('success')
      onChanged()
      const went = tb('steps.moved', { count: moved, dept: key === READY_KEY ? tb('state.READY') : to ? `${to.no} ${to.shortName}` : '' })
      if (stay > 0) {
        setMode({ kind: 'done', lines: [went, tb('steps.stay', { count: stay })] })
        return null
      }
      onClose()
      return null
    })

  const routeTarget = (): RouteTarget | null => {
    if (one) return draft.scope === 'order' && one.basket.salesOrderId ? { salesOrderId: one.basket.salesOrderId } : { bundleIds: [one.basket.id] }
    if (target.kind === 'order' && draft.scope === 'order' && target.salesOrderId) return { salesOrderId: target.salesOrderId }
    return chosen.length > 0 ? { bundleIds: chosen.map((basket) => basket.bundleId) } : null
  }

  const onEdit = (action: RouteEditorAction) => {
    switch (action.type) {
      case 'turn':
        return setDraft(turnStep(draft, routeView, action.operationId))
      case 'addOpen':
        return setAddOpen((now) => !now)
      case 'add':
        setAddOpen(false)
        return setDraft({ ...draft, adds: [...draft.adds, action.departmentId] })
      case 'takeOut':
        return setDraft({ ...draft, adds: draft.adds.filter((_, index) => index !== action.index) })
      case 'why':
        return setDraft({ ...draft, why: action.why })
      case 'scope':
        // Other baskets have other steps to come: the turns start again.
        return setDraft({ ...draft, scope: action.scope, turned: [] })
      case 'back':
        return setMode({ kind: 'steps' })
      case 'normal':
        return void act(async () => {
          const to = routeTarget()
          if (!to) return null
          const answer = await normalRoute(api, to)
          if (!answer.ok) return answer.problem
          feedback('success')
          onChanged()
          setMode({ kind: 'done', lines: [tb('route.normalDone')] })
          return null
        })
      case 'save':
        return void act(async () => {
          const to = routeTarget()
          if (!to || !routeView.canSave || !draft.why) return null
          const answer = await changeRoute(api, to, editsOf(base, draft), draft.why)
          if (!answer.ok) return answer.problem
          feedback('success')
          onChanged()
          const lines = savedLinesOf(answer.value).map((line) => (line === 'saved' ? tb('route.saved') : line === 'stay' ? tb('steps.stay', { count: answer.value.stay }) : tb('route.noQuality')))
          if (lines.length > 1) setMode({ kind: 'done', lines })
          else onClose()
          return null
        })
    }
  }

  const onAction = (action: StepsWindowAction) => {
    switch (action.type) {
      case 'close':
        return onClose()
      case 'retry':
        return void load()
      case 'row':
        return void (one ? moveOne(action.key, null) : moveMany(action.key, null))
      case 'why':
        return mode.kind === 'why' ? void (one ? moveOne(mode.key, action.why) : moveMany(mode.key, action.why)) : undefined
      case 'whyBack':
        return setMode({ kind: 'steps' })
      case 'choice':
        return setChoice(action.choice)
      case 'tick':
        return setChoice((now) => {
          const ids = now.mode === 'chosen' ? now.ids : []
          return { mode: 'chosen', ids: ids.includes(action.bundleId) ? ids.filter((id) => id !== action.bundleId) : [...ids, action.bundleId] }
        })
      case 'route':
        setDraft({ ...EMPTY_DRAFT, scope: one ? 'one' : 'chosen' })
        return setMode({ kind: 'route' })
      case 'edit':
        return onEdit(action.action)
    }
  }

  const whyRow = mode.kind === 'why' ? (one ? rows.find((row) => row.key === mode.key) : manyRows.find((row) => row.key === mode.key)) : null
  const atDepartments = many
    ? [...new Map(many.map((basket) => [hereDepartmentOf(basket), basket] as const)).keys()]
        .filter((id): id is string => id !== null)
        .map((id) => ({ id, dept: deptById(id) ?? deptOf(many.flatMap((basket) => basket.steps).find((step) => step.department?.id === id)?.department ?? null, locale), count: many.filter((basket) => hereDepartmentOf(basket) === id).length }))
    : []
  const title = one ? tb('steps.title', { code: one.basket.code }) : target.kind === 'order' ? tb('steps.title', { code: target.label }) : target.kind === 'code' ? tb('steps.title', { code: target.code }) : tb('steps.titleNone')

  return (
    <StepsWindowView
      model={{
        open,
        title: mode.kind === 'route' ? tb('route.titleOf', { code: one ? one.basket.code : target.kind === 'order' ? target.label : '' }) : title,
        state: loaded.state === 'loading' ? 'loading' : loaded.state === 'failed' ? 'failed' : 'ready',
        mode: mode.kind,
        one: one ? { rows, offRoute: !one.here.onRoute && one.here.departmentId !== null } : null,
        many: many
          ? {
              rows: manyRows,
              baskets: many.map((basket) => {
                const here = hereDepartmentOf(basket)
                return { bundleId: basket.bundleId, code: basket.code, here: here ? (deptById(here) ?? deptOf(basket.steps.find((step) => step.department?.id === here)?.department ?? null, locale)) : null, chosen: choice.mode === 'chosen' && choice.ids.includes(basket.bundleId) }
              }),
              choice,
              at: atDepartments,
              chosen: chosen.length,
            }
          : null,
        leader,
        canRoute: leader && routeView.ahead.length + (routeView.last ? 1 : 0) > 0,
        whyTo: whyRow ? { dept: whyRow.dept, ready: whyRow.key === READY_KEY, name: whyRow.name } : null,
        route:
          mode.kind === 'route'
            ? {
                view: routeView,
                draft,
                scopes: one ? (one.basket.salesOrderId ? ['one', 'order'] : []) : target.kind === 'order' && target.salesOrderId ? ['chosen', 'order'] : [],
                chosen: chosen.length,
                addOpen,
                departments: departments.filter((dept) => Boolean(dept.id) && !dept.closed),
                added: draft.adds.map((id) => deptById(id)),
                own: one ? one.route.own : chosen.some((basket) => basket.own),
                busy,
              }
            : null,
        said,
        done: mode.kind === 'done' ? mode.lines : [],
        busy,
      }}
      onAction={onAction}
    />
  )
}
