'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Tone } from '@nexus/ui/primitives'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { useT } from '../../../../../lib/i18n/provider'
import { isApiError } from '../../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import type { Translate } from '../../../../../lib/i18n/messages'
import type { OrdersSheetOrder, SheetColumnId, SheetCommit, SheetCommitAnswer } from '../../../../../lib/orders-sheet/model'
import { parseTarget } from '../../../../../lib/orders-sheet/rows'
import { pictureReader } from '../../../../../lib/record-picture/api'
import type { SheetPictures } from '../../../../../lib/orders-sheet/pictures'
import { useCoalesced, useLive, downloadText, type LiveState } from '../../hooks'
import { listTouches, partyFromAddress } from '../../model'
import { confirmDraft, officeDraftPort } from '../../draft/api'
import type { DraftRecord } from '../../../../../lib/order-draft/schema'
import { isSheetFilter, readSheet, restrictOrder, type SheetFilter, type SheetRowRead, type SheetTiles } from './api'
import { NS, commitRouteOf, confirmPlanOf, csvOf, deletePlanOf, orderKeyOf, pageOf, patchRow, restrictPlanOf, rowOfKey, sheetOrderOf } from './map'

/**
 * owb-of3 steps 3–4 — the office Orders sheet's state: its read (`GET /sales/orders/sheet`, the filter and the search in the address:
 * `?life=`, `?q=`), live changes behind "N updates · Show" (rows never jump; the changed rows flash after Show), every typed cell
 * routed by L2 (a draft saves in place through today's office draft routes; a confirmed order's sizes open Review and save), every
 * door the part hands back, and the bulk acts (each skips what it cannot do and says how many). No price anywhere.
 */

export type OfficeWindowState =
  | { readonly kind: 'pick'; readonly seed: { readonly column: SheetColumnId; readonly value: string } }
  | { readonly kind: 'delete'; readonly rows: readonly SheetRowRead[] }
  | { readonly kind: 'asks'; readonly row: SheetRowRead }
  | { readonly kind: 'review'; readonly row: SheetRowRead; readonly lineId: string; readonly sizes: Readonly<Record<string, number>> }
  | { readonly kind: 'picture'; readonly row: SheetRowRead }
  | { readonly kind: 'print' | 'printAgain' | 'ship'; readonly orderId: string }

export interface OfficeSheetModel {
  readonly prefix: string
  readonly companyId: string
  readonly manage: boolean
  readonly filter: SheetFilter
  readonly q: string
  readonly rows: readonly SheetRowRead[] | null
  readonly orders: readonly OrdersSheetOrder[]
  readonly tiles: SheetTiles | null
  readonly more: boolean
  readonly loading: boolean
  readonly problem: string | null
  readonly live: LiveState
  readonly updates: number
  readonly lastChange: string | null
  readonly flashKeys: readonly string[]
  readonly notice: { readonly tone: Tone; readonly words: string } | null
  readonly window: OfficeWindowState | null
  readonly pictures: SheetPictures
}

export interface OfficeSheetActions {
  onFilter(filter: SheetFilter): void
  onSearch(q: string): void
  onMore(): void
  onShowUpdates(): void
  onCommit(commit: SheetCommit): Promise<SheetCommitAnswer>
  onOpen(target: string): void
  onNewOrder(seed: { column: SheetColumnId; value: string }): Promise<void>
  onLayout(layout: 'list' | 'board' | 'week'): void
  onCloseWindow(): void
  /** A window did its work: the sheet reads again and says what happened (words already in the person's language). */
  onDone(words: string | null, tone?: Tone): void
  onDismissNotice(): void
  readonly bulk: ReadonlyArray<{ id: string; words: string; icon: string; primary?: boolean; run(keys: readonly string[]): void }>
}

/** A refused write in the person's words (never the API's English). */
export function refusalWordsOf(error: unknown, t: Translate): string {
  if (isApiError(error)) {
    if (error.kind === 'conflict') return t('office.refused.stale')
    if (error.kind === 'forbidden') return t('office.refused.forbidden')
    if (error.kind === 'not_found') return t('office.refused.gone')
    if (error.kind === 'invalid') return t('office.refused.invalid')
    if (error.kind === 'unavailable') return t('office.refused.offline')
  }
  return t('office.refused.failed')
}

