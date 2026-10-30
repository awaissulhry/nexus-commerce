'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useLiveChanges } from '../../../record-panels/live'
import { downloadCsv, libraryCan, readProblem, writeProblem, type Notice } from '../library/model'
import { archiveMaterial, countMaterials, createMaterial, findSuppliers, listMaterials, setStandardCost } from './api'
import type { MaterialsListViewModel, NewMaterialModel } from './list-model'
import { bodyOf, draftFor, ITEM_KINDS, listQuery, materialsCsv, tilesFor, viewOf, viewQuery, type ItemKind, type MaterialFilters, type MaterialTile } from './model'
import { MaterialsListView } from './view/MaterialsListView'

/** The filters in the address (`?view=leather&kind=LINING&q=…`), so a filtered list can be shared. */
function filtersOf(params: URLSearchParams | null, seesCost: boolean): MaterialFilters {
  const view = viewOf(params?.get('view'))
  const kind = params?.get('kind') ?? ''
  return { view: view === 'missingCost' && !seesCost ? 'open' : view, q: params?.get('q') ?? '', kind: (ITEM_KINDS as readonly string[]).includes(kind) ? (kind as ItemKind) : '' }
}

function searchOf(filters: MaterialFilters): string {
  const search = new URLSearchParams()
  if (filters.view !== 'open') search.set('view', filters.view)
  if (filters.kind) search.set('kind', filters.kind)
  if (filters.q.trim()) search.set('q', filters.q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

/**
 * `/w/<company>/products/materials` (SCR-047): reads the materials the person may see (product.materials.view; the API
 * filters by company and drops the standard cost without the cost grain), the tiles' counts (one count per saved filter),
 * and keeps live material.* changes behind "N updates · Show". New material (`?new=1`, `c`) creates and opens the record.
 */
export function MaterialsPage() {
  return (
    <WithMessages namespaces={['library']}>
      <MaterialsContainer />
    </WithMessages>
  )
}

function MaterialsContainer() {
  const t = useT('library')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => libraryCan(session.permissions), [session.permissions])
  const filters = useMemo(() => filtersOf(params, can.seesCost), [params, can.seesCost])
  const prefix = pathname.replace(/\/products\/materials\/?$/, '')
  const companyId = session.company?.id ?? null
  const [rows, setRows] = useState<MaterialsListViewModel['rows']>({ items: null, more: false, count: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [tiles, setTiles] = useState<MaterialsListViewModel['tiles']>({})
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [newMaterial, setNewMaterial] = useState<NewMaterialModel | null>(null)
  const readSeq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++readSeq.current
    setRows((current) => ({ ...current, items: null, problem: null }))
    try {
      const page = await listMaterials(api, listQuery(filters, null))
      if (mine !== readSeq.current) return
      setRows({ items: page.materials, more: page.nextCursor !== null, count: page.count, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (mine === readSeq.current) setRows({ items: null, more: false, count: null, problem: readProblem(error) })
    }
  }, [api, filters])

  const loadTiles = useCallback(() => {
    for (const tile of tilesFor(can)) {
      setTiles((current) => ({ ...current, [tile]: current[tile as MaterialTile] ?? null }))
      countMaterials(api, viewQuery(tile))
        .then((count) => setTiles((current) => ({ ...current, [tile]: count })))
        .catch(() => setTiles((current) => ({ ...current, [tile]: null })))
    }
  }, [api, can])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    loadTiles()
  }, [loadTiles])

  // `?new=1` (Today's New ▾, the BOM line's "Create …") opens New material once.
  const askedNew = params?.get('new') === '1'
  useEffect(() => {
    if (askedNew && can.materialsManage) openNew(true)
    // Only when the address asks.
  }, [askedNew])

  useLiveChanges({
    onChange: (change) => {
      if (change.type.startsWith('material.')) setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  const setFilters = (next: MaterialFilters) => router.replace(`${pathname}${searchOf(next)}`)

  const more = async () => {
    if (!cursor) return
    try {
      const page = await listMaterials(api, listQuery(filters, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.materials], more: page.nextCursor !== null, count: page.count, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ key: readProblem(error), tone: 'danger' })
    }
  }

  const exportCsv = (ids: string[]) => {
    const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
    const csv = materialsCsv(picked, {
      header: ['csv.code', 'csv.name', 'csv.kind', 'csv.baseUom', 'csv.purchaseUom', 'csv.consumptionUom', 'csv.supplier', 'csv.standardCost', 'csv.currency', 'csv.colours', 'csv.crvi', 'csv.ppe', 'csv.status'].map((key) => t(key)),
      kind: (kind) => t(`kind.${kind}`),
      unit: (uom) => t(`uom.${uom}`),
      status: (status) => t(`status.${status}`),
      seesCost: can.seesCost,
    })
    downloadCsv(`materials-${new Date().toISOString().slice(0, 10)}.csv`, csv)
  }

  const archiveMany = async (ids: string[], reason: string): Promise<boolean> => {
    setBusy(true)
    let done = 0
    try {
      for (const id of ids) {
        const row = (rows.items ?? []).find((entry) => entry.id === id)
        if (!row || row.status === 'ARCHIVED') continue
        await archiveMaterial(api, row, reason || undefined)
        done++
      }
      setNotice({ key: 'materials.notice.archived', tone: 'success', params: { count: done } })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error).key, tone: 'danger', params: { count: done } })
      return false
    } finally {
      setBusy(false)
      void load()
      loadTiles()
    }
  }

  const setCosts = async (changes: Array<{ id: string; cost: string | null }>, reason: string): Promise<boolean> => {
    setBusy(true)
    let done = 0
    try {
      for (const change of changes) {
        const row = (rows.items ?? []).find((entry) => entry.id === change.id)
        if (!row) continue
        await setStandardCost(api, row, change.cost, reason || undefined)
        done++
      }
      setNotice({ key: 'materials.notice.costSet', tone: 'success', params: { count: done } })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error).key, tone: 'danger', params: { count: done } })
      return false
    } finally {
      setBusy(false)
      void load()
      loadTiles()
    }
  }

  function openNew(open: boolean) {
    if (!open) {
      setNewMaterial(null)
      if (askedNew) router.replace(`${pathname}${searchOf(filters)}`)
      return
    }
    setNewMaterial({
      draft: draftFor('LEATHER', companyId),
      companies: session.companies.map((company) => ({ id: company.id, name: company.name })),
      suppliers: null,
      busy: false,
      problem: null,
      refused: [],
      messages: [],
    })
  }

  const searchSuppliers = (q: string) => {
    setNewMaterial((current) => (current ? { ...current, suppliers: { q, results: null } } : current))
    findSuppliers(api, q)
      .then((results) => setNewMaterial((current) => (current && current.suppliers?.q === q ? { ...current, suppliers: { q, results } } : current)))
      .catch(() => setNewMaterial((current) => (current ? { ...current, suppliers: { q, results: [] } } : current)))
  }

  const create = async () => {
    const model = newMaterial
    if (!model) return
    setNewMaterial({ ...model, busy: true, problem: null, refused: [], messages: [] })
    try {
      const material = await createMaterial(api, bodyOf(model.draft, can))
      router.push(`${prefix}/products/materials/${material.id}`)
    } catch (error) {
      const problem = writeProblem(error)
      setNewMaterial((current) => (current ? { ...current, busy: false, problem: problem.key, refused: problem.paths, messages: problem.messages } : current))
    }
  }

  const model: MaterialsListViewModel = { prefix, can, filters, rows, tiles, asOf, updates, newMaterial, busy, notice }

  return (
    <MaterialsListView
      model={model}
      actions={{
        onFilters: setFilters,
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => {
          void load()
          loadTiles()
        },
        onOpen: (id) => router.push(`${prefix}/products/materials/${id}`),
        onExport: exportCsv,
        onArchiveMany: archiveMany,
        onSetCosts: setCosts,
        onNew: openNew,
        onDraft: (draft) => setNewMaterial((current) => (current ? { ...current, draft, refused: [] } : current)),
        onSupplierSearch: searchSuppliers,
        onCreate: () => void create(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
