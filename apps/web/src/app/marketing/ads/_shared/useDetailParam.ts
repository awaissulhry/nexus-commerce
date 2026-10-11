'use client'

/**
 * useDetailParam — the open row's detail lives in the address (Keyword Harvest page F1, 2026-10-10; shared with Bid:
 * `?rule=&tab=`, `?bid=&tab=`; Harvest: `?term=&tab=`).
 *
 * The rules, so the browser's Back does what the operator expects:
 *   - open        = PUSH a history entry: Back closes the modal and leaves the page where it was;
 *   - Prev / Next = REPLACE (`go`): walking ten rows must not take ten Backs to leave;
 *   - a tab       = REPLACE (`setTab`), for the same reason;
 *   - close       = BACK when this hook pushed the entry it is on (the address returns to what it was before the
 *                   open, other params included), else REPLACE without the keys — a modal opened from a shared link
 *                   or a reload must not send the operator off the page.
 * Every other param of the page is kept. Pure parts (`detailSearch`, `detailCloseMode`) are tested in Node.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'

export interface DetailParamKeys {
  /** The row id's param: `term`. */
  key: string
  /** The tab's param: `tab`. Optional. */
  tabKey?: string
}

/**
 * The query string with the detail set (or, with `id` null, removed together with its tab). Other params are kept in
 * their order. A tab that is null or '' is removed. Returns it without '?'.
 */
export function detailSearch(search: string | URLSearchParams, keys: DetailParamKeys, next: { id: string | null; tab?: string | null }): string {
  const out = new URLSearchParams(search)
  if (next.id == null || next.id === '') {
    out.delete(keys.key)
    if (keys.tabKey) out.delete(keys.tabKey)
    return out.toString()
  }
  out.set(keys.key, next.id)
  if (keys.tabKey) {
    if (next.tab) out.set(keys.tabKey, next.tab)
    else out.delete(keys.tabKey)
  }
  return out.toString()
}

/** How to close: go back over the entry this hook pushed, or replace the address when the entry was not ours. */
export const detailCloseMode = (pushedByThisHook: boolean): 'back' | 'replace' => (pushedByThisHook ? 'back' : 'replace')

/** How to show a row: push when nothing was open (Back closes it), replace when moving between rows. */
export const detailOpenMode = (alreadyOpen: boolean): 'push' | 'replace' => (alreadyOpen ? 'replace' : 'push')

export interface DetailParam {
  /** The open row's id, or null. */
  id: string | null
  /** The open tab, or null (the modal's default tab). */
  tab: string | null
  /** Open a row (push), or — when one is open — show another (replace). */
  open(id: string, tab?: string | null): void
  /** Prev / Next: show another row, same tab (replace). */
  go(id: string): void
  /** Show another tab (replace). */
  setTab(tab: string | null): void
  /** Close: back over our entry, else replace without the keys. */
  close(): void
}

export function useDetailParam(keys: DetailParamKeys): DetailParam {
  const { key, tabKey } = keys
  const router = useRouter()
  const params = useSearchParams()
  const search = params.toString()
  const id = params.get(key) || null
  const tab = tabKey ? params.get(tabKey) || null : null

  // Did THIS hook push the entry the address is on? Cleared when the detail closes by any route (Back included).
  const pushed = useRef(false)
  useEffect(() => { if (!id) pushed.current = false }, [id])

  // The latest address, so a handler held by a modal never writes from a stale one.
  const latest = useRef({ search, id, tab })
  latest.current = { search, id, tab }

  const write = useCallback((mode: 'push' | 'replace', next: { id: string | null; tab?: string | null }) => {
    const qs = detailSearch(latest.current.search, { key, tabKey }, next)
    router[mode](qs ? `?${qs}` : '?', { scroll: false })
  }, [router, key, tabKey])

  const open = useCallback((nextId: string, nextTab?: string | null) => {
    const mode = detailOpenMode(!!latest.current.id)
    write(mode, { id: nextId, tab: nextTab === undefined ? (mode === 'replace' ? latest.current.tab : null) : nextTab })
    if (mode === 'push') pushed.current = true
  }, [write])
  const go = useCallback((nextId: string) => write('replace', { id: nextId, tab: latest.current.tab }), [write])
  const setTab = useCallback((nextTab: string | null) => {
    if (latest.current.id) write('replace', { id: latest.current.id, tab: nextTab })
  }, [write])
  const close = useCallback(() => {
    if (!latest.current.id) return
    if (detailCloseMode(pushed.current) === 'back') {
      pushed.current = false
      router.back()
      return
    }
    write('replace', { id: null })
  }, [router, write])

  return useMemo(() => ({ id, tab, open, go, setTab, close }), [id, tab, open, go, setTab, close])
}
