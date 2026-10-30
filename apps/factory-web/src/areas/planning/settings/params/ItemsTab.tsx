'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ItemPlanningPatch } from '@nexus/factory-domain/planning/settings/items'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../../../_shared/buying/hooks'
import { createItemParameters, deleteItemParameters, editItemParameters, itemSuppliers, listItemParameters, planningMethod, type ItemEntry, type ItemParameters } from '../api'
import { readProblem, type TabHost } from '../model'
import { useEchoes, useMarks, useRowQueue } from './hooks'
import { bulkResult, clearedWords, itemRowsOf, parseCell, planPatch, refusalWords, rowKeyOf, rowName, valuesOf, withoutRow, withRow, type CellField, type ItemRow, type Notice, type Words } from './model'
import { ItemsView, type ItemsModel, type SupplierChoices } from './view/ItemsView'

const PAGE = 50
const SEARCH_MS = 300

/** A row's last save, for ⌘Z while the value is still ours (the version our save made). */
interface LastSave {
  rowKey: string
  field: CellField
  before: ItemPlanningPatch | null
  version: number
  rowId: string
}

/**
 * Planning settings › Item parameters (SCR-127, design sec:items): reads the site's items with their defaults and rows
 * (`GET /planning/item-parameters?siteId&q&method&configured`, pages of 50 by cursor), saves each cell on its own (POST
 * when the item has no row yet, else PATCH at the version read; a row's writes wait for each other), the method and
 * source dialogs' changes, a reviewed bulk edit and "Plan N by defaults" (one write after the other, the result named row
 * by row), ⌘Z for the last cell while its value is still ours. Live `planning.item_parameters_changed` of this site from
 * someone else → "Changed by someone else · Reload". The address keeps `?q=` `?method=` `?configured=`.
 */
