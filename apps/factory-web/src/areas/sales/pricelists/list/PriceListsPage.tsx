'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useT } from '../../../../lib/i18n/provider'
import { downloadText, useLive } from '../../../parties/_shared/hooks'
import { createPriceList, listPriceLists, moveList, type PriceListRow } from '../api'
import { abilitiesOf, emptyNewList, filtersOf, listsCsv, newListBody, romeToday, searchOf, stateOfRows, type ListFilters } from '../model'
import { PriceListsMessages } from '../parts'
import { createProblem, readProblem } from '../problems'
import type { NewListModel, PriceListsViewModel } from './list-model'
import { PriceListsView } from './view/PriceListsView'

/**
 * `/w/<company>/sales/price-lists` (SCR-106): reads the lists the company may use (its own and every company's;
 * pricelists.view) with the tiles' counts as the API answers them, keeps live changes behind "N updates · Show"
 * (`price_list.*`), and makes a new list (its version 1 a draft) that then opens on its Prices tab. Filters live in the
 * address (`?rows=&soon=&kind=&q=`, `?new=1` opens New price list).
 */
export function PriceListsPage() {
  return (
    <PriceListsMessages>
      <PriceListsContainer />
    </PriceListsMessages>
  )
}

const isListChange = (type: string) => type.startsWith('price_list.')

function PriceListsContainer() {
  const t = useT('pricelists')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filters = useMemo(() => filtersOf(params), [params])
  const prefix = pathname.replace(/\/sales\/price-lists\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const [rows, setRows] = useState<PriceListsViewModel['rows']>({ items: null, problem: null })
  const [tiles, setTiles] = useState<PriceListsViewModel['tiles']>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<PriceListsViewModel['notice']>(null)
  const [dialog, setDialog] = useState<PriceListsViewModel['dialog']>(null)
  const [busy, setBusy] = useState(false)
  const [allLists, setAllLists] = useState<PriceListRow[]>([])
  const [newList, setNewList] = useState<NewListModel | null>(params?.get('new') === '1' && can.manage ? { draft: emptyNewList(companyId ?? companies[0]?.id ?? ''), companies, lists: [], busy: false, problem: null } : null)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const load = useCallback(async () => {
    if (!can.view) return
    const wanted = filtersRef.current
    try {
      const answer = await listPriceLists(api, { companyId, state: stateOfRows(wanted.rows), kind: wanted.kind, q: wanted.q })
      if (wanted !== filtersRef.current) return
      setRows({ items: answer.lists, problem: null })
      setTiles(answer.tiles)
      setAsOf(new Date().toISOString())
      setSelected((current) => current.filter((id) => answer.lists.some((row) => row.id === id)))
    } catch (error) {
      setRows((current) => ({ ...current, problem: readProblem(error) }))
      setTiles(null)
    }
  }, [api, can.view, companyId])

  useEffect(() => {
    setRows({ items: null, problem: null })
    void load()
  }, [filters, load])

  const live = useLive(
    (change) => {
      if (isListChange(change.type)) setUpdates((count) => count + 1)
    },
    () => setUpdates((count) => count + 1),
  )

  // The lists a new one may fall back to: every active list this company may use, read when the dialog opens.
  const readBases = useCallback(() => {
    listPriceLists(api, { companyId })
      .then((answer) => {
        setAllLists(answer.lists)
        setNewList((current) => (current ? { ...current, lists: answer.lists } : current))
      })
      .catch(() => undefined)
  }, [api, companyId])
  useEffect(() => {
    if (newList && newList.lists.length === 0 && allLists.length === 0) readBases()
    // Only on arrival with ?new=1.
  }, [])

  const go = (next: ListFilters) => router.replace(`${pathname}${searchOf(next)}`)

  const openNew = (open: boolean) => {
    if (!open) {
      setNewList(null)
      if (params?.get('new')) router.replace(`${pathname}${searchOf(filters)}`)
      return
    }
    setNewList({ draft: emptyNewList(companyId ?? companies[0]?.id ?? ''), companies, lists: allLists, busy: false, problem: null })
    readBases()
  }

  const create = () => {
    const model = newList
    if (!model) return
    setNewList({ ...model, busy: true, problem: null })
    createPriceList(api, newListBody(model.draft))
      .then((list) => router.push(`${prefix}/sales/price-lists/${encodeURIComponent(list.id)}?tab=prices`))
      .catch((error: unknown) => setNewList((current) => (current ? { ...current, busy: false, problem: createProblem(error, model.draft.kind) } : current)))
  }

  const exportCsv = (ids: readonly string[]) => {
    const chosen = (rows.items ?? []).filter((row) => ids.includes(row.id))
    downloadText(`price-lists-${romeToday()}.csv`, listsCsv(chosen, { header: (key) => t(key), kind: (kind) => t(`kind.${kind}`), state: (state) => t(`state.${state}`) }))
    setNotice({ tone: 'success', words: { key: 'list.bulk.exported', params: { count: chosen.length } } })
  }

  const archiveMany = async (ids: readonly string[]) => {
    const chosen = (rows.items ?? []).filter((row) => ids.includes(row.id))
    setBusy(true)
    let done = 0
    for (const row of chosen) {
      try {
        // One by one, each with the version it was read with: a list moved meanwhile is refused, never overwritten.
        await moveList(api, row, 'archive')
        done++
      } catch (error) {
        if (isApiError(error) && error.kind === 'step_up') break
      }
    }
    setBusy(false)
    setDialog(null)
    setSelected([])
    const failed = chosen.length - done
    setNotice(failed === 0 ? { tone: 'success', words: { key: 'list.bulk.archived', params: { count: done } } } : { tone: 'warning', words: { key: 'list.bulk.archivedPartly', params: { done, failed } } })
    setUpdates(0)
    void load()
  }

  const model: PriceListsViewModel = { prefix, can, filters, rows, tiles, asOf, live, updates, notice, selected, newList, dialog, busy }
  return (
    <PriceListsView
      model={model}
      actions={{
        onFilters: go,
        onRetry: () => {
          setRows({ items: null, problem: null })
          void load()
        },
        onShowUpdates: () => {
          setUpdates(0)
          void load()
        },
        onSelect: setSelected,
        onOpen: (id) => router.push(`${prefix}/sales/price-lists/${encodeURIComponent(id)}`),
        onDialog: setDialog,
        onExport: exportCsv,
        onArchive: (ids) => void archiveMany(ids),
        onNew: openNew,
        onNewDraft: (draft) => setNewList((current) => (current ? { ...current, draft, problem: null } : current)),
        onCreate: create,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
