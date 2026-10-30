'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useLiveChanges } from '../../../record-panels/live'
import { downloadCsv, libraryCan, readProblem, writeProblem, type Notice } from '../library/model'
import { archiveOperation, countOperations, createOperation, listOperations, reactivateOperation } from './api'
import { bodyOf, emptyDraft, listQuery, OPERATION_TILES, operationsCsv, viewOf, viewQuery, WORK_CENTRE_KINDS, type OperationFilters, type WorkCentreKind } from './model'
import { OperationsListView, type NewOperationModel, type OperationsListViewModel } from './view/OperationsListView'

function filtersOf(params: URLSearchParams | null): OperationFilters {
  const kind = params?.get('kind') ?? ''
  return { view: viewOf(params?.get('view')), q: params?.get('q') ?? '', kind: (WORK_CENTRE_KINDS as readonly string[]).includes(kind) ? (kind as WorkCentreKind) : '' }
}

function searchOf(filters: OperationFilters): string {
  const search = new URLSearchParams()
  if (filters.view !== 'open') search.set('view', filters.view)
  if (filters.kind) search.set('kind', filters.kind)
  if (filters.q.trim()) search.set('q', filters.q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

/**
 * `/w/<company>/products/operations` (SCR-049): the operation library the person may read (product.routing.view), the
 * tiles' counts (one count per saved view), live operation.* changes behind "N updates · Show", New operation
 * (`?new=1`, `c`: creates and opens the record), Archive N / Reactivate N one by one with their versions.
 */
export function OperationsPage() {
  return (
    <WithMessages namespaces={['library']}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const t = useT('library')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filters = useMemo(() => filtersOf(params), [params])
  const can = useMemo(() => libraryCan(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/products\/operations\/?$/, '')
  const companyId = session.company?.id ?? null
  const [rows, setRows] = useState<OperationsListViewModel['rows']>({ items: null, more: false, count: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [tiles, setTiles] = useState<OperationsListViewModel['tiles']>({})
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [newOperation, setNewOperation] = useState<NewOperationModel | null>(null)
  const readSeq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++readSeq.current
    setRows((current) => ({ ...current, items: null, problem: null }))
    try {
      const page = await listOperations(api, listQuery(filters, null))
      if (mine !== readSeq.current) return
      setRows({ items: page.operations, more: page.nextCursor !== null, count: page.count, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (mine === readSeq.current) setRows({ items: null, more: false, count: null, problem: readProblem(error) })
    }
  }, [api, filters])

  const loadTiles = useCallback(() => {
    for (const tile of OPERATION_TILES) {
      countOperations(api, viewQuery(tile))
        .then((count) => setTiles((current) => ({ ...current, [tile]: count })))
        .catch(() => setTiles((current) => ({ ...current, [tile]: null })))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    loadTiles()
  }, [loadTiles])

  const askedNew = params?.get('new') === '1'
  useEffect(() => {
    if (askedNew && can.operationsManage) openNew(true)
  }, [askedNew])

  useLiveChanges({
    onChange: (change) => {
      if (change.type.startsWith('operation.') || change.type === 'style.routing_changed') setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  const setFilters = (next: OperationFilters) => router.replace(`${pathname}${searchOf(next)}`)

  const more = async () => {
    if (!cursor) return
    try {
      const page = await listOperations(api, listQuery(filters, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.operations], more: page.nextCursor !== null, count: page.count, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ key: readProblem(error), tone: 'danger' })
    }
  }

  const exportCsv = (ids: string[]) => {
    const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
    const csv = operationsCsv(picked, {
      header: ['csv.code', 'csv.name', 'csv.department', 'csv.machine', 'csv.skill', 'csv.smv', 'csv.usedIn', 'csv.differing', 'csv.status'].map((key) => t(key)),
      kind: (kind) => t(`department.${kind}`),
      status: (status) => t(`status.${status}`),
    })
    downloadCsv(`operations-${new Date().toISOString().slice(0, 10)}.csv`, csv)
  }

  const statusMany = async (ids: string[], to: 'ARCHIVED' | 'ACTIVE', reason: string): Promise<boolean> => {
    setBusy(true)
    let done = 0
    try {
      for (const id of ids) {
        const row = (rows.items ?? []).find((entry) => entry.id === id)
        if (!row || row.status === to) continue
        await (to === 'ARCHIVED' ? archiveOperation(api, row, reason || undefined) : reactivateOperation(api, row))
        done++
      }
      setNotice({ key: to === 'ARCHIVED' ? 'operations.notice.archived' : 'operations.notice.reactivated', tone: 'success', params: { count: done } })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error).key, tone: 'danger' })
      return false
    } finally {
      setBusy(false)
      void load()
      loadTiles()
    }
  }

  function openNew(open: boolean) {
    if (!open) {
      setNewOperation(null)
      if (askedNew) router.replace(`${pathname}${searchOf(filters)}`)
      return
    }
    setNewOperation({ draft: emptyDraft(companyId), companies: session.companies.map((company) => ({ id: company.id, name: company.name })), busy: false, problem: null, refused: [] })
  }

  const create = async () => {
    const model = newOperation
    if (!model) return
    setNewOperation({ ...model, busy: true, problem: null, refused: [] })
    try {
      const operation = await createOperation(api, bodyOf(model.draft))
      router.push(`${prefix}/products/operations/${operation.id}`)
    } catch (error) {
      const problem = writeProblem(error)
      setNewOperation((current) => (current ? { ...current, busy: false, problem: problem.key, refused: problem.paths } : current))
    }
  }

  const model: OperationsListViewModel = { prefix, can, filters, rows, tiles, asOf, updates, newOperation, busy, notice }
  return (
    <OperationsListView
      model={model}
      actions={{
        onFilters: setFilters,
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => {
          void load()
          loadTiles()
        },
        onOpen: (id) => router.push(`${prefix}/products/operations/${id}`),
        onExport: exportCsv,
        onStatusMany: statusMany,
        onNew: openNew,
        onDraft: (draft) => setNewOperation((current) => (current ? { ...current, draft, refused: [] } : current)),
        onCreate: () => void create(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
