'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChannelListingIssuesPage } from '@nexus/shared/channel-listing-issues'
import { getBackendUrl } from '@/lib/backend-url'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'

interface State { key: string; page: ChannelListingIssuesPage | null; busy: boolean; error: string | null }
const unavailable = 'Saved listing issues could not be loaded. Refresh to try again.'

function checkedPage(value: ChannelListingIssuesPage, connectionId: string, workspaceId: string | null): ChannelListingIssuesPage {
  if (!value || value.connectionId !== connectionId || (workspaceId !== null && value.workspaceId !== workspaceId)
    || typeof value.workspaceId !== 'string' || typeof value.channel !== 'string' || !Number.isFinite(Date.parse(value.readAt))
    || !(value.nextCursor === null || typeof value.nextCursor === 'string') || !Array.isArray(value.items)
    || value.items.some(row => !row || !['id', 'listingId', 'productId', 'productSku', 'marketplace', 'code', 'severity', 'message', 'source'].every(field => typeof row[field as keyof typeof row] === 'string')
      || !Array.isArray(row.attributeNames) || !row.attributeNames.every(name => typeof name === 'string')
      || !Number.isFinite(Date.parse(row.firstSeenAt)) || !Number.isFinite(Date.parse(row.lastSeenAt))
      || (row.occurredAt !== null && !Number.isFinite(Date.parse(row.occurredAt))))) throw new Error(unavailable)
  return value
}

export function useListingIssues(connectionId: string, workspaceId?: string | null) {
  const scoped = WORKSPACES_ENABLED, selectedWorkspace = scoped ? workspaceId ?? null : null
  const key = JSON.stringify([connectionId, scoped ? selectedWorkspace : 'legacy'])
  const [state, setState] = useState<State | null>(null)
  const request = useRef<{ sequence: number; controller?: AbortController }>({ sequence: 0 })
  const load = useCallback(async (after: string | null, previous: ChannelListingIssuesPage | null = null) => {
    const sequence = ++request.current.sequence
    request.current.controller?.abort()
    if (scoped && !selectedWorkspace) { setState({ key, page: null, busy: false, error: null }); return }
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000)
    request.current.controller = controller
    setState({ key, page: previous, busy: true, error: null })
    try {
      const headers: Record<string, string> = selectedWorkspace ? { 'x-nexus-workspace-id': selectedWorkspace } : {}
      const res = await fetch(`${getBackendUrl()}/api/cx/connections/${encodeURIComponent(connectionId)}/listing-issues?take=25${after ? `&after=${encodeURIComponent(after)}` : ''}`, {
        credentials: 'include', cache: 'no-store', headers, signal: controller.signal,
      })
      if (!res.ok) throw new Error(unavailable)
      const page = checkedPage(await res.json(), connectionId, selectedWorkspace)
      // Rows can change between live pages. Preserve one row per finding, with the newest observed value.
      if (previous) page.items = [...new Map([...previous.items, ...page.items].map(row => [row.id, row])).values()]
      if (request.current.sequence === sequence) setState({ key, page, busy: false, error: null })
    } catch {
      if (request.current.sequence === sequence) setState({ key, page: previous, busy: false, error: unavailable })
    } finally { clearTimeout(timeout) }
  }, [connectionId, key, scoped, selectedWorkspace])
  const reload = useCallback(() => load(null), [load])
  useEffect(() => { void reload(); return () => { request.current.sequence++; request.current.controller?.abort() } }, [reload])
  const visible = state?.key === key ? state : { key, page: null, busy: !(scoped && !selectedWorkspace), error: null }
  const loadMore = async () => { if (!visible.busy && visible.page?.nextCursor) await load(visible.page.nextCursor, visible.page) }
  return { ...visible, reload, loadMore }
}
