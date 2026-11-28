'use client'

import { useEffect, useState } from 'react'
import { backPlaceOf, type BackInput, type BackPlace } from './back'

/** The browser's Navigation API, read where the browser has it (a browser without it: no history is read, the band keeps its list). */
interface HistoryEntries {
  readonly currentEntry?: { readonly index: number } | null
  entries?: () => readonly { readonly url: string | null }[]
}

/** The addresses before this one in this tab's history, newest first (none where the browser does not say). */
export function previousAddresses(nav: HistoryEntries | null | undefined): string[] {
  const index = nav?.currentEntry?.index ?? -1
  const list = nav?.entries
  if (!nav || index <= 0 || typeof list !== 'function') return []
  const entries = list.call(nav)
  const out: string[] = []
  for (let at = Math.min(index, entries.length) - 1; at >= 0 && out.length < 10; at -= 1) {
    const url = entries[at]?.url
    if (url) out.push(url)
  }
  return out
}

/**
 * owb-of5 step 1 — where the band's Back goes (back.ts): read once when the page opens, from the tab's own history. Null before the
 * read and when nothing before is this office's (the band keeps its list).
 */
export function useBackPlace(input: BackInput): BackPlace | null {
  const [place, setPlace] = useState<BackPlace | null>(null)
  const customerId = input.customer?.id ?? null
  const customerName = input.customer?.name ?? null
  useEffect(() => {
    const nav = (window as unknown as { navigation?: HistoryEntries }).navigation
    setPlace(backPlaceOf(previousAddresses(nav), { prefix: input.prefix, here: input.here, customer: customerId && customerName ? { id: customerId, name: customerName } : null }))
  }, [input.prefix, input.here, customerId, customerName])
  return place
}
