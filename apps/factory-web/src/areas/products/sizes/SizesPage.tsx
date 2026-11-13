'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useLiveChanges } from '../../../record-panels/live'
import { downloadCsv, libraryCan, readProblem, writeProblem, type Notice } from '../library/model'
import { archiveScale, createScale, listScales } from './api'
import { parseSizes, scalesCsv, viewOf, viewQuery, type ScaleFilters } from './model'
import { SizesListView, type NewScaleModel, type SizesListViewModel } from './view/SizesListView'
// B-W2b-240: the view switch (Points of measure, Grade rules), Import (W2b).
import { depthSearch, libraryOf, NO_DEPTH_FILTERS } from './depth/model'
import { SizesDepth } from './depth/SizesDepth'
import { useLibraryImport } from './depth/use-library-import'
// B-W2b-362: Measurement templates (B-W1-17), the second view.
import { TemplatesList } from './templates/TemplatesList'

const filtersOf = (params: URLSearchParams | null): ScaleFilters => ({ view: viewOf(params?.get('view')), q: params?.get('q') ?? '' })

function searchOf(filters: ScaleFilters): string {
  const search = new URLSearchParams()
  if (filters.view !== 'open') search.set('view', filters.view)
  if (filters.q.trim()) search.set('q', filters.q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

/**
 * `/w/<company>/products/sizes` (SCR-049): the size scales the person may read (product.styles.view), live size_scale.*
 * changes behind "N updates · Show", New size scale (`?new=1`, `c`: creates and opens it), Archive N one by one with
 * their versions.
 */
export function SizesPage() {
  // B-W2b-240: `?view=poms|rules` shows Points of measure or Grade rules (SCR-345); anything else, the size scales.
  const library = libraryOf(useSearchParams()?.get('view'))
  // B-W2b-362: `?view=templates` shows the measurement templates.
  if (library === 'templates') return <TemplatesList />
  return <WithMessages namespaces={['library']}>{library === 'scales' ? <Container /> : <SizesDepth library={library} />}</WithMessages>
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
  const prefix = pathname.replace(/\/products\/sizes\/?$/, '')
  const companyId = session.company?.id ?? null
  const [rows, setRows] = useState<SizesListViewModel['rows']>({ items: null, more: false, count: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [newScale, setNewScale] = useState<NewScaleModel | null>(null)
  const readSeq = useRef(0)
  // B-W2b-240: the view switch and Import (W2b).
  const locale = useLocale()
  const imports = useLibraryImport({ api, permissions: session.permissions, companyId, companies: session.companies.map((company) => ({ id: company.id, name: company.name })), locale, onApplied: () => undefined })

  const load = useCallback(async () => {
    const mine = ++readSeq.current
    setRows((current) => ({ ...current, items: null, problem: null }))
    try {
      const page = await listScales(api, { ...viewQuery(filters.view), q: filters.q })
      if (mine !== readSeq.current) return
      setRows({ items: page.scales, more: page.nextCursor !== null, count: page.count, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (mine === readSeq.current) setRows({ items: null, more: false, count: null, problem: readProblem(error) })
    }
  }, [api, filters])

  useEffect(() => {
    void load()
  }, [load])

  const askedNew = params?.get('new') === '1'
  useEffect(() => {
    if (askedNew && can.scalesManage) openNew(true)
  }, [askedNew])

  useLiveChanges({
    onChange: (change) => {
      if (change.type.startsWith('size_scale.')) setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  const setFilters = (next: ScaleFilters) => router.replace(`${pathname}${searchOf(next)}`)

  const more = async () => {
    if (!cursor) return
    try {
      const page = await listScales(api, { ...viewQuery(filters.view), q: filters.q, cursor })
      setRows((current) => ({ items: [...(current.items ?? []), ...page.scales], more: page.nextCursor !== null, count: page.count, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ key: readProblem(error), tone: 'danger' })
    }
  }

  const exportCsv = (ids: string[]) => {
    const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
    downloadCsv(`size-scales-${new Date().toISOString().slice(0, 10)}.csv`, scalesCsv(picked, { header: ['csv.code', 'csv.name', 'csv.sizes', 'csv.sizeCount', 'csv.styles', 'csv.status'].map((key) => t(key)), status: (status) => t(`status.${status}`) }))
  }

  const archiveMany = async (ids: string[], reason: string): Promise<boolean> => {
    setBusy(true)
    let done = 0
    try {
      for (const id of ids) {
        const row = (rows.items ?? []).find((entry) => entry.id === id)
        if (!row || row.status === 'ARCHIVED') continue
        await archiveScale(api, row, reason || undefined)
        done++
      }
      setNotice({ key: 'sizes.notice.archived', tone: 'success', params: { count: done } })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error).key, tone: 'danger' })
      return false
    } finally {
      setBusy(false)
      void load()
    }
  }

  function openNew(open: boolean) {
    if (!open) {
      setNewScale(null)
      if (askedNew) router.replace(`${pathname}${searchOf(filters)}`)
      return
    }
    setNewScale({ draft: { companyId, code: '', name: '', sizes: '' }, companies: session.companies.map((company) => ({ id: company.id, name: company.name })), busy: false, problem: null, refused: [] })
  }

  const create = async () => {
    const model = newScale
    if (!model) return
    setNewScale({ ...model, busy: true, problem: null, refused: [] })
    try {
      const scale = await createScale(api, { companyId: model.draft.companyId, code: model.draft.code.trim().toUpperCase(), name: model.draft.name.trim(), sizes: parseSizes(model.draft.sizes).map((code) => ({ code })) })
      router.push(`${prefix}/products/sizes/${scale.id}`)
    } catch (error) {
      const problem = writeProblem(error)
      setNewScale((current) => (current ? { ...current, busy: false, problem: problem.key, refused: problem.paths } : current))
    }
  }

  const model: SizesListViewModel = { prefix, can, filters, rows, asOf, updates, newScale, busy, notice, /* B-W2b-240 */ library: { library: 'scales', importHeld: imports.held } }
  return (
    <>
      <SizesListView
        model={model}
        actions={{
          onFilters: setFilters,
          onRetry: () => void load(),
          onMore: () => void more(),
          onShowUpdates: () => void load(),
          onOpen: (id) => router.push(`${prefix}/products/sizes/${id}`),
          onExport: exportCsv,
          onArchiveMany: archiveMany,
          onNew: openNew,
          onDraft: (draft) => setNewScale((current) => (current ? { ...current, draft, refused: [] } : current)),
          onCreate: () => void create(),
          onDismissNotice: () => setNotice(null),
          // B-W2b-240
          library: { onLibrary: (next) => router.push(`${pathname}${depthSearch(next, NO_DEPTH_FILTERS)}`), onImport: imports.open },
        }}
      />
      {imports.dialog}
    </>
  )
}
