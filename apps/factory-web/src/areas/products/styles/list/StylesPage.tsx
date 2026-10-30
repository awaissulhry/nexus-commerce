'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { useLiveChanges } from '../../../../record-panels/live'
import { archiveStyle, basePriceLists, countStyles, createStyle, listBrands, listScales, listStyles, priceEntries, startRevision } from '../api'
import { useDuplicate } from '../duplicate/use-duplicate'
import { abilitiesOf, grainsOf, STYLE_TILES, stylesCsv, viewOf, viewQuery } from '../model'
import { readProblem, writeProblem } from '../problems'
import { pickBaseList, pricesByStyle, type ListPrices, type NewStyleDraft, type NewStyleModel, type StyleFilters, type StylesListViewModel } from './list-model'
import { StylesListView } from './view/StylesListView'

const PRODUCT_TYPES = ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER']
const PPE_CATEGORIES = ['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III']

/** The filters in the address (`?view=waiting&type=JACKET&ppe=CATEGORY_II&q=…`), so a filtered list can be shared. */
function filtersOf(params: URLSearchParams | null): StyleFilters {
  const type = params?.get('type') ?? ''
  const ppe = params?.get('ppe') ?? ''
  return { view: viewOf(params?.get('view')), q: params?.get('q') ?? '', type: PRODUCT_TYPES.includes(type) ? type : '', ppe: PPE_CATEGORIES.includes(ppe) ? ppe : '' }
}

