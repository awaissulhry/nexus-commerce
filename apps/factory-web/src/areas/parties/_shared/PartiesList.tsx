'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { checkVies, countParties, createParty, findParties, listParties, moveParty, type PartyRow, type NewPartyBody } from './api'
import { downloadText, partyEvent, useLive } from './hooks'
import {
  BULK_MAX,
  identityBody,
  identityWanted,
  loaded,
  loading,
  failed,
  partiesCsv,
  partyName,
  problemKey,
  recordHref,
  refusedFields,
  SIDES,
  TILE_VIEW,
  viesApplies,
  viewQuery,
  type BulkKind,
  type BulkResult,
  type BulkRun,
  type ListDialog,
  type ListFilters,
  type ListView,
  type Loaded,
  type NewPartyDraft,
  type Notice,
  type Side,
  type TileId,
} from './model'
import { PartiesListView } from './view/PartiesListView'

/**
 * The list container of both sides (`/w/<company>/sales/customers` SCR-032, `/w/<company>/purchasing/suppliers`
 * SCR-056): reads one page of 50 of the view (`GET /parties` with the side's roles), the tiles' counts (one count per
 * tile, the same filters), creates a party (and, for an EU business with parties.vies, asks VIES at once so the answer
 * is kept as the proof), blocks, unblocks, archives and reactivates with the version read, checks VIES one row or a
 * selection at a time, exports the view as CSV, and listens to the live stream: changes wait behind "N updates · Show"
 * (rows never move under the cursor). `?view=` keeps the view in the address; `?new=1` opens New.
 */
export function PartiesList({ side, headActions }: { side: Side; headActions?: (reload: () => void) => ReactNode }) {
  return (
    <WithMessages namespaces={['parties']}>
      <PartiesListContainer side={side} headActions={headActions} />
    </WithMessages>
  )
}

const VIEWS = new Set<string>(['open', 'active', 'prospects', 'brands', 'invoice', 'vies', 'blocked', 'archived', 'all', 'suppliers', 'subcontractors', 'carriers'])

function PartiesListContainer({ side, headActions }: { side: Side; headActions?: (reload: () => void) => ReactNode }) {
  const config = SIDES[side]
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT('parties')
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const can = { view: held.has('parties.view'), manage: held.has('parties.manage'), block: held.has('parties.block'), vies: held.has('parties.vies') }
  const prefix = companyPrefix(session.company?.code ?? '')
  const askedView = params?.get('view') ?? 'open'
  const [view, setView] = useState<ListView>(VIEWS.has(askedView) && (config.views as readonly string[]).includes(askedView) ? (askedView as ListView) : 'open')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<ListFilters>({})
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
  const [duplicates, setDuplicates] = useState<readonly PartyRow[]>([])
  const [bulk, setBulk] = useState<BulkRun | null>(null)
  const createKey = useRef<string | null>(null)
  const request = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!can.view) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const page = await listParties(api, viewQuery(config, view, filters, query), controller.signal)
      if (controller.signal.aborted) return
      setRows(loaded(page.parties))
      setTotal(page.count)
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      setSelected((current) => current.filter((id) => page.parties.some((row) => row.id === id)))
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return
      setRows(failed(problemKey(error)))
      setTotal(null)
    }
  }, [api, can.view, config, filters, query, view])

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

  // The search waits for a pause in typing (250 ms); a view or filter change reads at once.
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, query])
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

  const changeView = (next: ListView) => {
    setView(next)
    setRows(loading())
    setSelected([])
    const search = new URLSearchParams(params?.toString() ?? '')
    if (next === 'open') search.delete('view')
    else search.set('view', next)
    search.delete('new')
    const qs = search.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
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
      const tab = side === 'customers' && (party.invoiceBlocked || party.taxMode === 'EU_B2B') ? 'tax' : undefined
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

  /** One call per row, one result per row (the dialog shows them as they come). */
  const runBulk = async (kind: BulkKind, targets: readonly PartyRow[], reason?: string) => {
    const list = targets.slice(0, BULK_MAX)
    const results: BulkResult[] = []
    setBulk({ kind, total: list.length, results: [], done: false })
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
        result = { id: row.id, code: row.code, name: partyName(row), outcome: kind === 'vies' && isApiError(error) && error.kind === 'conflict' ? 'vies.refused' : problemKey(error), tone: 'danger' }
      }
      results.push(result)
      setBulk({ kind, total: list.length, results: [...results], done: false })
    }
    setBulk({ kind, total: list.length, results: [...results], done: true })
    setSelected([])
    refresh()
  }

  const onCheckVies = async (ids: readonly string[]) => {
    const targets = ids.map(rowOf).filter((row): row is PartyRow => !!row)
    if (targets.length !== 1) return void runBulk('vies', targets)
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

  const onExport = (list: readonly PartyRow[]) => {
    const csv = partiesCsv(list, {
      header: [
        t('csv.code'),
        t('csv.legalName'),
        t('csv.tradeName'),
        t('csv.roles'),
        t('csv.status'),
        t('csv.country'),
        t('csv.city'),
        t('csv.taxMode'),
        t('csv.vat'),
        t('csv.fiscalCode'),
        t('csv.vies'),
        t('csv.language'),
      ],
      status: (row) => t(`status.${row.status}`),
      roles: (row) => row.roles.map((role) => t(`role.${role}`)).join(' · '),
      vies: (row) => t(`vies.state.${row.vies.state}`),
      taxMode: (row) => (row.taxMode ? t(`taxMode.${row.taxMode}`) : ''),
    })
    downloadText(`${t(`${side}.file`)}-${new Date().toISOString().slice(0, 10)}.csv`, csv)
    setNotice({ key: 'list.exported', tone: 'success', params: { count: list.length } })
  }

  const onMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const page = await listParties(api, { ...viewQuery(config, view, filters, query), cursor })
      setRows((current) => loaded([...(current.items ?? []), ...page.parties]))
      setCursor(page.nextCursor)
      setTotal(page.count)
    } catch (error) {
      setNotice({ key: problemKey(error), tone: 'danger' })
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <PartiesListView
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
      }}
      actions={{
        onQuery: (next) => {
          setQuery(next)
          setSelected([])
        },
        onView: changeView,
        onFilters: (next) => {
          setFilters(next)
          setRows(loading())
          setSelected([])
        },
        onClearAll: () => {
          setQuery('')
          setFilters({})
          if (view !== 'open') changeView('open')
        },
        onMore: () => void onMore(),
        onRetry: () => {
          setRows(loading())
          refresh()
        },
        onShowUpdates: refresh,
        onSelect: setSelected,
        onDialog: (next) => (next ? setDialog(next) : closeDialog()),
        onLookup: (q) => {
          void findParties(api, q).then(
            (found) => setDuplicates((current) => [...current.filter((row) => !found.some((other) => other.id === row.id)), ...found].slice(0, 5)),
            () => undefined,
          )
        },
        onCreate,
        onBlock: (ids, reason) => {
          const targets = ids.map(rowOf).filter((row): row is PartyRow => !!row)
          if (targets.length === 1) void move(targets[0]!.id, 'block', reason)
          else void runBulk('block', targets, reason)
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
          } else void runBulk('archive', targets)
        },
        onCheckVies: (ids) => void onCheckVies(ids),
        onRecheckAll: () => void onRecheckAll(),
        onExport,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