/** The live events that touch the sheet: an order's, a request's (draft, sent, accepted …), a customer's ask. */
export const sheetTouches = (change: { type: string }): boolean => listTouches(change) || change.type.startsWith('portal_order_request.') || change.type.startsWith('order_change_request.')

/** After "Show": the rows that are new or changed since the last read (they flash once). */
export function changedKeysOf(before: readonly SheetRowRead[] | null, after: readonly SheetRowRead[]): string[] {
  if (!before) return []
  const known = new Map(before.map((row) => [orderKeyOf(row), row.version]))
  return after.filter((row) => known.get(orderKeyOf(row)) !== row.version).map(orderKeyOf)
}

const PAGE = 50

export function useOfficeSheet(): { model: OfficeSheetModel; actions: OfficeSheetActions } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const t = useT(NS)
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? session.companies[0]?.id ?? ''
  const manage = session.permissions.includes('orders.manage')
  const asked = params?.get('life') ?? null
  const filter: SheetFilter = isSheetFilter(asked) ? asked : 'all'
  const q = params?.get('q') ?? ''
  // B-TH-201: one customer's orders (`?party=<id>`, Sales › Reports' drill) — the read's own party filter.
  const partyId = partyFromAddress(params)

  const [rows, setRows] = useState<readonly SheetRowRead[] | null>(null)
  const [tiles, setTiles] = useState<SheetTiles | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [lastChange, setLastChange] = useState<string | null>(null)
  const [flashKeys, setFlashKeys] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<OfficeSheetModel['notice']>(null)
  // `?new=1` (a door from another page): New order opens at once, for a person who may.
  const [shown, setShown] = useState<OfficeWindowState | null>(() => (params?.get('new') === '1' && manage ? { kind: 'pick', seed: { column: 'customer', value: '' } } : null))
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const readId = useRef(0)

  const load = useCallback(
    async (more: string | null = null) => {
      const id = ++readId.current
      setLoading(true)
      try {
        const answer = await readSheet(api, { life: filter, q, partyId, cursor: more, limit: PAGE })
        if (id !== readId.current) return
        const before = rowsRef.current
        setRows((current) => (more ? [...(current ?? []), ...answer.rows] : answer.rows))
        setTiles(answer.tiles)
        setCursor(answer.nextCursor)
        setProblem(null)
        setUpdates(0)
        if (!more) {
          const changed = changedKeysOf(before, answer.rows)
          setFlashKeys(changed)
        }
      } catch (error) {
        if (id !== readId.current) return
        setProblem(refusalWordsOf(error, t))
      } finally {
        if (id === readId.current) setLoading(false)
      }
    },
    [api, filter, q, partyId, t],
  )
  useEffect(() => {
    setRows(null)
    void load(null)
  }, [load])
  // A flash is said once.
  useEffect(() => {
    if (flashKeys.length === 0) return
    const timer = setTimeout(() => setFlashKeys([]), 2000)
    return () => clearTimeout(timer)
  }, [flashKeys])

  // Live: a change waits behind "N updates · Show" (rows never move under the person); the tiles' counts follow at once.
  const recount = useCoalesced(() => {
    readSheet(api, { life: filter, q, partyId, cursor: null, limit: 1 })
      .then((answer) => setTiles(answer.tiles))
      .catch(() => undefined)
  }, 800)
  const live = useLive(
    (change) => {
      if (!sheetTouches(change)) return
      setUpdates((count) => count + 1)
      setLastChange(new Date().toISOString())
      recount()
    },
    () => setUpdates((count) => count + 1),
  )

  const go = useCallback(
    (next: { life?: SheetFilter; q?: string }) => {
      const search = new URLSearchParams()
      const life = next.life ?? filter
      const words = next.q ?? q
      if (life !== 'all') search.set('life', life)
      if (words.trim()) search.set('q', words.trim())
      if (partyId) search.set('party', partyId)
      const tail = search.toString()
      router.replace(`${prefix}/sales/orders${tail ? `?${tail}` : ''}`)
    },
    [router, prefix, filter, q, partyId],
  )

  // ---- typing (L2) -------------------------------------------------------------------------------------------------------------
  const port = useMemo(() => officeDraftPort(api), [api])
  const onCommit = useCallback(
    async (commit: SheetCommit): Promise<SheetCommitAnswer> => {
      const found = rowOfKey(rowsRef.current ?? [], commit.orderKey, commit.lineKey)
      if (!found) return { kind: 'REFUSED', words: t('office.refused.gone') }
      const { row, line } = found
      const route = commitRouteOf(row, line, commit.column, commit.value)
      if (route.kind === 'refused') return { kind: 'REFUSED', words: t(`office.refused.${route.why}`) }
      if (route.kind === 'review') {
        setShown({ kind: 'review', row, lineId: route.lineId, sizes: route.sizes })
        return { kind: 'REVIEW' }
      }
      try {
        let record: DraftRecord
        if (route.kind === 'header') record = await port.header(route.requestId, { version: row.version, ...route.body }, newIdempotencyKey())
        else if (route.kind === 'line') record = await port.changeLine(route.requestId, route.lineId, { version: row.version, sizes: route.body.sizes }, newIdempotencyKey())
        else record = await port.changeCustomLine(route.requestId, route.lineId, { version: row.version, ...route.body }, newIdempotencyKey())
        const saved = patchRow(row, line?.id ?? null, commit.column, commit.value, record.request.version)
        setRows((current) => current?.map((entry) => (orderKeyOf(entry) === commit.orderKey ? saved : entry)) ?? current)
        return { kind: 'SAVED' }
      } catch (error) {
        return { kind: 'REFUSED', words: refusalWordsOf(error, t) }
      }
    },
    [port, t],
  )

  // ---- doors ---------------------------------------------------------------------------------------------------------------------
  const rowOf = useCallback((key: string) => (rowsRef.current ?? []).find((row) => orderKeyOf(row) === key) ?? null, [])
  const onOpen = useCallback(
    (target: string) => {
      const { act, key } = parseTarget(target)
      if (act === 'page') {
        router.push(key)
        return
      }
      const row = rowOf(key)
      if (!row) return
      switch (act) {
        case 'open':
        case 'addLine':
          router.push(pageOf(prefix, row))
          return
        case 'confirm':
          // L3: Confirm lives on today's office page of a draft or sent order; `confirm=1` asks it to open the Confirm window.
          router.push(row.kind === 'REQUEST' ? `${pageOf(prefix, row)}&confirm=1` : pageOf(prefix, row))
          return
        case 'deleteDraft':
          if (row.kind === 'REQUEST' && row.life === 'DRAFT' && row.may.deleteDraft) setShown({ kind: 'delete', rows: [row] })
          return
        case 'picture':
          if (manage && row.life !== 'WITHDRAWN') setShown({ kind: 'picture', row })
          else router.push(pageOf(prefix, row))
          return
        case 'asks':
          setShown({ kind: 'asks', row })
          return
        case 'print':
        case 'printAgain':
        case 'ship':
          if (row.kind === 'ORDER') setShown({ kind: act as 'print' | 'printAgain' | 'ship', orderId: row.id })
          return
        default:
          return
      }
    },
    [router, prefix, rowOf, manage],
  )
  const onNewOrder = useCallback(
    async (seed: { column: SheetColumnId; value: string }) => {
      if (!manage) {
        setNotice({ tone: 'warning', words: t('office.refused.forbidden') })
        return
      }
      setShown({ kind: 'pick', seed })
    },
    [manage, t],
  )

  // ---- bulk: each act skips what it cannot do and says how many ---------------------------------------------------------------------
  const runConfirm = useCallback(
    async (keys: readonly string[]) => {
      const plan = confirmPlanOf(rowsRef.current ?? [], keys)
      let done = 0
      let refused = 0
      for (const row of plan.go) {
        try {
          await confirmDraft(api, row.id, { version: row.version, as: 'ORDER' })
          done++
        } catch {
          refused++
        }
      }
      const parts = [t('office.bulk.confirmed', { count: done })]
      if (plan.text > 0) parts.push(t('office.bulk.skippedText', { count: plan.text }))
      if (plan.held > 0) parts.push(t('office.bulk.skippedHeld', { count: plan.held }))
      if (plan.other > 0) parts.push(t('office.bulk.skippedOther', { count: plan.other }))
      if (refused > 0) parts.push(t('office.bulk.refused', { count: refused }))
      setNotice({ tone: refused > 0 || done === 0 ? 'warning' : 'success', words: parts.join(' · ') })
      void load(null)
    },
    [api, t, load],
  )
  const runRestrict = useCallback(
    async (keys: readonly string[]) => {
      const plan = restrictPlanOf(rowsRef.current ?? [], keys)
      let done = 0
      let refused = 0
      for (const row of plan.go) {
        try {
          await restrictOrder(api, row.id, { version: row.version, restricted: true })
          done++
        } catch {
          refused++
        }
      }
      const parts = [t('office.bulk.restricted', { count: done })]
      if (plan.other > 0) parts.push(t('office.bulk.skippedNotOrder', { count: plan.other }))
      if (refused > 0) parts.push(t('office.bulk.refused', { count: refused }))
      setNotice({ tone: refused > 0 || done === 0 ? 'warning' : 'success', words: parts.join(' · ') })
      void load(null)
    },
    [api, t, load],
  )
  const lifeT = useT('order-life')
  const runExport = useCallback(
    (keys: readonly string[]) => {
      const text = csvOf(rowsRef.current ?? [], keys, t, (row) => lifeT(`life.${row.life}`))
      downloadText(`orders-${new Date().toISOString().slice(0, 10)}.csv`, text)
    },
    [t, lifeT],
  )
  const openDelete = useCallback(
    (keys: readonly string[]) => {
      const plan = deletePlanOf(rowsRef.current ?? [], keys)
      if (plan.go.length === 0) {
        setNotice({ tone: 'warning', words: t('office.bulk.noDrafts') })
        return
      }
      setShown({ kind: 'delete', rows: plan.go })
    },
    [t],
  )
  const bulk = useMemo(
    () => [
      ...(manage
        ? [
            { id: 'confirm', words: t('office.bulk.confirm'), icon: 'check', primary: true, run: (keys: readonly string[]) => void runConfirm(keys) },
            { id: 'deleteDrafts', words: t('office.bulk.deleteDrafts'), icon: 'trash-2', run: openDelete },
            { id: 'restrict', words: t('office.bulk.restrict'), icon: 'lock', run: (keys: readonly string[]) => void runRestrict(keys) },
          ]
        : []),
      { id: 'export', words: t('office.bulk.export'), icon: 'download', run: runExport },
    ],
    [manage, t, runConfirm, openDelete, runRestrict, runExport],
  )

  const orders = useMemo(() => (rows ?? []).map((row) => sheetOrderOf(row, prefix, t)), [rows, prefix, t])
  const pictures = useMemo<SheetPictures>(() => ({ read: pictureReader(api), sourceOf: (record) => (record.kind === 'ORDER' ? 'order' : 'portalOrder') }), [api])

  const model: OfficeSheetModel = { prefix, companyId, manage, filter, q, rows, orders, tiles, more: cursor !== null, loading, problem, live, updates, lastChange, flashKeys, notice, window: shown, pictures }
  const actions: OfficeSheetActions = {
    onFilter: (next) => go({ life: next }),
    onSearch: (words) => go({ q: words }),
    onMore: () => cursor && void load(cursor),
    onShowUpdates: () => void load(null),
    onCommit,
    onOpen,
    onNewOrder,
    onLayout: (layout) => router.replace(layout === 'list' ? `${prefix}/sales/orders` : `${prefix}/sales/orders?view=${layout}`),
    onCloseWindow: () => setShown(null),
    onDone: (words, tone = 'success') => {
      setShown(null)
      if (words) setNotice({ tone, words })
      void load(null)
    },
    onDismissNotice: () => setNotice(null),
    bulk,
  }
  return { model, actions }
}