function searchOf(filters: StyleFilters): string {
  const search = new URLSearchParams()
  if (filters.view !== 'open') search.set('view', filters.view)
  if (filters.type) search.set('type', filters.type)
  if (filters.ppe) search.set('ppe', filters.ppe)
  if (filters.q.trim()) search.set('q', filters.q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

function emptyDraft(companyId: string | null): NewStyleDraft {
  return {
    companyId,
    code: '',
    name: '',
    productType: 'JACKET',
    season: '',
    brandPartyId: null,
    range: { sizeScaleId: '', sizes: [], baseSize: null },
    ppe: { ppeCategory: 'CATEGORY_II', ppeStandard: null, ppeClass: null },
    mtmAllowed: false,
  }
}

/**
 * `/w/<company>/products/styles` (SCR-040): reads the styles the person may see (product.styles.view over companies;
 * the API filters), the tiles' counts (one count per saved filter, so each number is the list's total under it), and
 * keeps live changes behind "N updates · Show". New style (`?new=1`, `c`): code, name, type, season, brand, range and
 * PPE; Create makes the style and its first revision (a draft) and opens it.
 */
export function StylesPage() {
  return (
    <WithMessages namespaces={['products']}>
      <StylesContainer />
    </WithMessages>
  )
}

function StylesContainer() {
  const t = useT('products')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filters = useMemo(() => filtersOf(params), [params])
  const prefix = pathname.replace(/\/products\/styles\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const grains = useMemo(() => grainsOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const [rows, setRows] = useState<StylesListViewModel['rows']>({ items: null, more: false, count: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [tiles, setTiles] = useState<StylesListViewModel['tiles']>({})
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<StylesListViewModel['notice']>(null)
  const [busy, setBusy] = useState(false)
  const [newStyle, setNewStyle] = useState<NewStyleModel | null>(null)
  const readSeq = useRef(0)
  const [prices, setPrices] = useState<ListPrices>({ state: 'hidden' })
  const duplicate = useDuplicate(api, () => {
    void load()
    loadTiles()
  })

  // The list prices (W2a): the BASE list in force for this company, read once; only with the right and a grain to show.
  const wantsPrices = can.prices && (grains.price || grains.margin)
  useEffect(() => {
    if (!wantsPrices) {
      setPrices({ state: 'hidden' })
      return
    }
    let live = true
    setPrices({ state: 'loading' })
    basePriceLists(api, companyId)
      .then(async (lists) => {
        const list = pickBaseList(lists, companyId)
        if (!list || !list.shownVersion) {
          if (live) setPrices({ state: 'none' })
          return
        }
        const entries = await priceEntries(api, list.id, list.shownVersion.id)
        if (live) setPrices({ state: 'ready', list: { id: list.id, code: list.code, name: list.name, currency: list.currency }, byStyle: pricesByStyle(entries) })
      })
      .catch((error: unknown) => live && setPrices({ state: 'error', problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, companyId, wantsPrices])

  const query = useCallback(
    (from: StyleFilters, at: string | null) => ({ ...viewQuery(from.view), q: from.q, productType: from.type || undefined, ppeCategory: from.ppe || undefined, cursor: at }),
    [],
  )

  const load = useCallback(async () => {
    const mine = ++readSeq.current
    setRows((current) => ({ ...current, items: null, problem: null }))
    try {
      const page = await listStyles(api, query(filters, null))
      if (mine !== readSeq.current) return
      setRows({ items: page.styles, more: page.nextCursor !== null, count: page.count, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (mine === readSeq.current) setRows({ items: null, more: false, count: null, problem: readProblem(error) })
    }
  }, [api, filters, query])

  const loadTiles = useCallback(() => {
    for (const tile of STYLE_TILES) {
      setTiles((current) => ({ ...current, [tile]: current[tile] ?? null }))
      countStyles(api, viewQuery(tile))
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

  // `?new=1` (Today's New ▾, the `c` key from elsewhere) opens New style once.
  const askedNew = params?.get('new') === '1'
  useEffect(() => {
    if (askedNew && can.manage) openNew(true)
    // Only when the address asks.
  }, [askedNew])

  useLiveChanges({
    onChange: (change) => {
      if (change.type.startsWith('style.')) setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  const setFilters = (next: StyleFilters) => router.replace(`${pathname}${searchOf(next)}`)

  const more = async () => {
    if (!cursor) return
    try {
      const page = await listStyles(api, query(filters, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.styles], more: page.nextCursor !== null, count: page.count, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ key: readProblem(error), tone: 'danger' })
    }
  }

  const exportCsv = (ids: string[]) => {
    const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
    const csv = stylesCsv(picked, {
      header: [t('csv.code'), t('csv.name'), t('csv.type'), t('csv.season'), t('csv.brand'), t('csv.status'), t('csv.released'), t('csv.draft'), t('csv.sizes'), t('csv.base'), t('csv.colourways'), t('csv.skus'), t('csv.ppe'), t('csv.class')],
      status: (status) => t(`status.${status}`),
      type: (type) => t(`productType.${type}`),
      ppe: (category) => t(`ppe.short.${category}`),
    })
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `styles-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const archiveMany = async (ids: string[], reason: string): Promise<boolean> => {
    setBusy(true)
    let done = 0
    try {
      for (const id of ids) {
        const row = (rows.items ?? []).find((entry) => entry.id === id)
        if (!row || row.status === 'ARCHIVED') continue
        await archiveStyle(api, row, reason || undefined)
        done++
      }
      setNotice({ key: 'notice.archivedMany', tone: 'success', params: { count: done } })
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
      setNewStyle(null)
      if (askedNew) router.replace(`${pathname}${searchOf(filters)}`)
      return
    }
    setNewStyle({ draft: emptyDraft(companyId), companies: session.companies.map((company) => ({ id: company.id, name: company.name })), scales: null, brands: null, busy: false, problem: null, refused: [] })
    listScales(api, companyId)
      .then((scales) =>
        setNewStyle((current) =>
          current ? { ...current, scales, draft: current.draft.range.sizeScaleId || scales.length === 0 ? current.draft : { ...current.draft, range: { sizeScaleId: scales[0]!.id, sizes: [], baseSize: null } } } : current,
        ),
      )
      .catch((error: unknown) => setNewStyle((current) => (current ? { ...current, problem: readProblem(error) } : current)))
    if (can.brands)
      listBrands(api)
        .then((brands) => setNewStyle((current) => (current ? { ...current, brands } : current)))
        .catch(() => undefined)
  }

  const create = async () => {
    const model = newStyle
    if (!model) return
    const draft = model.draft
    setNewStyle({ ...model, busy: true, problem: null, refused: [] })
    try {
      const style = await createStyle(api, {
        companyId: draft.companyId,
        code: draft.code.trim().toUpperCase(),
        name: draft.name.trim(),
        productType: draft.productType,
        season: draft.season.trim() || null,
        brandPartyId: draft.brandPartyId,
        sizeScaleId: draft.range.sizeScaleId,
        sizes: draft.range.sizes,
        baseSize: draft.range.baseSize,
        ppeCategory: draft.ppe.ppeCategory,
        ppeStandard: draft.ppe.ppeStandard,
        ppeClass: draft.ppe.ppeClass,
        mtmAllowed: draft.mtmAllowed,
      })
      // Revision 1, the draft its BOM, routing and label go into (design: "Create draft style → revision 1 (draft)").
      await startRevision(api, style.id).catch(() => undefined)
      router.push(`${prefix}/products/styles/${style.id}?tab=overview`)
    } catch (error) {
      const problem = writeProblem(error)
      setNewStyle((current) => (current ? { ...current, busy: false, problem: problem.key, refused: problem.paths } : current))
    }
  }

  const model: StylesListViewModel = {
    prefix,
    can,
    grains,
    prices,
    duplicate: duplicate.model,
    filters,
    rows,
    tiles,
    asOf,
    updates,
    newStyle,
    busy,
    notice,
  }

  return (
    <StylesListView
      model={model}
      actions={{
        onFilters: setFilters,
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => {
          void load()
          loadTiles()
        },
        onOpen: (id) => router.push(`${prefix}/products/styles/${id}`),
        onExport: exportCsv,
        onArchiveMany: archiveMany,
        onNewStyle: openNew,
        onStartFrom: (from) => {
          if (from !== 'copy') return
          openNew(false)
          duplicate.open(null)
        },
        onDuplicate: (row) => duplicate.open({ id: row.id, code: row.code, name: row.name }),
        duplicate: duplicate.actions,
        onNewDraft: (draft) => setNewStyle((current) => (current ? { ...current, draft, refused: [] } : current)),
        onCreate: () => void create(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}

