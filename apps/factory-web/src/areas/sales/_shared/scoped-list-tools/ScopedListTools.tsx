'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { viewQuery } from '@nexus/factory-domain/views/state'
import { ListToolsContext, useListToolsTransport, type ListToolsTransport } from '../../../../list-frame/tools/transport'

/**
 * F-SA-277 (sales page plan R5, P18; 11-customer-page §3.6): the list tools of ONE list among several on a page. The Office's list
 * tools (areas/_shared/list-tools ListToolsProvider) read the page's address: Export ▾, Export N, saved views and Pin to Today take
 * its terms. Two lists stacked on one page (the customer's Quotes & incoming) keep their terms in memory instead — typing in one
 * never narrows the other, and the page's own terms (`tab`) stay — so each list's frame gets this transport: the page's own
 * (the API, the clipboard, the layout kept in this browser, Pin to Today, the custom fields) with
 *
 *   pageKey   the list's own key (`sales.quotes`), so its views and its export are that list's (a frame that names its key keeps it)
 *   query     that list's terms, its lock in (`party=<id>`): the file holds exactly the screen's rows (screen = file)
 *   goTo      a saved view's terms written back into that list's memory
 *   linked    none: the page's `?savedView=` / `?export=` are not this list's
 *   viewLink  Copy link opens the view on the list's own page
 *
 * Without the page's list tools (a design case, a test) there are none here either.
 */

/** What an embedded list hands its tools: its terms (an address query) and where a saved view's terms go. */
export interface ListScope {
  readonly query: string
  readonly onGoTo: (query: string) => void
}

/** The page's transport, scoped to one list (pure: a test holds it without a DOM). */
export function scopedTransport(parent: ListToolsTransport, scope: { readonly listKey: string; readonly page: string; readonly query: string; readonly goTo: (query: string) => void }): ListToolsTransport {
  return {
    ...parent,
    pageKey: scope.listKey,
    query: viewQuery(scope.query),
    linked: { view: null, export: null },
    goTo: scope.goTo,
    clearLinked: () => undefined,
    viewLink: (viewId) => `${window.location.origin}${scope.page}?savedView=${encodeURIComponent(viewId)}`,
  }
}

export function ScopedListTools({ listKey, page, scope, children }: { listKey: string; page: string; scope: ListScope; children?: ReactNode }) {
  const parent = useListToolsTransport()
  const goTo = useRef(scope.onGoTo)
  goTo.current = scope.onGoTo
  const transport = useMemo(() => (parent ? scopedTransport(parent, { listKey, page, query: scope.query, goTo: (query) => goTo.current(query) }) : null), [parent, listKey, page, scope.query])
  return <ListToolsContext.Provider value={transport}>{children}</ListToolsContext.Provider>
}
