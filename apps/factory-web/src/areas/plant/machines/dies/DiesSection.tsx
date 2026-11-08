'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { findSuppliers, type PlantSite } from '../../_shared/api'
import { downloadText, useCoalesced, useLive } from '../../_shared/hooks'
import { csvText } from '../../_shared/model'
import { createDie, dieChoices, findDieStyles, listDies, retireDie, updateDie, type Die, type DieSettableCondition, type StyleChoice } from './api'
import { blankDieDraft, createBodyOf, CSV_COLUMNS, csvRows, dieCan, dieFieldOf, dieProblemOf, diesAddressOf, diesQuery, rackChange, withDiesAddress, type DiesAddress } from './model'
import type { DieCellState, DieNotice, DieRowsState, DiesDialog, DiesModel } from './view-model'
import { DiesView } from './view/DiesView'

const PAGE = 50

/**
 * Plant › Machines & tools › Clicking dies (B-W2b-136; QHS-173): the section the machines page shows under its
 * SegmentedControl. Its own address terms (`dq`, `drows`, `dnew`; every other term of the page kept), pages of 50 with
 * "Show more", live `clicking_die.changed` behind "N updates · Show". Rack and condition save inline with the die's
 * version; New die creates through `POST /plant/dies`; Retire N retires one by one with the reason.
 */
