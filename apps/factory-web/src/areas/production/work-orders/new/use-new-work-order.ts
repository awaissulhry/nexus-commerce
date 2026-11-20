'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { createWorkOrder, findOrders, getOpenLines, type OpenLines, type OrderOption, type WorkOrder } from '../../_shared/api'
import { readProblem, writeProblem } from '../../_shared/model'
import { linesOfStyle, NO_NEW_ORDER, openGridOf, pickedAfter, stylesOf, type NewWorkOrderActions, type NewWorkOrderModel } from '../list-model'

/**
 * The style a work order makes, its lines picked (the open size-grid lines; a made-to-measure unit is ticked alone) and their open sizes.
 * F-OO-123: `lineId` — one line asked (the order page's Overview › Progress by line ⋯ "Make work orders for this line…"): only that line
 * is ticked, when it is of this style and still open (a made-to-measure unit too: it is ticked alone); without it, as before.
 */
export function pickOfStyle(lines: OpenLines | null, styleId: string | null, lineId?: string | null): Pick<NewWorkOrderModel, 'styleId' | 'picked' | 'grid'> {
  const own = linesOfStyle(lines, styleId).filter((line) => (lineId ? line.id === lineId : !line.madeToMeasure) && line.sizes.some((size) => size.open > 0))
  return { styleId, picked: own.map((line) => line.id), grid: Object.fromEntries(own.map((line) => [line.id, openGridOf(line)])) }
}

/**
 * The style step: the style asked (the order page's "Make the next one: …") when it still has open pieces, else the first style with
 * open pieces (one work order makes one style); its lines picked with every open size.
 */
export function styleStepOf(lines: OpenLines, asked: string | null): Pick<NewWorkOrderModel, 'styleId' | 'picked' | 'grid'> {
  const open = stylesOf(lines).filter((style) => style.open > 0)
  const styleId = (asked && open.some((style) => style.id === asked) ? asked : open[0]?.id) ?? null
  return pickOfStyle(lines, styleId)
}

/**
 * After a work order of `made` was made from these open lines: the next style that still has open pieces (in the order's line order,
 * after the one made, then from the start), or null when none remains — the order page offers "Make the next one: <style>".
 */
export function nextStyleOf(lines: OpenLines | null, made: string | null): { styleId: string; code: string } | null {
  const styles = stylesOf(lines)
  const at = styles.findIndex((style) => style.id === made)
  const after = [...styles.slice(at + 1), ...styles.slice(0, Math.max(0, at))]
  const next = after.find((style) => style.id !== made && style.open > 0)
  return next ? { styleId: next.id, code: next.code } : null
}

/**
 * F-OP-112 (10-order-page §5.1) — "New work order": the dialog's state and its create, ONE hook for both of its doors (the dialog's
 * view, NewWorkOrderDialog, is the same on both):
 *   the Production page   a confirmed sales order searched by number or customer reference (`?new=1&order=<number>` picks it), its
 *                         open lines of ONE style, the sizes, a due date; Create opens the new draft (the page navigates)
 *   the order page        the order fixed (no search), the style step (the asked style, else the first open one); Create says the
 *                         new draft and offers the next style (no navigation: the page decides in `onMade`)
 * A refused create is said in the dialog (the production lane's words), what was typed stays.
 */
