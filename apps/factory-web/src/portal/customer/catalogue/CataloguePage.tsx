'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { useOffline } from '../orders/hooks'
import { newOrderHref } from '../neworder/model'
import { NotInAccess } from '../neworder/view/parts'
import { useOrderingWords } from '../neworder/words'
import { fetchCatalogue, fetchStyle, type CatalogueRead, type StyleDetail } from './api'
import { catalogueBandOf } from './band'
import { catalogueHref, filtersOf, NO_FILTERS, NS, orderHeld, resultIds, viewOf, type CatalogueFilters, type CatalogueViewMode } from './model'
import { CatalogueView } from './view/CatalogueView'
import type { StyleDetailModel } from './view/StyleDetailDialog'

/**
 * `/p/<party>/catalogue?q=&category=&season=&ppe=&range=&view=cards|list&style=<id>` for a customer (B-W2b-194, SCR-226;
 * design portal.customer.catalogue): the styles they may buy (GET /portal/catalogue), filters in the address, the style in
 * a DetailModal (GET /portal/catalogue/:styleId, `style=` keeps it), "Add to order" / "Start an order" open the draft of
 * New order & reorder (`/orders/new?styles=…`). Nothing here writes. No partner live event names a price list or a range
 * change: the page reads again when the tab comes back or the live channel reconnects, and says "Catalogue updated · Show"
 * when what it shows changed.
 */
export function CustomerCataloguePage() {
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'lists']}>
      <CatalogueContainer />
    </WithMessages>
  )
}

type Load = 'loading' | 'error' | 'ready'

const signature = (read: CatalogueRead): string => JSON.stringify(read.styles.map((style) => [style.id, style.priceFrom ?? null, style.colours.length, style.range]))

function CatalogueContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const search = useSearchParams()
  const words = useOrderingWords()
  const offline = useOffline()
  const allowed = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.catalogue.view')
  const mayOrder = frame.me.permissions.includes('portal.orderRequests.manage')
  const filters = useMemo(() => filtersOf(search), [search])
  const view = viewOf(search?.get('view'))
  const styleId = search?.get('style') ?? null

  const [load, setLoad] = useState<Load>('loading')
  const [read, setRead] = useState<CatalogueRead | null>(null)
  const [pending, setPending] = useState<CatalogueRead | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [offlineSince, setOfflineSince] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ id: string; state: StyleDetailModel['state']; detail: StyleDetail | null } | null>(null)
  const [detailTry, setDetailTry] = useState(0)
  const readRef = useRef<CatalogueRead | null>(null)
  readRef.current = read

  const go = useCallback((next: CatalogueFilters, extra: { view?: CatalogueViewMode; style?: string | null } = {}) => router.replace(catalogueHref(frame.prefix, next, { view: extra.view ?? view, style: extra.style === undefined ? styleId : extra.style }), { scroll: false }), [router, frame.prefix, view, styleId])

  // The styles for these filters.
  const filterKey = JSON.stringify(filters)
  useEffect(() => {
    if (!allowed) return
    const control = new AbortController()
    setLoad((state) => (readRef.current ? state : 'loading'))
    fetchCatalogue(api, filters, control.signal)
      .then((next) => {
        setRead(next)
        setPending(null)
        setLoad('ready')
        setSelected((ids) => ids.filter((id) => next.styles.some((style) => style.id === id)))
      })
      .catch((error: unknown) => {
        if (control.signal.aborted) return
        setLoad('error')
        if (isApiError(error) && error.kind === 'unavailable') setOfflineSince(readRef.current?.asOf ?? null)
      })
    return () => control.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, allowed, filterKey])

  const retry = () => {
    setLoad('loading')
    fetchCatalogue(api, filters)
      .then((next) => {
        setRead(next)
        setLoad('ready')
      })
      .catch(() => setLoad('error'))
  }

  // Read again quietly (tab back, reconnect): changes wait behind "Catalogue updated · Show".
  const recheck = useCallback(() => {
    if (!readRef.current) return
    fetchCatalogue(api, filters)
      .then((next) => {
        if (readRef.current && signature(next) !== signature(readRef.current)) setPending(next)
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filterKey])
  usePortalLive({ onReconnect: recheck }, allowed)
  useEffect(() => {
    const onVisible = () => (document.visibilityState === 'visible' ? recheck() : undefined)
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [recheck])

  useEffect(() => {
    if (offline) setOfflineSince((since) => since ?? readRef.current?.asOf ?? new Date().toISOString())
    else setOfflineSince(null)
  }, [offline])

  // The style on show (`style=`).
  useEffect(() => {
    if (!allowed || !styleId) {
      setDetail(null)
      return
    }
    const control = new AbortController()
    setDetail((current) => ({ id: styleId, state: 'loading', detail: current?.id === styleId ? current.detail : null }))
    fetchStyle(api, styleId, control.signal)
      .then((next) => setDetail({ id: styleId, state: 'ready', detail: next }))
      .catch((error: unknown) => {
        if (control.signal.aborted) return
        setDetail({ id: styleId, state: isApiError(error) && error.kind === 'not_found' ? 'missing' : 'error', detail: null })
      })
    return () => control.abort()
  }, [api, allowed, styleId, detailTry])

  // `/` focuses the catalogue's search (before the frame's own search, which answers anywhere else).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('[role="dialog"]')) return
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const field = document.querySelector<HTMLInputElement>('.fw-pcat-search')
      if (!field) return
      event.preventDefault()
      field.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const held = orderHeld({ mayOrder, preview: frame.me.preview, offline })
  const add = (ids: readonly string[]) => {
    if (held || ids.length === 0) return
    router.push(newOrderHref(frame.prefix, { way: 'pick', styles: ids }))
  }

  usePortalBand(
    allowed
      ? catalogueBandOf({ words, asOf: read?.asOf ?? null, start: newOrderHref(frame.prefix), startHeld: held ? words.t(held) : null })
      : { title: words.t('catalogue.title') },
  )

  if (!allowed) return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />

  const ids = resultIds(read)
  return (
    <CatalogueView
      model={{
        state: load,
        read,
        filters,
        view,
        prefix: frame.prefix,
        filtersOpen,
        selected,
        addHeld: held,
        offlineSince,
        updated: pending !== null,
        detail: detail
          ? {
              state: detail.state,
              id: detail.id,
              detail: detail.detail,
              ids,
              addHeld: held,
              sheetHref: `${frame.prefix}/catalogue/${encodeURIComponent(detail.id)}/sheet`,
            }
          : null,
      }}
      actions={{
        onSearch: (q) => go({ ...filters, q }),
        onFilter: (patch) => go({ ...filters, ...patch }),
        onClear: () => go(NO_FILTERS),
        onView: (next) => go(filters, { view: next }),
        onToggleFilters: () => setFiltersOpen((open) => !open),
        onOpen: (id) => go(filters, { style: id }),
        onAdd: add,
        onSelect: setSelected,
        onRetry: retry,
        onShowUpdate: () => {
          if (pending) setRead(pending)
          setPending(null)
        },
        onAsk: () => frame.ask(null),
        detail: {
          onClose: () => go(filters, { style: null }),
          onGo: (id) => go(filters, { style: id }),
          onAdd: (id) => add([id]),
          onRetry: () => setDetailTry((n) => n + 1),
        },
      }}
    />
  )
}