export function DiesSection({ prefix, siteId, sites }: { prefix: string; siteId: string | null; sites: PlantSite[] }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const can = useMemo(() => dieCan(session.permissions), [session.permissions])
  const address = useMemo(() => diesAddressOf(params), [params])
  const t = useMemo(() => createTranslator(locale, messagesFor(locale, ['plant-dies'])['plant-dies']!), [locale])

  const go = useCallback((next: Partial<DiesAddress>) => router.replace(`${pathname}${withDiesAddress(params?.toString() ?? '', { ...address, ...next })}`, { scroll: false }), [router, pathname, params, address])

  const [rows, setRows] = useState<DieRowsState>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [slow, setSlow] = useState(false)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<DieNotice | null>(null)
  const readId = useRef(0)
  const query = useMemo(() => diesQuery(address, siteId), [address, siteId])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    const timer = setTimeout(() => id === readId.current && setSlow(true), 1000)
    try {
      const page = await listDies(api, { ...query, limit: PAGE })
      if (id !== readId.current) return
      setRows({ items: page.dies, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: dieProblemOf(error).key })
    } finally {
      clearTimeout(timer)
      if (id === readId.current) setSlow(false)
    }
  }, [api, can.view, query])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listDies(api, { ...query, cursor, limit: PAGE })
      setRows((current) => ({ items: [...(current.items ?? []), ...page.dies.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: dieProblemOf(error) })
    }
  }, [api, cursor, query])

  const count = useCoalesced(() => setUpdates((value) => value + 1), 300)
  const live = useLive(
    (change) => {
      if (change.type === 'clicking_die.changed') count()
    },
    () => void load(),
    can.view,
  )

  // ---- inline rack and condition -----------------------------------------------------------------------------------------
  const [cells, setCells] = useState<Record<string, DieCellState>>({})
  const save = useCallback(
    async (die: Die, field: 'rackLocation' | 'condition', change: { rackLocation?: string | null; condition?: DieSettableCondition }) => {
      const key = `${die.id}:${field}`
      setCells((current) => ({ ...current, [key]: { state: 'saving' } }))
      try {
        const saved = await updateDie(api, die.id, { version: die.version, ...change })
        setRows((current) => ({ ...current, items: current.items?.map((row) => (row.id === saved.id ? saved : row)) ?? null }))
        setCells((current) => ({ ...current, [key]: { state: 'saved' } }))
      } catch (error) {
        const words = dieProblemOf(error)
        setCells((current) => ({ ...current, [key]: { state: 'failed', words } }))
        setNotice({ tone: 'danger', words: { key: 'cell.refused', params: { die: die.code } }, detail: words })
      }
    },
    [api],
  )

  // ---- dialogs -----------------------------------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<DiesDialog | null>(null)
  const oneSite = siteId ?? (sites.length === 1 ? sites[0]!.id : null)
  useEffect(() => {
    if (address.isNew && can.view) setDialog((current) => (current?.kind === 'new' ? current : { kind: 'new', draft: blankDieDraft(oneSite), styles: null, choices: null, suppliers: null, busy: false, problem: null, field: null }))
    else setDialog((current) => (current?.kind === 'new' ? null : current))
  }, [address.isNew, can.view, oneSite])
  useEffect(() => {
    if (dialog?.kind === 'new' && !dialog.draft.siteId && oneSite) setDialog({ ...dialog, draft: { ...dialog.draft, siteId: oneSite } })
  }, [dialog, oneSite])

  const findStyle = useCallback(
    (text: string) => {
      if (text.trim().length === 0) return setDialog((current) => (current?.kind === 'new' ? { ...current, styles: null } : current))
      findDieStyles(api, text)
        .then((found) => setDialog((current) => (current?.kind === 'new' ? { ...current, styles: found } : current)))
        .catch(() => setDialog((current) => (current?.kind === 'new' ? { ...current, styles: [] } : current)))
    },
    [api],
  )
  const pickStyle = useCallback(
    (style: StyleChoice | null) => {
      setDialog((current) => (current?.kind === 'new' ? { ...current, draft: { ...current.draft, style, size: '', patternPieceId: null }, choices: null, field: null } : current))
      if (!style) return
      dieChoices(api, style.id)
        .then((choices) => setDialog((current) => (current?.kind === 'new' && current.draft.style?.id === style.id ? { ...current, choices } : current)))
        .catch(() => setDialog((current) => (current?.kind === 'new' && current.draft.style?.id === style.id ? { ...current, choices: { style, sizes: style.sizes, pieces: [] } } : current)))
    },
    [api],
  )
  const findSupplier = useCallback(
    (text: string) => {
      if (!can.parties || text.trim().length < 2) return setDialog((current) => (current?.kind === 'new' ? { ...current, suppliers: null } : current))
      findSuppliers(api, text)
        .then((found) => setDialog((current) => (current?.kind === 'new' ? { ...current, suppliers: found } : current)))
        .catch(() => setDialog((current) => (current?.kind === 'new' ? { ...current, suppliers: [] } : current)))
    },
    [api, can.parties],
  )

  const submitDialog = useCallback(async () => {
    if (!dialog || dialog.busy) return
    if (dialog.kind === 'new') {
      setDialog({ ...dialog, busy: true, problem: null, field: null })
      try {
        // A new key per try: a refused try changed nothing, and a second die with the same number is refused by its number.
        const die = await createDie(api, createBodyOf(dialog.draft, can), newIdempotencyKey())
        setDialog(null)
        setNotice({ tone: 'success', words: { key: 'done.registered', params: { die: die.code } } })
        go({ isNew: false })
        void load()
      } catch (error) {
        setDialog((current) => (current?.kind === 'new' ? { ...current, busy: false, problem: dieProblemOf(error), field: dieFieldOf(error) ?? (dieProblemOf(error).key === 'refusal.DIE_NUMBER_TAKEN' ? 'code' : null) } : current))
      }
      return
    }
    // Retire, one by one: a die refused is said in words; the others are retired.
    setDialog({ ...dialog, busy: true, problem: null, refused: [] })
    const refused: { code: string; words: ReturnType<typeof dieProblemOf> }[] = []
    let done = 0
    for (const die of dialog.dies) {
      try {
        await retireDie(api, die.id, { version: die.version, reason: dialog.reason.trim() })
        done += 1
      } catch (error) {
        refused.push({ code: die.code, words: dieProblemOf(error) })
      }
    }
    void load()
    if (refused.length === 0) {
      setDialog(null)
      setNotice({ tone: 'success', words: { key: 'done.retired', params: { count: done } } })
    } else {
      setDialog((current) => (current?.kind === 'retire' ? { ...current, busy: false, refused, dies: current.dies.filter((die) => refused.some((entry) => entry.code === die.code)) } : current))
      if (done > 0) setNotice({ tone: 'success', words: { key: 'done.retired', params: { count: done } } })
    }
  }, [dialog, api, can, go, load])

  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = [...CSV_COLUMNS, ...(can.cost ? (['cost'] as const) : [])].map((column) => t(`csv.${column}`))
      const lines = csvRows(picked, { everySize: t('die.everySize'), condition: (condition) => t(`condition.${condition}`) }, can.cost)
      downloadText(`clicking-dies-${new Date().toISOString().slice(0, 10)}.csv`, csvText(header, lines))
    },
    [rows.items, can.cost, t],
  )

  const model: DiesModel = { prefix, can, address, sites, siteId, rows, slow, asOf, live, updates, cells, dialog, notice }

  return (
    <DiesView
      model={model}
      actions={{
        onSearch: (q) => go({ q }),
        onRows: (next) => go({ rows: next }),
        onClearFilters: () => go({ q: '', rows: 'inUse' }),
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => void load(),
        onRack: (die, typed) => {
          const change = rackChange(die, typed)
          if (change !== undefined) void save(die, 'rackLocation', { rackLocation: change })
        },
        onCondition: (die, condition) => {
          if (condition !== die.condition) void save(die, 'condition', { condition })
        },
        onNew: () => go({ isNew: true }),
        onRetire: (dies) => setDialog({ kind: 'retire', dies, reason: '', busy: false, problem: null, refused: [] }),
        onDialogClose: () => {
          if (dialog?.kind === 'new') go({ isNew: false })
          setDialog(null)
        },
        onDraft: (patch) => setDialog((current) => (current?.kind === 'new' ? { ...current, draft: { ...current.draft, ...patch }, field: null } : current)),
        onFindStyle: findStyle,
        onPickStyle: pickStyle,
        onFindSupplier: findSupplier,
        onRetireReason: (reason) => setDialog((current) => (current?.kind === 'retire' ? { ...current, reason } : current)),
        onSubmitDialog: () => void submitDialog(),
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
