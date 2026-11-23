'use client'

import { useMemo, type ReactNode } from 'react'
import { ListToolsContext, useListToolsTransport, type ListToolsTransport } from '../../../../list-frame/tools/transport'

/**
 * F-CW-103 (customer Work tab; lead settle S12; review A1-B2) — the Work tab's OWN browser layout. The Orders sheet is ONE on three
 * pages under one list key (`sales.orders`: one export source, one set of saved views, one Pin to Today), and the list frame keeps
 * ONE working layout per list key in this browser. So a layout a person made on Sales › Orders (which orders every column of that
 * page) changed the columns of every customer's Work tab too, and the other way round. Here the Work tab's sheet gets the page's
 * own list tools with ONLY the working layout kept under its own key: its columns, its density and the view it started from are
 * the Work tab's; saved views, exports, Pin to Today and the custom fields pass through untouched (still `sales.orders`).
 *
 * No change in the list frame: the tab wraps the sheet in the frame's own context (as the customer page's Quotes & incoming does
 * for its two lists: areas/sales/_shared/scoped-list-tools).
 */

/** Where the Work tab's working layout is kept in this browser. */
export const WORK_LAYOUT_KEY = 'sales.orders:customer-work'

/** The page's transport with the sheet's working layout under the Work tab's own key (pure: a test holds it without a DOM). */
export function workLayoutTransport(parent: ListToolsTransport, listKey: string, layoutKey: string = WORK_LAYOUT_KEY): ListToolsTransport {
  const own = (key: string): string => (key === listKey ? layoutKey : key)
  return {
    ...parent,
    readLayout: (key) => parent.readLayout(own(key)),
    writeLayout: (key, layout) => parent.writeLayout(own(key), layout),
  }
}

export function WorkLayoutTools({ listKey, children }: { listKey: string; children?: ReactNode }) {
  const parent = useListToolsTransport()
  const transport = useMemo(() => (parent ? workLayoutTransport(parent, listKey) : null), [parent, listKey])
  return <ListToolsContext.Provider value={transport}>{children}</ListToolsContext.Provider>
}