export function ItemsTab({ host }: { host: TabHost }) {
  const api = useOfficeApi()
  const site = host.site
  const query = host.param('q') ?? ''
  const methodParam = planningMethod.safeParse(host.param('method'))
  const method = methodParam.success ? methodParam.data : null
  const configuredParam = host.param('configured')
  const configured = configuredParam === 'true' ? true : configuredParam === 'false' ? false : null
  const [typed, setTyped] = useState(query)
  const [load, setLoad] = useState<ItemsModel['load']>({ status: 'loading' })
  const [entries, setEntries] = useState<ItemEntry[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [busy, setBusy] = useState(false)
  const [suppliers, setSuppliers] = useState<SupplierChoices | null>(null)
  const { marks, setMark, fade, failedCount } = useMarks()
  const queue = useRowQueue()
  const echoes = useEchoes()
  const entriesRef = useRef<ItemEntry[] | null>(null)
  entriesRef.current = entries
  const last = useRef<LastSave | null>(null)
  const onStatus = host.onStatus

  const read = useCallback(async () => {
    try {
      const page = await listItemParameters(api, { siteId: site.id, ...(query ? { q: query } : {}), ...(method ? { method } : {}), ...(configured !== null ? { configured } : {}), limit: PAGE })
      setEntries(page.items)
      setCursor(page.nextCursor)
      setLoad({ status: 'ready' })
      setChangedElsewhere(false)
    } catch (error) {
      setEntries(null)
      setLoad({ status: 'error', problem: readProblem(error) })
    }
  }, [api, site.id, query, method, configured])
  useEffect(() => {
    setLoad({ status: 'loading' })
    setEntries(null)
    void read()
  }, [read])

  // The search goes to the address after a pause (the API filters).
  useEffect(() => setTyped(query), [query])
  const setParams = useRef(host.setParams)
  setParams.current = host.setParams
  useEffect(() => {
    if (typed.trim() === query) return
    const timer = setTimeout(() => setParams.current({ q: typed.trim() || null }), SEARCH_MS)
    return () => clearTimeout(timer)
  }, [typed, query])

  useLive(
    (change) => {
      if (change.type !== 'planning.item_parameters_changed' || change.fields.siteId !== site.id) return
      const key = rowKeyOf(String(change.fields.itemId), change.fields.itemColourId ? String(change.fields.itemColourId) : null)
      if (echoes.isOurs(key)) return
      setChangedElsewhere(true)
    },
    () => void read(),
  )

  const rowNow = (rowKey: string): ItemRow | null => itemRowsOf(entriesRef.current ?? []).find((row) => row.key === rowKey) ?? null

  /** One row's write at the version it has now (after the row's earlier writes); the answer replaces the row. */
  const write = (rowKey: string, patch: ItemPlanningPatch): Promise<{ ok: true; row: ItemParameters; cleared: string[] } | { ok: false; words: Words; conflict: boolean; unknown: boolean }> =>
    queue(rowKey, async () => {
      const row = rowNow(rowKey)
      if (!row) return { ok: false as const, words: { key: 'ps.problem.gone' }, conflict: false, unknown: false }
      const plan = planPatch(row.row, patch)
      if (plan.kind === 'refused') return { ok: false as const, words: plan.words, conflict: false, unknown: false }
      if (plan.kind === 'none') return row.row ? { ok: true as const, row: row.row, cleared: [] } : { ok: false as const, words: { key: 'pp.held.same' }, conflict: false, unknown: false }
      echoes.expect(rowKey)
      try {
        const answer = row.row
          ? await editItemParameters(api, row.row.id, { ...plan.patch, version: row.row.version }, newIdempotencyKey())
          : await createItemParameters(api, { siteId: site.id, itemId: row.item.id, itemColourId: row.colour?.id ?? null, ...plan.patch }, newIdempotencyKey())
        setEntries((current) => (current ? withRow(current, answer.parameters) : current))
        return { ok: true as const, row: answer.parameters, cleared: answer.cleared }
      } catch (error) {
        const refusal = refusalWords(error)
        if (refusal.conflict) setChangedElsewhere(true)
        return { ok: false as const, ...refusal }
      }
    })

  const saveCell = (rowKey: string, field: CellField, patch: ItemPlanningPatch, remember = true) => {
    const before = rowNow(rowKey)
    const plan = planPatch(before?.row ?? null, patch)
    if (plan.kind === 'none') return
    if (plan.kind === 'refused') {
      setMark(rowKey, field, { state: 'refused', problem: plan.words })
      return
    }
    setMark(rowKey, field, { state: 'saving' })
    onStatus({ kind: 'saving' })
    void write(rowKey, patch).then((outcome) => {
      if (outcome.ok) {
        setMark(rowKey, field, { state: 'saved' })
        fade(rowKey, field)
        onStatus({ kind: 'saved', at: new Date().toISOString() })
        const cleared = clearedWords(outcome.cleared)
        if (cleared) setNotice({ tone: 'info', words: cleared })
        if (remember) {
          const old = valuesOf(before?.row ?? null)
          last.current = { rowKey, field, rowId: outcome.row.id, version: outcome.row.version, before: old ? (Object.fromEntries(Object.keys(plan.patch).map((key) => [key, old[key as keyof typeof old]])) as ItemPlanningPatch) : null }
        }
      } else {
        setMark(rowKey, field, { state: outcome.unknown ? 'unknown' : 'refused', problem: outcome.words })
        onStatus({ kind: 'failed', count: failedCount + 1 })
      }
    })
  }

  // ⌘Z: the last cell save back, while the row is still at the version our save made (else it is someone else's now).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('input, textarea, select, [role="dialog"], .ag-cell-inline-editing')) return
      const undo = last.current
      if (!undo || !host.can.manageItems) return
      event.preventDefault()
      const row = rowNow(undo.rowKey)
      if (!row?.row || row.row.id !== undo.rowId || row.row.version !== undo.version) {
        setNotice({ tone: 'warning', words: { key: 'pp.undo.notOurs' } })
        last.current = null
        return
      }
      last.current = null
      if (undo.before === null) {
        void removeRows([row]).then(() => setNotice({ tone: 'success', words: { key: 'pp.undo.done', params: { item: rowName(row) } } }))
        return
      }
      saveCell(undo.rowKey, undo.field, undo.before, false)
      setNotice({ tone: 'success', words: { key: 'pp.undo.done', params: { item: rowName(row) } } })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const removeRows = async (rows: readonly ItemRow[]): Promise<{ saved: number; refused: { name: string; words: Words }[] }> => {
    let saved = 0
    const refused: { name: string; words: Words }[] = []
    for (const row of rows) {
      const outcome = await queue(row.key, async () => {
        const now = rowNow(row.key)
        if (!now?.row) return null
        echoes.expect(row.key)
        try {
          await deleteItemParameters(api, now.row.id, { version: now.row.version }, newIdempotencyKey())
          setEntries((current) => (current ? withoutRow(current, now.item.id, now.row!.id) : current))
          return null
        } catch (error) {
          const refusal = refusalWords(error)
          if (refusal.conflict) setChangedElsewhere(true)
          return refusal.words
        }
      })
      if (outcome) refused.push({ name: rowName(row), words: outcome })
      else saved += 1
    }
    return { saved, refused }
  }

  const rows = useMemo(() => (entries ? itemRowsOf(entries) : null), [entries])

  const model: ItemsModel = {
    prefix: host.prefix,
    site,
    sites: host.sites,
    can: host.can,
    load,
    rows,
    more: cursor !== null,
    loadingMore,
    query: typed,
    method,
    configured,
    marks,
    notice,
    changedElsewhere,
    busy,
    suppliers,
  }

  return (
    <ItemsView
      model={model}
      actions={{
        onQuery: setTyped,
        onMethod: (next) => host.setParams({ method: next }),
        onConfigured: (next) => host.setParams({ configured: next === null ? null : String(next) }),
        onMore: () => {
          if (!cursor || loadingMore) return
          setLoadingMore(true)
          listItemParameters(api, { siteId: site.id, ...(query ? { q: query } : {}), ...(method ? { method } : {}), ...(configured !== null ? { configured } : {}), cursor, limit: PAGE })
            .then((page) => {
              setEntries((current) => [...(current ?? []), ...page.items.filter((entry) => !(current ?? []).some((other) => other.item.id === entry.item.id))])
              setCursor(page.nextCursor)
            })
            .catch((error: unknown) => setNotice({ tone: 'danger', words: { key: readProblem(error) } }))
            .finally(() => setLoadingMore(false))
        },
        onRetry: () => {
          setLoad({ status: 'loading' })
          void read()
        },
        onReload: () => void read(),
        onCell: (row, field, raw) => {
          const parsed = parseCell(field, raw)
          if ('problem' in parsed) {
            setMark(row.key, field, { state: 'refused', problem: parsed.problem })
            return
          }
          saveCell(row.key, field, { [field]: parsed.value } as ItemPlanningPatch)
        },
        onPatch: (row, field, patch) => saveCell(row.key, field, patch as ItemPlanningPatch),
        onSuppliers: (row) => {
          setSuppliers({ itemId: row.item.id, status: 'loading', items: [] })
          itemSuppliers(api, row.item.id)
            .then((items) =>
              setSuppliers({
                itemId: row.item.id,
                status: 'ready',
                items: items.filter((entry) => entry.status === 'ACTIVE').map((entry) => ({ id: entry.partyId, code: entry.supplier.code, name: entry.supplier.name })),
              }),
            )
            .catch(() => setSuppliers({ itemId: row.item.id, status: 'error', items: [] }))
        },
        onBulk: async (lines) => {
          setBusy(true)
          setNotice(null)
          let saved = 0
          const refused: { name: string; words: Words }[] = []
          for (const line of lines) {
            if (line.plan.kind !== 'write') continue
            setMark(line.row.key, 'method', null)
            const outcome = await write(line.row.key, line.plan.patch as ItemPlanningPatch)
            if (outcome.ok) saved += 1
            else refused.push({ name: rowName(line.row), words: outcome.words })
          }
          setBusy(false)
          setNotice(bulkResult(saved, refused))
          onStatus(saved > 0 ? { kind: 'saved', at: new Date().toISOString() } : { kind: 'failed', count: refused.length })
          return true
        },
        onDefaults: async (rows) => {
          setBusy(true)
          setNotice(null)
          const result = await removeRows(rows)
          setBusy(false)
          setNotice(result.refused.length === 0 ? { tone: 'success', words: { key: 'pp.defaults.done', params: { count: result.saved } } } : bulkResult(result.saved, result.refused))
          if (result.saved > 0) onStatus({ kind: 'saved', at: new Date().toISOString() })
          return true
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
