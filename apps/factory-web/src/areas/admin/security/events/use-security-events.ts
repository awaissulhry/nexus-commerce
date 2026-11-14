'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ApiClient } from '../../../../lib/api/client'
import { problemKey } from '../../shared/model'
import { listSecurityEvents, oneSecurityEvent, type SecurityEvent } from './api'
import { eventsQuery, eventsState, type EventFilters } from './model'
import type { SecurityEventsModel } from './view/SecurityEventsCard'

const PAGE = 50

/**
 * Security events (SCR-166, B-W2b-413): the address is the state (`?view=&surface=&ip=&event=`, the export's own terms), so a
 * saved view, Back and the CSV agree. `GET /audit/security-events` 50 a page ("Show older": the API's cursor); `?event=<id>`
 * reads the event alone with the others from the same address. Read again when the tab comes back. `canView`: the person
 * holds security.events.view (the API also asks it over every company; a refusal says so in words).
 */
export function useSecurityEvents(api: ApiClient, canView: boolean): { model: SecurityEventsModel | null; actions: { onFilters: (filters: EventFilters) => void; onOpen: (id: string | null) => void; onOlder: () => void; onRetry: () => void } } {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const { filters, open: openId } = eventsState(params)
  const key = `${filters.view ?? ''}|${filters.surface ?? ''}|${filters.ip ?? ''}`
  const [events, setEvents] = useState<SecurityEvent[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [older, setOlder] = useState<{ loading: boolean; problem: string | null }>({ loading: false, problem: null })
  const [open, setOpen] = useState<SecurityEventsModel['open']>(null)
  const seq = useRef(0)

  const go = useCallback(
    (next: EventFilters, event: string | null, how: 'push' | 'replace') => {
      const query = eventsQuery(params?.toString() ?? '', next, event)
      const target = query ? `${pathname}?${query}` : (pathname ?? '')
      if (how === 'push') router.push(target, { scroll: false })
      else router.replace(target, { scroll: false })
    },
    [params, pathname, router],
  )

  const load = useCallback(async () => {
    if (!canView) return
    const mine = ++seq.current
    const [view, surface, ip] = key.split('|')
    setEvents(null)
    setProblem(null)
    setOlder({ loading: false, problem: null })
    try {
      const page = await listSecurityEvents(api, { view: (view || null) as EventFilters['view'], surface: (surface || null) as EventFilters['surface'], ip: ip || null, limit: PAGE })
      if (mine !== seq.current) return
      setEvents(page.events)
      setNextBefore(page.nextBefore)
    } catch (error) {
      if (mine === seq.current) setProblem(problemKey(error))
    }
  }, [api, canView, key])
  useEffect(() => {
    void load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  useEffect(() => {
    if (!canView || !openId) return setOpen(null)
    let stale = false
    setOpen({ id: openId, event: events?.find((event) => event.id === openId) ?? null, related: null, problem: null })
    oneSecurityEvent(api, openId).then(
      (answer) => !stale && setOpen({ id: openId, event: answer.event, related: answer.related, problem: null }),
      (error: unknown) => !stale && setOpen({ id: openId, event: null, related: null, problem: problemKey(error) }),
    )
    return () => {
      stale = true
    }
    // The open event is read again when it changes, not when a page of rows comes in.
  }, [api, canView, openId])

  const showOlder = async () => {
    if (!nextBefore || older.loading) return
    const mine = seq.current
    setOlder({ loading: true, problem: null })
    try {
      const page = await listSecurityEvents(api, { ...filters, before: nextBefore, limit: PAGE })
      if (mine !== seq.current) return
      setEvents((current) => [...(current ?? []), ...page.events])
      setNextBefore(page.nextBefore)
      setOlder({ loading: false, problem: null })
    } catch (error) {
      if (mine === seq.current) setOlder({ loading: false, problem: problemKey(error) })
    }
  }

  return {
    model: canView ? { filters, events, problem, nextBefore, older, open } : null,
    actions: {
      onFilters: (next) => go(next, null, 'push'),
      onOpen: (id) => go(filters, id, 'replace'),
      onOlder: () => void showOlder(),
      onRetry: () => void load(),
    },
  }
}
