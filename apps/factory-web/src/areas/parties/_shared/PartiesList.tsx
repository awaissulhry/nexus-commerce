'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ColDef } from '@nexus/ui/grid'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { checkVies, countParties, createParty, findParties, listParties, moveParty, type PartyQuery, type PartyRow, type PartySort, type PartyWorkGroup, type NewPartyBody } from './api'
import { PARTY_KINDS, PARTY_TAX_MODES, type PartyKind, type TaxMode } from './api' // F-SA-225: the chips' terms in the address
import { partyEvent, useLive } from './hooks'
// B-W2b-427: the check for likely duplicates on create.
import { checkParty } from '../../admin/import/duplicates/api'
import {
  BULK_MAX,
  bandTermsOf, // F-CL-201
  identityBody,
  identityWanted,
  listCanOf, // F-CL-101
  listQueryOf, // F-CL-201
  loaded,
  loading,
  failed,
  partyName,
  problemKey,
  recordHref,
  refusedFields,
  SIDES,
  sortOf, // F-CL-201
  TILE_VIEW,
  viesApplies,
  viewQuery,
  workOf, // F-CL-201
  type BulkKind,
  type BulkResult,
  type BulkRun,
  type DuplicateParty,
  type ListDialog,
  type ListFilters,
  type ListSort, // F-CL-201
  type ListView,
  type Loaded,
  type NewPartyDraft,
  type Notice,
  type Side,
  type TileId,
} from './model'
import { PartiesListView, type ListDepth } from './view/PartiesListView'

/**
 * B-W2b-334: a side's own list parts (Suppliers: the "Documents expiring in 30 days" tile and its view, Request documents
 * N), given the list's view, a way to change it, the selected rows and how to read the list again.
 * F-CL-101 (13-backend §8.1): + the loaded rows (a side reads its own facts per page of rows: Customers' New messages). The slot is
 * called once per render of the list, always at the same place, so a side may use hooks inside it (the same ones every render).
 */
export interface ListDepthArgs {
  readonly view: ListView
  readonly onView: (view: ListView) => void
  readonly selectedRows: readonly PartyRow[]
  /** F-CL-101: the rows the list has loaded (every page read so far). */
  readonly rows: readonly PartyRow[]
  readonly reload: () => void
  // ---- F-CL-201: the band's read and door (a side with `workTerm`) ----
  /** The list's own terms without its door, order and page (the band counts what its press would show: K2). */
  readonly terms: PartyQuery
  /** The band group the address presses, or none. */
  readonly work: PartyWorkGroup | null
  /** Press a group (null: leave it): one write of the address. */
  readonly onWork: (group: PartyWorkGroup | null) => void
  // ---- end F-CL-201
}
export type ListDepthSlot = (list: ListDepthArgs) => ListDepth

/**
 * The list container of both sides (`/w/<company>/sales/customers` SCR-032, `/w/<company>/purchasing/suppliers`
 * SCR-056): reads one page of 50 of the view (`GET /parties` with the side's roles), the tiles' counts (one count per
 * tile, the same filters), creates a party (and, for an EU business with parties.vies, asks VIES at once so the answer
 * is kept as the proof), blocks, unblocks, archives and reactivates with the version read, checks VIES one row or a
 * selection at a time (F-SA-225: Export ▾ and Export N go through the export job, the view's terms in the address), and listens to the live stream: changes wait behind "N updates · Show"
 * (rows never move under the cursor). `?view=` keeps the view in the address; `?new=1` opens New.
 */
export function PartiesList({ side, headActions, columns, depth, sort, workTerm }: { side: Side; headActions?: (reload: () => void) => ReactNode; columns?: readonly ColDef<PartyRow>[]; depth?: ListDepthSlot; sort?: ListSort | null; workTerm?: boolean }) {
  // F-CL-201 (13-backend §8.1): two static side options — `sort` (Sort ▾ and `?sort=`; absent: code order, no Sort ▾) and `workTerm`
  // (read and write `?work=`, the band's door); Suppliers passes neither and reads exactly as before.
  return (
    <WithMessages namespaces={['parties']}>
      <PartiesListContainer side={side} headActions={headActions} columns={columns} depth={depth} sort={sort ?? null} workTerm={workTerm === true} />
    </WithMessages>
  )
}

