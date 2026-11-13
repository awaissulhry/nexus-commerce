'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLiveChanges } from '../../../record-panels/live'
import { readProblem, writeProblem, type Notice } from '../library/model'
import { createGroup, listGroups, moveGroup, styleOptions } from './api'
import { createGroupBodyOf, DISMISSED_STORE, formProblem, filtersOf, groupDraftOf, listQueryOf, optionsCan, searchOf, type OptionFilters } from './model'
import { useOnline } from './online'
import type { GroupFormModel, OptionsViewModel } from './view-model'
import { OptionsView } from './view/OptionsView'
// B-W2b-340 (SAL-249): Test a combination.
import { TestCombination } from './upkeep/TestCombination'

const readDismissed = (): string[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(DISMISSED_STORE) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(-50) : []
  } catch {
    return []
  }
}
const keepDismissed = (keys: string[]) => {
  try {
    window.localStorage.setItem(DISMISSED_STORE, JSON.stringify(keys.slice(-50)))
  } catch {
    // A private window or blocked storage: the notice comes back next time.
  }
}

/**
 * `/w/<company>/products/options` (SCR-114): reads the option groups with the tile's counts (product.styles.view), and —
 * with `?style=` (the Style studio's link) — the style's offers, option lines and steps; keeps live option_group.changed and
 * style.updated behind "N updates · Show"; writes through the API (each write one command at its version) and reads
 * again. `?new=1` opens New option group; a group made opens its record.
 */
export function OptionsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const online = useOnline()
  const can = useMemo(() => optionsCan(session.permissions), [session.permissions])
  const filters = useMemo(() => filtersOf(params), [params])
  const asked = params?.get('new') === '1'
  const prefix = pathname.replace(/\/products\/options\/?$/, '')
  const companyId = session.company?.id ?? null

  const [rows, setRows] = useState<OptionsViewModel['rows']>({ items: null, problem: null, ignored: [] })
  const [counts, setCounts] = useState<OptionsViewModel['counts']>(null)
  const [countsFailed, setCountsFailed] = useState(false)
  const [style, setStyle] = useState<OptionsViewModel['style']>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [newGroup, setNewGroup] = useState<GroupFormModel | null>(null)
  const readSeq = useRef(0)
  useEffect(() => setDismissed(readDismissed()), [])

  const address = useCallback((next: OptionFilters, extra: { new?: boolean } = {}) => `${pathname}${searchOf(next, extra)}`, [pathname])

  const load = useCallback(async () => {
    const mine = ++readSeq.current
    const { query, ignored } = listQueryOf(filters)
    setRows((current) => ({ ...current, items: null, problem: null }))
    try {
      const answer = await listGroups(api, query)
      if (mine !== readSeq.current) return
      setRows({ items: answer.groups, problem: null, ignored })
      setCounts(answer.counts)
      setCountsFailed(false)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (mine !== readSeq.current) return
      setRows({ items: null, problem: readProblem(error), ignored })
      setCounts(null)
      setCountsFailed(true)
    }
  }, [api, filters])

  const loadStyle = useCallback(() => {
    if (!filters.style) {
      setStyle(null)
      return
    }
    const id = filters.style
    setStyle({ id, options: null, problem: null })
    styleOptions(api, id)
      .then((options) => setStyle((current) => (current?.id === id ? { id, options, problem: null } : current)))
      .catch((error: unknown) => setStyle((current) => (current?.id === id ? { id, options: null, problem: readProblem(error) } : current)))
  }, [api, filters.style])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    loadStyle()
  }, [loadStyle])

  useLiveChanges({
    onChange: (change) => {
      // A style's offers changed = W1's style.updated (B-W2b-229): counted for the style the link names.
      if (change.type === 'option_group.changed' || (change.type === 'style.updated' && filters.style !== '' && change.fields.styleId === filters.style)) setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  const refresh = () => {
    void load()
    loadStyle()
  }

  const move = async (ids: string[], to: 'archive' | 'restore', reason: string): Promise<boolean> => {
    setBusy(true)
    let done = 0
    try {
      for (const id of ids) {
        const row = (rows.items ?? []).find((entry) => entry.id === id)
        if (!row) continue
        await moveGroup(api, row, to, reason || undefined)
        done++
      }
      setNotice({ key: to === 'archive' ? 'notice.archived' : 'notice.restored', tone: 'success', params: { count: done } })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error).key, tone: 'danger' })
      return false
    } finally {
      setBusy(false)
      void load()
    }
  }

  const openNew = useCallback(
    (open: boolean) => {
      if (!open) {
        setNewGroup(null)
        if (asked) router.replace(address(filters))
        return
      }
      setNewGroup({
        mode: 'new',
        draft: groupDraftOf(null, companyId),
        companies: session.companies.map((company) => ({ id: company.id, name: company.name })),
        // A group of every company asks a grant over every company: offered when the person works in every company they see.
        everyCompany: session.companies.length > 1 || companyId === null,
        busy: false,
        problem: null,
        refused: [],
        messages: [],
      })
    },
    [asked, router, address, filters, companyId, session.companies],
  )

  useEffect(() => {
    if (asked && can.manage && !newGroup) openNew(true)
    // Only when the address asks.
  }, [asked])

  const create = async () => {
    const form = newGroup
    if (!form) return
    setNewGroup({ ...form, busy: true, problem: null, refused: [], messages: [] })
    try {
      const group = await createGroup(api, createGroupBodyOf(form.draft))
      setNewGroup(null)
      router.push(`${prefix}/products/options/${group.id}`)
    } catch (error) {
      const problem = formProblem(writeProblem(error))
      setNewGroup((current) => (current ? { ...current, busy: false, problem: problem.key, refused: problem.paths, messages: problem.messages } : current))
    }
  }

  const model: OptionsViewModel = { prefix, companyId, can, filters, rows, counts, countsFailed, style, asOf, updates, dismissed, notice, busy, newGroup, offline: !online, /* B-W2b-340 */ bench: <TestCombination api={api} styleId={filters.style || null} permissions={session.permissions} /> }

  return (
    <OptionsView
      model={model}
      actions={{
        onFilters: (next) => router.replace(address(next)),
        onRetry: () => refresh(),
        onOpen: (row) => router.push(`${prefix}/products/options/${row.id}`),
        onShowUpdates: refresh,
        onDismissNotice: () => setNotice(null),
        onDismiss: (key) =>
          setDismissed((current) => {
            const next = [...current.filter((entry) => entry !== key), key]
            keepDismissed(next)
            return next
          }),
        onMove: move,
        onNewGroup: openNew,
        onGroupDraft: (draft) => setNewGroup((current) => (current ? { ...current, draft, refused: [] } : current)),
        onCreateGroup: () => void create(),
      }}
    />
  )
}