export function useNewWorkOrder(
  api: ApiClient,
  options: {
    /** The person may search sales orders (orders.view): the search runs as the dialog opens. */
    readonly canSearch: boolean
    /** The Production page's `?order=<number>`: picked once its search answers it. */
    readonly autoPick?: string | null
    /** The draft was made: the dialog has closed; what was asked is given with it (the order page reads the next style from it). */
    readonly onMade: (made: WorkOrder, asked: NewWorkOrderModel) => void
  },
): { model: NewWorkOrderModel | null; open: (start?: { order: OrderOption; styleId?: string | null; /* F-OO-123 */ lineId?: string | null }) => void; close: () => void; actions: NewWorkOrderActions } {
  const [model, setModel] = useState<NewWorkOrderModel | null>(null)
  const modelRef = useRef<NewWorkOrderModel | null>(null)
  modelRef.current = model
  const autoPick = useRef<string | null>(options.autoPick ?? null)
  const chooseRef = useRef<(order: OrderOption | null) => void>(() => undefined)
  const onMadeRef = useRef(options.onMade)
  onMadeRef.current = options.onMade

  // The dialog's order search (the Production page's door; the order page's order is fixed).
  const searchOrders = useCallback(
    async (query: string) => {
      setModel((current) => (current ? { ...current, query, orders: null, ordersProblem: null } : current))
      try {
        const orders = await findOrders(api, query)
        setModel((current) => (current && current.query === query ? { ...current, orders } : current))
        const asked = autoPick.current
        if (asked && query === asked) {
          autoPick.current = null
          const match = orders.find((order) => order.number === asked)
          if (match) chooseRef.current(match)
        }
      } catch (error) {
        setModel((current) => (current && current.query === query ? { ...current, orders: null, ordersProblem: readProblem(error) } : current))
      }
    },
    [api],
  )
  useEffect(() => {
    if (model && !model.fixed && model.orders === null && model.ordersProblem === null && model.query === '' && options.canSearch) void searchOrders(autoPick.current ?? '')
    // Only when the dialog opens.
  }, [model !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The order chosen: its open lines read, the style step taken (the style asked, else the first with open pieces). F-OO-123: a line
   * asked with its style — that style still open: only that line ticked (else the style step as before).
   */
  const chooseOrder = useCallback(
    async (order: OrderOption | null, asked: string | null = null, lineId: string | null = null) => {
      setModel((current) => (current ? { ...current, chosen: order, lines: null, linesProblem: null, styleId: null, picked: [], grid: {}, problem: null } : current))
      if (!order) return
      try {
        const lines = await getOpenLines(api, order.id)
        const step = styleStepOf(lines, asked)
        const picked = lineId && step.styleId === asked ? pickOfStyle(lines, asked, lineId) : step // F-OO-123
        setModel((current) => (!current || current.chosen?.id !== order.id ? current : { ...current, lines, ...picked }))
      } catch (error) {
        setModel((current) => (current && current.chosen?.id === order.id ? { ...current, linesProblem: readProblem(error) } : current))
      }
    },
    [api],
  )
  chooseRef.current = (order) => void chooseOrder(order)

  const create = useCallback(async () => {
    const current = modelRef.current
    if (!current || current.busy) return
    setModel({ ...current, busy: true, problem: null })
    try {
      const lines = current.picked.map((lineId) => ({
        salesOrderLineId: lineId,
        sizes: Object.entries(current.grid[lineId] ?? {})
          .filter(([, quantity]) => quantity > 0)
          .map(([size, quantity]) => ({ size, quantity })),
      }))
      const created = await createWorkOrder(api, { ...(current.dueDate ? { dueDate: current.dueDate } : {}), lines: lines.filter((line) => line.sizes.length > 0) })
      setModel(null)
      onMadeRef.current(created, current)
    } catch (error) {
      setModel((state) => (state ? { ...state, busy: false, problem: writeProblem(error) } : state))
    }
  }, [api])

  const open = useCallback(
    (start?: { order: OrderOption; styleId?: string | null; /* F-OO-123 */ lineId?: string | null }) => {
      if (!start) return setModel({ ...NO_NEW_ORDER })
      // The order page: the order fixed (no search), then the style step (F-OO-123: or that one line of it).
      setModel({ ...NO_NEW_ORDER, fixed: true, query: start.order.number, orders: [start.order] })
      void chooseOrder(start.order, start.styleId ?? null, start.lineId ?? null)
    },
    [chooseOrder],
  )
  const close = useCallback(() => setModel(null), [])

  const actions: NewWorkOrderActions = {
    onQuery: (query) => void searchOrders(query),
    onChoose: (order) => void chooseOrder(order),
    onStyle: (styleId) => setModel((current) => (current ? { ...current, ...pickOfStyle(current.lines, styleId) } : current)),
    onPick: (lineId, on) =>
      setModel((current) => {
        if (!current) return current
        const line = current.lines?.lines.find((entry) => entry.id === lineId)
        const picked = pickedAfter(current.lines?.lines ?? [], current.picked, lineId, on) // B-W2b-368: a unit alone
        const grid = { ...current.grid }
        if (on && line && !grid[lineId]) grid[lineId] = openGridOf(line)
        return { ...current, picked, grid }
      }),
    onGrid: (grid) => setModel((current) => (current ? { ...current, grid } : current)),
    onDueDate: (dueDate) => setModel((current) => (current ? { ...current, dueDate } : current)),
    onCreate: () => void create(),
  }

  return { model, open, close, actions }
}