const VIEWS = new Set<string>(['open', 'active', 'prospects', 'brands', 'riders', 'invoice', 'vies', 'blocked', 'archived', 'all', 'suppliers', 'subcontractors', 'carriers']) // B-W2b-324: riders
/** F-CL-101: no rows read yet — one empty list, the same between renders (a side's per-page read keys on it). */
const EMPTY_ROWS: readonly PartyRow[] = []

function PartiesListContainer({ side, headActions, columns, depth, sort, workTerm }: { side: Side; headActions?: (reload: () => void) => ReactNode; columns?: readonly ColDef<PartyRow>[]; depth?: ListDepthSlot; sort: ListSort | null; workTerm: boolean }) {
  const config = SIDES[side]
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const can = listCanOf(held) // F-CL-101: + views.export (the bar's Export N)
  const prefix = companyPrefix(session.company?.code ?? '')
  // F-SA-225 (screen = file): the view, the search and the kind / tax-mode chips live in the ADDRESS — Export ▾ and Export N (the export
  // job reads the screen's address: exports/sources/parties.ts), a saved view, Back and a shared link hold the screen's rows; every
  // change writes the address in one step (writeAddress) and the list reads it back.
  const askedView = params?.get('view') ?? 'open'
  const view: ListView = VIEWS.has(askedView) && (config.views as readonly string[]).includes(askedView) ? (askedView as ListView) : 'open'
  const query = (params?.get('q') ?? '').slice(0, 100)
  const askedKind = params?.get('kind') ?? ''
  const askedMode = params?.get('taxMode') ?? ''
  const filters = useMemo<ListFilters>(
    () => ({ ...((PARTY_KINDS as readonly string[]).includes(askedKind) ? { kind: askedKind as PartyKind } : {}), ...((PARTY_TAX_MODES as readonly string[]).includes(askedMode) ? { taxMode: askedMode as TaxMode } : {}) }),
    [askedKind, askedMode],
  )
  // F-CL-201: the order and the band's door, read from the address only for a side that asks for them.
  const sortValue: PartySort | null = sort ? sortOf(params?.get('sort'), sort) : null
  const work: PartyWorkGroup | null = workTerm ? workOf(params?.get('work')) : null
  const terms = useMemo(() => viewQuery(config, view, filters, query), [config, view, filters, query])
  const listQuery = useMemo(() => listQueryOf(terms, sortValue, work), [terms, sortValue, work])
  const bandTerms = useMemo(() => bandTermsOf(terms), [terms])
  const [sortedBy, setSortedBy] = useState<PartySort | null>(null)
  const [rows, setRows] = useState<Loaded<PartyRow>>(loading())
  const [total, setTotal] = useState<number | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [tiles, setTiles] = useState<Partial<Record<TileId, number | null>>>({})
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<ListDialog | null>(params?.get('new') === '1' && can.manage ? { kind: 'new' } : null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [refused, setRefused] = useState<readonly string[]>([])
  const [duplicates, setDuplicates] = useState<readonly DuplicateParty[]>([])
  const [bulk, setBulk] = useState<BulkRun | null>(null)
  const createKey = useRef<string | null>(null)
  const request = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!can.view) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const page = await listParties(api, listQuery, controller.signal)
      if (controller.signal.aborted) return
      setRows(loaded(page.parties))
      setTotal(page.count)
      setSortedBy(page.sortedBy ?? null) // F-CL-201
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      setSelected((current) => current.filter((id) => page.parties.some((row) => row.id === id)))
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return
      setRows(failed(problemKey(error)))
      setTotal(null)
    }
  }, [api, can.view, listQuery])

  const loadTiles = useCallback(async () => {
    if (!can.view) return
    await Promise.all(
      config.tiles.map(async (tile) => {
        try {
          const count = await countParties(api, viewQuery(config, TILE_VIEW[tile]))
          setTiles((current) => ({ ...current, [tile]: count }))
        } catch {
          setTiles((current) => ({ ...current, [tile]: null }))
        }
      }),
    )
  }, [api, can.view, config])

  // F-SA-223: the search field waits for a pause in typing itself (list-frame/search: 300 ms, Enter at once): every change reads at once.
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadTiles()
  }, [loadTiles])

  const live = useLive(
    (change) => {
      if (partyEvent(change)) setUpdates((count) => count + 1)
    },
    () => {
      void load()
      void loadTiles()
    },
  )

  const refresh = () => {
    void load()
    void loadTiles()
  }

  // F-SA-225: one write of the address for a change of the view, the search or the chips (the other terms kept).
  // F-CL-201: + the band's door and the order (written only when it is not the side's fallback).
  const writeAddress = (next: { view?: ListView; query?: string; filters?: ListFilters; work?: PartyWorkGroup | null; sort?: PartySort }) => {
    const search = new URLSearchParams(params?.toString() ?? '')
    const nextView = next.view ?? view
    const nextQuery = (next.query ?? query).trim()
    const nextFilters = next.filters ?? filters
    if (nextView === 'open') search.delete('view')
    else search.set('view', nextView)
    if (nextQuery) search.set('q', nextQuery)
    else search.delete('q')
    if (nextFilters.kind) search.set('kind', nextFilters.kind)
    else search.delete('kind')
    if (nextFilters.taxMode) search.set('taxMode', nextFilters.taxMode)
    else search.delete('taxMode')
    // F-CL-201
    const nextWork = next.work === undefined ? work : next.work
    if (workTerm && nextWork) search.set('work', nextWork)
    else search.delete('work')
    const nextSort = next.sort ?? sortValue
    if (sort && nextSort && nextSort !== sort.fallback) search.set('sort', nextSort)
    else search.delete('sort')
    search.delete('new')
    const qs = search.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }

  const changeView = (next: ListView) => {
    setRows(loading())
    setSelected([])
    writeAddress({ view: next })
  }

  // F-CL-201: a band door pressed or left, and another order: one write of the address each.
  const changeWork = (next: PartyWorkGroup | null) => {
    setRows(loading())
    setSelected([])
    writeAddress({ work: next })
  }
  const changeSort = (next: PartySort) => {
    setRows(loading())
    writeAddress({ sort: next })
  }

  const closeDialog = () => {
    setDialog(null)
    setDialogProblem(null)
    setRefused([])
    setDuplicates([])
    createKey.current = null
    if (params?.get('new')) router.replace(pathname, { scroll: false })
  }

  const rowOf = (id: string) => rows.items?.find((row) => row.id === id)

  /** The company that asks VIES for a tenant-wide party: the one the page works in. */
  const viesBody = (row: Pick<PartyRow, 'companyId'>) => (row.companyId === null && session.company ? { companyId: session.company.id } : {})

  const onCreate = async (draft: NewPartyDraft): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    setRefused([])
    createKey.current ??= newIdempotencyKey()
    const body: NewPartyBody & { companyId?: string | null } = {
      ...(draft.companyId ? { companyId: draft.companyId } : {}),
      code: draft.party.code.trim().toUpperCase(),
      kind: draft.party.kind,
      legalName: draft.party.legalName.trim(),
      tradeName: draft.party.tradeName.trim() || null,
      roles: draft.party.roles,
      country: draft.party.country,
      currency: draft.party.currency,
      language: draft.party.language,
      status: config.newStatus,
      ...(identityWanted(draft) ? { taxIdentity: identityBody({ ...draft.identity, country: draft.party.country }, false) } : {}),
    }
    try {
      const party = await createParty(api, body as NewPartyBody, createKey.current)
      let viesProblem = false
      if (party.taxMode === 'EU_B2B' && viesApplies(party) && can.vies) {
        try {
          await checkVies(api, party.id, viesBody(party))
        } catch {
          viesProblem = true
        }
      }
      closeDialog()
      // B-TH-260: a customer's Tax & terms is inside Terms & requirements.
      const tab = side === 'customers' && (party.invoiceBlocked || party.taxMode === 'EU_B2B') ? 'terms' : undefined
      router.push(`${recordHref(prefix, config, party.id, tab)}${viesProblem ? `${tab ? '&' : '?'}vies=failed` : ''}`)
      return true
    } catch (error) {
      if (isApiError(error) && error.kind === 'conflict') {
        const typed = draft.identity.vatNumber.trim() || draft.identity.fiscalCode.trim()
        const found = typed ? await findParties(api, typed).catch(() => []) : []
        setDuplicates(found)
        setDialogProblem(found.length > 0 ? 'new.conflictNumber' : 'new.conflictCode')
        if (found.length === 0) setRefused(['code'])
      } else {
        setDialogProblem(isApiError(error) && error.kind === 'forbidden' && !draft.companyId && session.companies.length > 1 ? 'new.forbiddenEvery' : problemKey(error))
        setRefused(refusedFields(error))
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  const move = async (id: string, kind: 'block' | 'unblock' | 'reactivate', reason?: string) => {
    const row = rowOf(id)
    if (!row) return
    setBusy(true)
    setDialogProblem(null)
    try {
      await moveParty(api, id, kind, { version: row.version, ...(reason ? { reason } : {}) })
      setNotice({ key: `done.${kind}`, tone: 'success', params: { name: partyName(row) } })
      setDialog(null)
      refresh()
    } catch (error) {
      if (dialog) setDialogProblem(problemKey(error))
      else setNotice({ key: problemKey(error), tone: 'danger' })
      if (isApiError(error) && error.kind === 'conflict') void load()
    } finally {
      setBusy(false)
    }
  }

  // F-CL-103: the last run's kind and reason, for its receipt's "Run the rest again".
  const lastRun = useRef<{ kind: BulkKind; reason?: string } | null>(null)

  /** One call per row, one result per row (the dialog shows them as they come). F-CL-103: + the selected rows it leaves out. */
  const runBulk = async (kind: BulkKind, targets: readonly PartyRow[], reason?: string, notOn?: readonly string[]) => {
    const list = targets.slice(0, BULK_MAX)
    const results: BulkResult[] = []
    lastRun.current = { kind, ...(reason ? { reason } : {}) }
    const skipped = notOn && notOn.length > 0 ? { notOn } : {}
    setBulk({ kind, total: list.length, results: [], done: false, ...skipped })
    setDialog({ kind: 'bulk' })
    for (const row of list) {
      let result: BulkResult
      try {
        if (kind === 'vies') {
          const answer = await checkVies(api, row.id, viesBody(row))
          result = {
            id: row.id,
            code: row.code,
            name: partyName(row),
            outcome: `vies.result.${answer.check.result}`,
            tone: answer.check.result === 'VALID' ? 'success' : answer.check.result === 'INVALID' ? 'danger' : 'warning',
          }
        } else if (kind === 'block') {
          await moveParty(api, row.id, 'block', { version: row.version, reason: reason ?? '' })
          result = { id: row.id, code: row.code, name: partyName(row), outcome: 'bulk.blocked', tone: 'success' }
        } else {
          await moveParty(api, row.id, 'archive', { version: row.version })
          result = { id: row.id, code: row.code, name: partyName(row), outcome: 'bulk.archived', tone: 'success' }
        }
      } catch (error) {
        result = { id: row.id, code: row.code, name: partyName(row), outcome: kind === 'vies' && isApiError(error) && error.kind === 'conflict' ? 'vies.refused' : problemKey(error), tone: 'danger', failed: true }
      }
      results.push(result)
      setBulk({ kind, total: list.length, results: [...results], done: false, ...skipped })
    }
    setBulk({ kind, total: list.length, results: [...results], done: true, ...skipped })
    setSelected([])
    refresh()
  }

  const onCheckVies = async (ids: readonly string[], notOn?: readonly string[]) => {
    const targets = ids.map(rowOf).filter((row): row is PartyRow => !!row)
    // F-CL-103: from the bar with rows it leaves out, the window says which and why (one row alone, as before: a notice).
    if (targets.length !== 1 || (notOn?.length ?? 0) > 0) return void runBulk('vies', targets, undefined, notOn)
    const row = targets[0]!
    setNotice({ key: 'vies.checkingOne', tone: 'info', params: { name: partyName(row) } })
    try {
      const answer = await checkVies(api, row.id, viesBody(row))
      setNotice({
        key: `vies.done.${answer.check.result}`,
        tone: answer.check.result === 'VALID' ? 'success' : answer.check.result === 'INVALID' ? 'danger' : 'warning',
        params: { name: partyName(row) },
      })
      refresh()
    } catch (error) {
      setNotice({ key: isApiError(error) && error.kind === 'conflict' ? 'vies.refused' : problemKey(error), tone: 'danger' })
    }
  }

  const onRecheckAll = async () => {
    try {
      const page = await listParties(api, { roles: config.roles, taxMode: 'EU_B2B', limit: BULK_MAX })
      const targets = page.parties.filter((row) => viesApplies(row))
      if (targets.length === 0) return setNotice({ key: 'vies.noneToCheck', tone: 'info' })
      void runBulk('vies', targets)
    } catch (error) {
      setNotice({ key: problemKey(error), tone: 'danger' })
    }
  }

  const onMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const page = await listParties(api, { ...listQuery, cursor }) // F-CL-201: the same order and door
      setRows((current) => loaded([...(current.items ?? []), ...page.parties]))
      setCursor(page.nextCursor)
      setTotal(page.count)
    } catch (error) {
      setNotice({ key: problemKey(error), tone: 'danger' })
    } finally {
      setLoadingMore(false)
    }
  }

  // B-W2b-334: the side's own tiles, view and bulk actions. F-CL-101: called here, once per render (a side may use hooks in it).
  const sideDepth = depth?.({
    view,
    onView: changeView,
    selectedRows: (rows.items ?? []).filter((row) => selected.includes(row.id)),
    rows: rows.items ?? EMPTY_ROWS,
    reload: refresh,
    // F-CL-201
    terms: bandTerms,
    work,
    onWork: changeWork,
  })

  return (
    <PartiesListView
      columns={columns}
      depth={sideDepth}
      headActions={
        headActions?.(() => {
          void load()
          void loadTiles()
        })
      }
      model={{
        side,
        prefix,
        rows,
        total,
        more: cursor !== null,
        loadingMore,
        tiles,
        view,
        filters,
        query,
        asOf,
        live,
        updates,
        selected,
        can,
        notice,
        dialog,
        busy,
        dialogProblem,
        refused,
        duplicates,
        bulk,
        companies: session.companies.map((company) => ({ id: company.id, name: company.name })),
        // F-CL-201 / F-CL-203
        sort: sort && sortValue ? { choices: sort.choices, value: sortValue, sortedBy } : null,
        work,
      }}
      actions={{
        onQuery: (next) => {
          setSelected([])
          writeAddress({ query: next }) // F-SA-225
        },
        onView: changeView,
        onSort: changeSort, // F-CL-203
        onWork: changeWork, // F-CL-202: the chip's ✕
        // F-CL-202: Clear all — the band's door and the chips in ONE write of the address.
        onClearChips: () => {
          setRows(loading())
          setSelected([])
          writeAddress({ filters: {}, work: null })
        },
        onFilters: (next) => {
          setRows(loading())
          setSelected([])
          writeAddress({ filters: next }) // F-SA-225
        },
        onMore: () => void onMore(),
        onRetry: () => {
          setRows(loading())
          refresh()
        },
        onShowUpdates: refresh,
        onSelect: setSelected,
        onDialog: (next) => (next ? setDialog(next) : closeDialog()),
        // B-W2b-427 (PLT-178): the likely duplicates of the draft as typed (VAT number, codice fiscale, name), with why.
        onLookup: (draft) => {
          void checkParty(api, { legalName: draft.party.legalName, tradeName: draft.party.tradeName, country: draft.party.country, vatNumber: draft.identity.vatNumber, fiscalCode: draft.identity.fiscalCode }).then(
            (found) => setDuplicates(found.map((candidate) => ({ id: candidate.id, code: candidate.code, legalName: candidate.name, tradeName: null, roles: candidate.roles as PartyRow['roles'], status: candidate.status as PartyRow['status'], reasons: candidate.reasons }))),
            () => undefined,
          )
        },
        onCreate,
        onBlock: (ids, reason) => {
          const targets = ids.map(rowOf).filter((row): row is PartyRow => !!row)
          if (targets.length === 1) void move(targets[0]!.id, 'block', reason)
          else void runBulk('block', targets, reason, dialog?.kind === 'block' ? dialog.notOn : undefined)
        },
        onOpen: (row) => router.push(recordHref(prefix, config, row.id)),
        onUnblock: (id) => void move(id, 'unblock'),
        onReactivate: (id) => void move(id, 'reactivate'),
        onArchive: (ids) => {
          const targets = ids.map(rowOf).filter((row): row is PartyRow => !!row)
          if (targets.length === 1) {
            setBusy(true)
            void moveParty(api, targets[0]!.id, 'archive', { version: targets[0]!.version })
              .then(() => {
                setNotice({ key: 'done.archive', tone: 'success', params: { name: partyName(targets[0]!) } })
                setDialog(null)
                refresh()
              })
              .catch((error: unknown) => setDialogProblem(problemKey(error)))
              .finally(() => setBusy(false))
          } else void runBulk('archive', targets, undefined, dialog?.kind === 'archive' ? dialog.notOn : undefined)
        },
        onCheckVies: (ids, notOn) => void onCheckVies(ids, notOn),
        // F-CL-103: the receipt's "Run the rest again" — the same act on the ones that failed (Block with its reason).
        onRunRest: (ids) => {
          const last = lastRun.current
          const targets = ids.map(rowOf).filter((row): row is PartyRow => !!row)
          if (last && targets.length > 0) void runBulk(last.kind, targets, last.reason)
        },
        onRecheckAll: () => void onRecheckAll(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
