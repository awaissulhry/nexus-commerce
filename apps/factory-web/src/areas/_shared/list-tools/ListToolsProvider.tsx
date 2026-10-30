'use client'

import { useMemo, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { listKeyOf, viewQuery } from '@nexus/factory-domain/views/state'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi } from '../../../lib/session/context'
import { ListToolsContext, type ListToolsTransport, type WorkingLayout } from '../../../list-frame/tools/transport'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { createView, exportFileAddress, listExports, listViews, readExport, removeView, startExport, updateView } from './api'

/**
 * The Office's list tools (B-W2a-23): mounted once by the Office shell, so every list frame of every Office page has
 * Columns ▾ (saved views, Customise) and, where the list has an export, Export ▾ — without a line of its own. It knows
 * the page's address (a view's filters are the list's own address terms), the API (platform/views, platform/exports),
 * the clipboard, and keeps each list's working layout in this browser (a per-person convenience: a view saved on the
 * server is what lasts and is shared).
 */

const LINK_TERMS = ['savedView', 'export']
const STORE = 'fw.listLayout.'

function readStored(listKey: string): WorkingLayout | null {
  try {
    const raw = window.localStorage.getItem(`${STORE}${listKey}`)
    if (!raw) return null
    const value = JSON.parse(raw) as WorkingLayout
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function writeStored(listKey: string, layout: WorkingLayout | null): void {
  try {
    if (layout) window.localStorage.setItem(`${STORE}${listKey}`, JSON.stringify(layout))
    else window.localStorage.removeItem(`${STORE}${listKey}`)
  } catch {
    // A private window or blocked storage: the layout lasts as long as the page.
  }
}

export function ListToolsProvider({ children }: { children?: ReactNode }) {
  const api = useOfficeApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const locale = useLocale() === 'en' ? 'en' : 'it'
  const search = params?.toString() ?? ''

  const transport = useMemo<ListToolsTransport>(() => {
    const page = pathname.replace(/^\/w\/[^/]+/, '') || '/'
    const pageKey = OFFICE_PAGES.has(page) ? listKeyOf(page) : null
    const current = new URLSearchParams(search)
    const without = () => {
      const next = new URLSearchParams(search)
      for (const term of LINK_TERMS) next.delete(term)
      return next.toString()
    }
    const address = (query: string) => `${pathname}${query ? `?${query}` : ''}`
    return {
      pageKey,
      query: viewQuery(search),
      linked: { view: current.get('savedView'), export: current.get('export') },
      goTo: (query) => router.replace(address(query), { scroll: false }),
      clearLinked: () => router.replace(address(without()), { scroll: false }),
      viewLink: (viewId) => `${window.location.origin}${pathname}?savedView=${encodeURIComponent(viewId)}`,
      locale,
      listViews: (listKey) => listViews(api, listKey),
      createView: (listKey, draft, key) => createView(api, listKey, draft, key),
      updateView: (view, change, key) => updateView(api, view, change, key),
      removeView: (view) => removeView(api, view),
      startExport: (ask, key) => startExport(api, ask, locale, key),
      readExport: (jobId) => readExport(api, jobId),
      listExports: (listKey) => listExports(api, listKey),
      download: async (job) => {
        window.location.assign(await exportFileAddress(api, job.id))
      },
      copy: async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          return false
        }
      },
      readLayout: readStored,
      writeLayout: writeStored,
      newKey: newIdempotencyKey,
    }
  }, [api, router, pathname, search, locale])

  return <ListToolsContext.Provider value={transport}>{children}</ListToolsContext.Provider>
}
