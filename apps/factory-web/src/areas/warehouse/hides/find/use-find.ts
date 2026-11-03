'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { readProblem } from '../../../_shared/stock/model'
import type { Uom } from '../../../_shared/stock/api'
import { openWorkOrders } from '../../stock/daily/api'
import { gradeMix } from '../dashboard/api'
import { articleGrades, findHides, reserveFound } from './api'
import { emptyDraft, findHeldKey, findProblem, findQueryOf, findReadProblem, proposedIds, reserveHeldKey, type ArticleOption, type FindCan, type FindDialogActions, type FindDialogModel, type FindDraft } from './find-model'

/**
 * The Find hides for a job dialog's container part (Hides' band, B-W2b-131): opens on the page's site; lists the site's open
 * work orders (workorders.view) and the articles with hides in stock (the grade mix per article); with an article, its
 * grades for the minimum grade (product.materials.view); Find asks the API (by a work order or an article and an area);
 * the proposal's hides come chosen; "Reserve N hides" reserves the chosen ones whole for the work order (ONE
 * Idempotency-Key per dialog; all or nothing). `onDone` runs once they are reserved (the page reads again).
 */
export function useFindHides(api: ApiClient, can: FindCan, sites: readonly { id: string; code: string; name: string }[], onDone: () => void) {
  const [model, setModel] = useState<FindDialogModel | null>(null)
  const latest = useRef(model)
  latest.current = model
  const key = useRef<string | null>(null)
  const asked = useRef({ orders: 0, find: 0, grades: 0 })

  const patch = useCallback((next: Partial<FindDialogModel>) => setModel((current) => (current ? { ...current, ...next } : current)), [])

  const loadOrders = useCallback(
    (siteId: string | null, query: string) => {
      if (!can.workOrders) return
      const id = ++asked.current.orders
      patch({ workOrderQuery: query, workOrders: { value: null, problem: null } })
      openWorkOrders(api, { siteId, q: query })
        .then((answer) => id === asked.current.orders && patch({ workOrders: { value: answer.workOrders, problem: null } }))
        .catch((error: unknown) => id === asked.current.orders && patch({ workOrders: { value: null, problem: readProblem(error) } }))
    },
    [api, can.workOrders, patch],
  )

  const loadArticles = useCallback(
    (siteId: string | null) => {
      patch({ articles: { value: null, problem: null } })
      gradeMix(api, { siteId, groupBy: 'article' })
        .then((answer) =>
          patch({
            articles: {
              value: answer.groups.map(
                (group): ArticleOption => ({
                  key: `${group.item.id}|${group.colour?.id ?? ''}`,
                  itemId: group.item.id,
                  itemColourId: group.colour?.id ?? null,
                  label: `${group.item.code} · ${group.item.name}${group.colour ? ` · ${group.colour.name}` : ''}`,
                  hides: group.hides,
                  left: group.left,
                  uom: group.uom,
                }),
              ),
              problem: null,
            },
          }),
        )
        .catch((error: unknown) => patch({ articles: { value: null, problem: readProblem(error) } }))
    },
    [api, patch],
  )

  const loadGrades = useCallback(
    (itemId: string | null) => {
      if (!can.grades || !itemId) return
      const id = ++asked.current.grades
      patch({ grades: { value: null, problem: null } })
      articleGrades(api, itemId)
        .then((grades) => id === asked.current.grades && patch({ grades: { value: grades, problem: null } }))
        .catch((error: unknown) => id === asked.current.grades && patch({ grades: { value: null, problem: readProblem(error) } }))
    },
    [api, can.grades, patch],
  )

  const open = useCallback(
    (siteId: string | null, preset?: Partial<FindDraft>) => {
      key.current = newIdempotencyKey()
      const draft = { ...emptyDraft(can.workOrders ? 'workOrder' : 'article'), ...preset }
      const site = siteId ?? (sites.length === 1 ? sites[0]!.id : null)
      setModel({
        siteId: site,
        sites,
        draft,
        articles: { value: null, problem: null },
        grades: can.grades ? { value: [], problem: null } : null,
        workOrderQuery: '',
        workOrders: { value: null, problem: null },
        result: null,
        chosen: [],
        note: '',
        overrideReason: '',
        can,
        posting: false,
        problem: null,
        done: null,
      })
      loadOrders(site, '')
      loadArticles(site)
    },
    [can, sites, loadOrders, loadArticles],
  )

  const find = useCallback(() => {
    const current = latest.current
    if (!current || findHeldKey(current)) return
    const query = findQueryOf(current.draft, current.siteId, current.articles.value, current.result?.value ?? null)
    if (!query) return
    const id = ++asked.current.find
    patch({ result: { value: null, problem: null }, chosen: [], problem: null, done: null })
    findHides(api, query)
      .then((answer) => {
        if (id !== asked.current.find) return
        // The article the work order cuts: its grades for the minimum grade.
        if (current.draft.mode === 'workOrder' && can.grades) loadGrades(answer.item.id)
        patch({ result: { value: answer, problem: null }, chosen: proposedIds(answer), siteId: current.siteId ?? answer.site.id })
      })
      .catch((error: unknown) => id === asked.current.find && patch({ result: { value: null, problem: findReadProblem(error, readProblem(error)) } }))
  }, [api, can.grades, loadGrades, patch])

  const actions: FindDialogActions = {
    onDraft: (draft) => {
      const current = latest.current
      if (!current) return
      const articleChanged = draft.articleKey !== current.draft.articleKey
      patch({ draft: articleChanged ? { ...draft, minGradeId: null, shadeGroupId: null } : draft, problem: null, done: null })
      if (articleChanged && draft.mode === 'article') loadGrades(current.articles.value?.find((option) => option.key === draft.articleKey)?.itemId ?? null)
    },
    onSite: (siteId) => {
      patch({ siteId, result: null, chosen: [], draft: { ...(latest.current?.draft ?? emptyDraft()), workOrderId: null, articleKey: null } })
      loadOrders(siteId, '')
      loadArticles(siteId)
    },
    onWorkOrderQuery: (query) => loadOrders(latest.current?.siteId ?? null, query),
    onFind: find,
    onChosen: (hideIds) => patch({ chosen: hideIds, problem: null }),
    onNote: (note) => patch({ note }),
    onOverrideReason: (overrideReason) => patch({ overrideReason, problem: null }),
    onRetry: find,
    onClose: () => setModel(null),
    onReserve: () => {
      const current = latest.current
      const answer = current?.result?.value ?? null
      if (!current || !answer || current.done || !key.current || reserveHeldKey(current)) return
      const workOrder = current.workOrders.value?.find((order) => order.id === current.draft.workOrderId)
      patch({ posting: true, problem: null })
      reserveFound(api, { siteId: current.siteId ?? answer.site.id, workOrderId: current.draft.workOrderId!, note: current.note, shadeOverrideReason: current.overrideReason.trim() || null, hideIds: current.chosen }, key.current)
        .then((done) => {
          patch({ posting: false, done: { count: done.reservations.length, workOrder: workOrder?.number ?? answer.workOrder?.number ?? '' } })
          onDone()
        })
        .catch((error: unknown) => patch({ posting: false, problem: findProblem(error, current.chosen, answer) }))
    },
  }
  return { model, open, actions }
}

/** The units an area may be typed in for an article counted in `base`: its own, and m² / ft². */
export function areaUnitsFor(base: Uom | null): Uom[] {
  const units: Uom[] = base ? [base] : []
  for (const unit of ['M2', 'FT2'] as const) if (!units.includes(unit)) units.push(unit)
  return units
}
