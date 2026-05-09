'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import type { useRouter as useRouterType } from 'next/navigation'
import {
  Search,
  Package,
  FileText,
  Settings as SettingsIcon,
  Tag,
  Layers,
  Upload,
  Boxes,
  Activity,
  ClipboardList,
  HeartPulse,
  History,
  Plug,
  FileEdit,
  Warehouse,
  Keyboard,
  Plus,
  RefreshCw,
  X,
  Truck,
  ShieldAlert,
  ArrowRightLeft,
  AlertTriangle,
  Sparkles,
  Beaker,
  Snowflake,
  Globe,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

type AppRouter = ReturnType<typeof useRouterType>

interface Command {
  id: string
  label: string
  icon: LucideIcon
  /** Comma-separated extra keywords for fuzzy matching, e.g. for
   *  "Refresh page" we want "reload" / "fetch" to also match. */
  keywords?: string
  group: 'Recent' | 'On this page' | 'Navigation' | 'Catalog' | 'System' | 'Action' | 'Listings' | 'Shipments' | 'Pending orders' | 'Replenishment'
  /** Either href (navigate) or run (callback). One must be set. */
  href?: string
  run?: (router: AppRouter) => void
  /** Optional Linear-style chord (e.g. 'g p' for "go to products"). */
  chord?: string
  /** If set, the command only shows in the "On this page" group when
   *  the current pathname matches. Use a string for exact match or
   *  a RegExp for prefix-style matching. */
  contextPath?: string | RegExp
}

const COMMANDS: Command[] = [
  // Navigation
  { id: 'goto-products', label: 'Go to Products', icon: Package, href: '/products', group: 'Navigation', chord: 'g p' },
  { id: 'goto-listings', label: 'Go to All Listings', icon: Boxes, href: '/listings', group: 'Navigation', chord: 'g l' },
  { id: 'goto-orders', label: 'Go to Orders', icon: FileText, href: '/orders', group: 'Navigation', chord: 'g o' },
  { id: 'goto-pricing', label: 'Go to Pricing', icon: Tag, href: '/pricing', group: 'Navigation', chord: 'g r' },
  { id: 'goto-stock', label: 'Go to Stock', icon: Warehouse, href: '/fulfillment/stock', group: 'Navigation', chord: 'g s' },
  { id: 'goto-pos', label: 'Go to Purchase Orders (approval workflow)', icon: FileEdit, href: '/fulfillment/purchase-orders', group: 'Navigation', chord: 'g u' },
  { id: 'goto-pick-list', label: 'Go to Pick List (warehouse picking)', icon: ClipboardList, href: '/fulfillment/outbound/pick-list', group: 'Navigation', chord: 'g k' },
  { id: 'goto-outbound', label: 'Go to Outbound (pending shipments)', icon: ClipboardList, href: '/fulfillment/outbound', group: 'Navigation', chord: 'g f' },
  { id: 'goto-shipping-rules', label: 'Go to Shipping Rules', icon: FileEdit, href: '/fulfillment/outbound/rules', group: 'Navigation' },
  { id: 'goto-outbound-analytics', label: 'Go to Outbound Analytics (cycle time, late rate, carrier perf)', icon: Activity, href: '/fulfillment/outbound/analytics', group: 'Navigation' },
  { id: 'goto-carriers', label: 'Go to Carriers (Sendcloud, Buy Shipping, BRT, Poste, GLS, DHL, UPS, FedEx)', icon: Truck, href: '/fulfillment/carriers', group: 'Navigation', keywords: 'shipping providers integrations sendcloud brt poste gls dhl ups fedex amazon buy shipping spedizioni corrieri' },
  { id: 'goto-qc-queue', label: 'Go to QC Queue (inbound supervisor review)', icon: ClipboardList, href: '/fulfillment/inbound/qc-queue', group: 'Navigation', chord: 'g q' },
  { id: 'goto-routing-rules', label: 'Go to Order Routing Rules', icon: FileEdit, href: '/fulfillment/routing-rules', group: 'Navigation' },
  { id: 'goto-cycle-count', label: 'Go to Cycle Counts (physical inventory)', icon: ClipboardList, href: '/fulfillment/stock/cycle-count', group: 'Navigation' },
  { id: 'goto-recalls', label: 'Go to Lot Recalls (GPSR compliance)', icon: ShieldAlert, href: '/fulfillment/stock/recalls', group: 'Navigation', keywords: 'recall richiamo gpsr lot batch defect compliance safety helmet agv' },
  { id: 'goto-stock-transfers', label: 'Go to Stock Transfers (inter-location)', icon: ArrowRightLeft, href: '/fulfillment/stock/transfers', group: 'Navigation', keywords: 'transfer trasferimenti location move' },
  { id: 'goto-stock-reservations', label: 'Go to Stock Reservations (active holds)', icon: Boxes, href: '/fulfillment/stock/reservations', group: 'Navigation', keywords: 'reservations prenotazioni hold cart pending order' },
  { id: 'goto-stockouts', label: 'Go to Stockouts (loss tracking)', icon: AlertTriangle, href: '/fulfillment/stock/stockouts', group: 'Navigation', keywords: 'stockout esauriti out of stock loss revenue margin' },
  { id: 'goto-stock-analytics', label: 'Go to Stock Analytics (turnover, DoH, ABC, year-end)', icon: Activity, href: '/fulfillment/stock/analytics', group: 'Navigation', keywords: 'turnover rotazione doh abc rimanenze fiscal year-end valutazione' },
  { id: 'goto-replenishment', label: 'Go to Replenishment (forecast, recommendations, automation)', icon: RefreshCw, href: '/fulfillment/replenishment', group: 'Navigation', chord: 'g r r', keywords: 'replenishment riassortimento riordino reorder forecast previsione recommendation raccomandazione automation automazione' },
  { id: 'goto-replen-critical', label: 'Replenishment — Critical only', icon: AlertTriangle, href: '/fulfillment/replenishment?filter=CRITICAL', group: 'Replenishment', keywords: 'critical critico urgent emergenza stockout' },
  { id: 'goto-replen-needs-reorder', label: 'Replenishment — Awaiting review', icon: ClipboardList, href: '/fulfillment/replenishment?filter=NEEDS_REORDER', group: 'Replenishment', keywords: 'awaiting review revisione reorder riordino pending in attesa' },
  { id: 'goto-replen-automation', label: 'Replenishment — Automation rules (8 templates)', icon: Sparkles, href: '/fulfillment/replenishment#automation', group: 'Replenishment', keywords: 'automation regole rules templates auto-approve auto-PO emergency stockout overstock spike' },
  { id: 'goto-replen-scenarios', label: 'Replenishment — What-if scenarios', icon: Beaker, href: '/fulfillment/replenishment#scenarios', group: 'Replenishment', keywords: 'scenario what-if simulazione promo black friday lead time disruption supplier swap' },
  { id: 'goto-replen-slow-movers', label: 'Replenishment — Slow-movers / dead-stock', icon: Snowflake, href: '/fulfillment/replenishment#slow-movers', group: 'Replenishment', keywords: 'slow mover dead stock dormant ferma capitale immobilizzato write-off markdown' },
  { id: 'goto-replen-pan-eu', label: 'Replenishment — Pan-EU rebalance (FBA)', icon: Globe, href: '/fulfillment/replenishment#pan-eu', group: 'Replenishment', keywords: 'pan-eu fba distribution rebalance riequilibrio marketplace IT DE FR ES NL transfer' },
  { id: 'goto-replen-supplier-spend', label: 'Replenishment — Supplier spend (30/90/365d)', icon: Activity, href: '/fulfillment/replenishment#supplier-spend', group: 'Replenishment', keywords: 'supplier fornitore spend spesa commitment impegno PO ordine purchase order analytics' },
  { id: 'goto-replen-forecast-bias', label: 'Replenishment — Forecast bias (over/under)', icon: Activity, href: '/fulfillment/replenishment#forecast-bias', group: 'Replenishment', keywords: 'bias overforecast underforecast accuracy MAPE percent error calibrated previsione errore segno' },
  { id: 'goto-replen-cannibalization', label: 'Replenishment — Cannibalization (new launch impact)', icon: ArrowRightLeft, href: '/fulfillment/replenishment#cannibalization', group: 'Replenishment', keywords: 'cannibalization cannibalizzazione substitute substitute substitution sostituzione new launch lancio impact velocity drop' },
  { id: 'goto-returns', label: 'Go to Returns (RMA + refund workflow)', icon: RefreshCw, href: '/fulfillment/returns', group: 'Navigation', chord: 'g t' },
  { id: 'goto-returns-analytics', label: 'Go to Returns Analytics (rates, top SKUs, processing time)', icon: Activity, href: '/fulfillment/returns/analytics', group: 'Navigation', keywords: 'returns rate sku processing analytics' },
  { id: 'goto-activity', label: 'Go to Sync Logs (observability hub)', icon: Activity, href: '/sync-logs', group: 'Navigation', keywords: 'monitoring observability hub kpi cron channel' },
  { id: 'goto-api-calls', label: 'Go to API Calls (latency, errors, live tail)', icon: Activity, href: '/sync-logs/api-calls', group: 'Navigation', keywords: 'amazon ebay sp-api requests latency p95 p99 csv export live tail' },
  { id: 'goto-error-groups', label: 'Go to Error Groups (Sentry-tier rolled-up errors)', icon: Activity, href: '/sync-logs/errors', group: 'Navigation', keywords: 'errors fingerprint resolve mute ignore sentry' },
  { id: 'goto-webhooks', label: 'Go to Inbound Webhooks (replay, payload)', icon: Activity, href: '/sync-logs/webhooks', group: 'Navigation', keywords: 'shopify woocommerce etsy replay payload signature' },
  { id: 'goto-alerts', label: 'Go to Alerts (rules + events)', icon: Activity, href: '/sync-logs/alerts', group: 'Navigation', keywords: 'alert rule pagerduty error rate latency notify slack email' },
  { id: 'goto-audit-log', label: 'Go to Audit Log (every mutation)', icon: History, href: '/audit-log', group: 'Navigation', chord: 'g a' },
  { id: 'goto-health', label: 'Go to Sync Health', icon: HeartPulse, href: '/dashboard/health', group: 'Navigation', chord: 'g h' },
  // Catalog actions
  { id: 'catalog-organize', label: 'Organize catalog (group orphans, promote standalones)', icon: Layers, href: '/catalog/organize', group: 'Catalog', chord: 'g c' },
  { id: 'wizard-drafts', label: 'Resume a listing wizard draft', icon: FileEdit, href: '/products/drafts', group: 'Catalog', chord: 'g d' },
  { id: 'bulk-upload', label: 'Bulk upload products', icon: Upload, href: '/bulk-operations', group: 'Catalog', chord: 'g b' },
  { id: 'bulk-history', label: 'View bulk operations history', icon: History, href: '/bulk-operations/history', group: 'Catalog', chord: 'g j' },
  // System
  { id: 'connections', label: 'Manage channel connections', icon: Plug, href: '/settings/channels', group: 'System' },
  { id: 'settings', label: 'Open Settings', icon: SettingsIcon, href: '/settings/account', group: 'System' },
  // U.11 — Actions: non-navigation commands that *do* things. Keep
  // them generic enough to be available everywhere (no contextPath);
  // page-specific actions go below in PAGE_COMMANDS.
  {
    id: 'action-new-product',
    label: 'Create new product',
    icon: Plus,
    href: '/products/new',
    group: 'Action',
    keywords: 'add create draft sku item',
    chord: 'g n',
  },
  {
    id: 'action-upload-csv',
    label: 'Upload products via CSV',
    icon: Upload,
    href: '/bulk-operations',
    group: 'Action',
    keywords: 'import bulk spreadsheet',
  },
  {
    id: 'action-refresh',
    label: 'Refresh current page',
    icon: RefreshCw,
    run: () => {
      // Soft refresh — emit the same invalidation signal pages
      // already listen for, so polled lists re-fetch without a full
      // navigation round-trip.
      window.dispatchEvent(
        new CustomEvent('nexus:invalidation', {
          detail: { type: 'manual.refresh', meta: { source: 'cmd-k' } },
        }),
      )
    },
    group: 'Action',
    keywords: 'reload fetch reload poll',
  },
  {
    id: 'action-show-shortcuts',
    label: 'Show keyboard shortcuts',
    icon: Keyboard,
    run: () => {
      window.dispatchEvent(new CustomEvent('nexus:open-shortcut-help'))
    },
    group: 'Action',
    keywords: 'help kbd hotkey reference',
  },
]

/**
 * U.11 — page-scoped commands. Surfaced in an "On this page" group
 * when the current pathname matches `contextPath`. They're emitted
 * as window events so the page itself can pick them up without the
 * palette knowing the page's internals.
 *
 * Adding a new page's commands is one entry below — the page just
 * needs to listen for the matching event name.
 */
const PAGE_COMMANDS: Command[] = [
  {
    id: 'page-products-new',
    label: 'New product',
    icon: Plus,
    run: () => window.dispatchEvent(new CustomEvent('nexus:products:new')),
    group: 'On this page',
    contextPath: /^\/products(\?|$)/,
    keywords: 'create add',
  },
  {
    id: 'page-products-toggle-filters',
    label: 'Toggle filter panel',
    icon: SettingsIcon,
    run: () => window.dispatchEvent(new CustomEvent('nexus:products:toggle-filters')),
    group: 'On this page',
    contextPath: /^\/products(\?|$)/,
    keywords: 'sidebar facets',
  },
  {
    id: 'page-bulk-save',
    label: 'Save pending changes',
    icon: Plus,
    run: () => window.dispatchEvent(new CustomEvent('nexus:bulk-operations:save')),
    group: 'On this page',
    contextPath: /^\/bulk-operations(\?|$)/,
    keywords: 'commit persist',
  },
  {
    id: 'page-bulk-undo',
    label: 'Undo last edit',
    icon: History,
    run: () => window.dispatchEvent(new CustomEvent('nexus:bulk-operations:undo')),
    group: 'On this page',
    contextPath: /^\/bulk-operations(\?|$)/,
    keywords: 'revert',
  },
  // R1.3 — returns commands. Surface only when we're on the returns
  // workspace; the page listens for these events and handles them
  // locally (no router reach-around).
  {
    id: 'page-returns-new',
    label: 'New return',
    icon: Plus,
    run: () => window.dispatchEvent(new CustomEvent('nexus:returns:new')),
    group: 'On this page',
    contextPath: /^\/fulfillment\/returns(\?|$)/,
    keywords: 'create rma',
  },
  {
    id: 'page-returns-export',
    label: 'Export returns as CSV',
    icon: FileText,
    run: () => window.dispatchEvent(new CustomEvent('nexus:returns:export')),
    group: 'On this page',
    contextPath: /^\/fulfillment\/returns(\?|$)/,
    keywords: 'download csv export',
  },
  {
    id: 'page-returns-focus-search',
    label: 'Search returns…',
    icon: Search,
    run: () => window.dispatchEvent(new CustomEvent('nexus:returns:focus-search')),
    group: 'On this page',
    contextPath: /^\/fulfillment\/returns(\?|$)/,
    keywords: 'find query rma',
  },
  {
    id: 'page-returns-show-pending',
    label: 'Show pending returns (REQUESTED + IN_TRANSIT)',
    icon: ClipboardList,
    run: () => window.dispatchEvent(new CustomEvent('nexus:returns:filter-pending')),
    group: 'On this page',
    contextPath: /^\/fulfillment\/returns(\?|$)/,
    keywords: 'filter pending awaiting',
  },
]

/**
 * Chord shortcut registry — extracted from COMMANDS so the keydown
 * handler can do an O(1) lookup. e.g. { 'g p': cmd-instance }. We
 * store the whole command (not just href) because U.11 added
 * run-callback commands which can also be chord-bound.
 */
const CHORD_TO_CMD: Record<string, Command> = COMMANDS.reduce((acc, cmd) => {
  if (cmd.chord && (cmd.href || cmd.run)) acc[cmd.chord] = cmd
  return acc
}, {} as Record<string, Command>)

/**
 * Window of time (ms) we wait between the leader key (e.g. 'g') and
 * the second key. Long enough to feel forgiving, short enough that a
 * stray 'g' followed seconds later doesn't accidentally navigate.
 */
const CHORD_TIMEOUT_MS = 1500

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const router = useRouter()
  const pathname = usePathname()
  const inputRef = useRef<HTMLInputElement | null>(null)

  // U.2 — remote listing search. When the operator types 3+ chars in
  // the palette (and the palette is open), fire `/api/listings?search=`
  // with a 200ms debounce; matches show as a `Listings` group at the
  // top of results. Click → /listings?search={SKU} which loads the
  // master view filtered to that SKU. Cheap by design: pageSize=8 cap,
  // request cancelled by the next keystroke via AbortController.
  type ListingHit = {
    id: string
    channel: string
    marketplace: string
    listingStatus: string
    price: number | null
    currency: string | null
    product: { sku: string; name: string }
  }
  const [remoteListings, setRemoteListings] = useState<ListingHit[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  // O.62 — remote shipment search. Same debounce/cancel pattern as
  // listings; runs in parallel against the fulfillment search
  // endpoint. Surfaces shipments by tracking number, channel order
  // id, customer name/email, or SKU — anywhere in the app the
  // operator can hit Cmd+K and jump straight to a shipment.
  type ShipmentHit = {
    id: string
    orderId: string | null
    status: string
    carrierCode: string
    trackingNumber: string | null
    createdAt: string
    order: {
      channel: string
      marketplace: string | null
      channelOrderId: string
      customerName: string
      shipByDate: string | null
    } | null
  }
  const [remoteShipments, setRemoteShipments] = useState<ShipmentHit[]>([])
  // O.90 — remote pending-order search. O.62 covers shipments
  // (anything that's been packed or in flight); pending orders
  // (not yet shipped) were unsearchable from Cmd+K. Operators
  // looking up a brand-new Amazon order from yesterday couldn't
  // find it. Reuses the existing /outbound/pending-orders endpoint
  // which already accepts q.search across channelOrderId / customer
  // name / email / SKU.
  type PendingOrderHit = {
    id: string
    channel: string
    marketplace: string | null
    channelOrderId: string
    customerName: string
    urgency: string
    shipByDate: string | null
    totalPrice: number
    currencyCode: string | null
  }
  const [remotePending, setRemotePending] = useState<PendingOrderHit[]>([])
  useEffect(() => {
    if (!open) {
      setRemoteListings([])
      setRemoteShipments([])
      setRemotePending([])
      return
    }
    const q = query.trim()
    if (q.length < 3) {
      setRemoteListings([])
      setRemoteShipments([])
      setRemotePending([])
      return
    }
    const controller = new AbortController()
    const t = setTimeout(async () => {
      setRemoteLoading(true)
      try {
        const [listingsRes, shipmentsRes, pendingRes] = await Promise.all([
          fetch(
            `${getBackendUrl()}/api/listings?search=${encodeURIComponent(q)}&pageSize=8&sortBy=updatedAt&sortDir=desc`,
            { cache: 'no-store', signal: controller.signal },
          ).catch(() => null),
          fetch(
            `${getBackendUrl()}/api/fulfillment/shipments/search?q=${encodeURIComponent(q)}&limit=8`,
            { cache: 'no-store', signal: controller.signal },
          ).catch(() => null),
          fetch(
            `${getBackendUrl()}/api/fulfillment/outbound/pending-orders?search=${encodeURIComponent(q)}&pageSize=8`,
            { cache: 'no-store', signal: controller.signal },
          ).catch(() => null),
        ])
        if (listingsRes?.ok) {
          const data = await listingsRes.json()
          setRemoteListings(Array.isArray(data?.listings) ? data.listings : [])
        } else {
          setRemoteListings([])
        }
        if (shipmentsRes?.ok) {
          const data = await shipmentsRes.json()
          setRemoteShipments(Array.isArray(data?.items) ? data.items : [])
        } else {
          setRemoteShipments([])
        }
        if (pendingRes?.ok) {
          const data = await pendingRes.json()
          setRemotePending(Array.isArray(data?.items) ? data.items : [])
        } else {
          setRemotePending([])
        }
      } catch {
        /* AbortError + network failures: silent — palette UX shouldn't crash. */
      } finally {
        setRemoteLoading(false)
      }
    }, 200)
    return () => {
      clearTimeout(t)
      controller.abort()
    }
  }, [open, query])

  // U.11 — execute a command. Either navigates (href) or runs the
  // callback; both paths close the palette so the user lands on the
  // resulting view immediately. Centralised here so click and Enter
  // share one code path.
  const runCommand = (cmd: Command) => {
    if (cmd.href) {
      router.push(cmd.href)
    } else if (cmd.run) {
      cmd.run(router)
    }
    setOpen(false)
  }
  // Chord state — when the user presses a leader key like 'g', the
  // next key within CHORD_TIMEOUT_MS forms the chord. Tracked in a
  // ref so the handler stays stable across renders.
  const chordLeader = useRef<string | null>(null)
  const chordTimer = useRef<number | null>(null)

  // Global keyboard handler:
  //   ⌘K          — open palette (toggle)
  //   Escape      — close palette / help
  //   ?           — open shortcut help (when not typing)
  //   /           — focus active page's search input (dispatches
  //                 nexus:focus-search; pages may listen)
  //   ⌘P/⌘L/⌘O/⌘, — direct nav (legacy)
  //   g <letter>  — Linear-style chord nav (g p / g l / g o / g c …)
  // All shortcuts are skipped when focus is in an input/textarea/
  // contenteditable so they don't hijack typing.
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (target.isContentEditable) return true
      return false
    }
    const legacyDirect: Record<string, string> = {
      p: '/products',
      l: '/listings',
      o: '/orders',
      ',': '/settings/account',
    }
    const cancelChord = () => {
      chordLeader.current = null
      if (chordTimer.current) {
        window.clearTimeout(chordTimer.current)
        chordTimer.current = null
      }
    }
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()

      // ⌘K — toggle palette
      if (isMod && k === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        cancelChord()
        return
      }

      // Escape — close whichever overlay is open. Don't preventDefault
      // when nothing's open so global Esc behaviour (e.g. closing a
      // browser dialog) keeps working.
      if (e.key === 'Escape') {
        if (open) {
          setOpen(false)
          return
        }
        if (helpOpen) {
          setHelpOpen(false)
          return
        }
      }

      // ⌘P/⌘L/⌘O/⌘, — legacy modifier nav. Cmd+P would normally print;
      // we eat it here for power-user nav. Skip when typing.
      if (isMod && !open && !isTypingTarget(e.target)) {
        const dest = legacyDirect[k] ?? legacyDirect[e.key]
        if (dest) {
          e.preventDefault()
          router.push(dest)
          cancelChord()
          return
        }
      }

      // From this point on, we only handle modifier-less keypresses
      // and skip when typing or when the palette is open (the palette
      // owns its own arrow/Enter handlers).
      if (isMod || open || helpOpen || isTypingTarget(e.target)) return

      // ? — open the shortcut help overlay. e.key is '?' on most
      // layouts when shift+/ is pressed.
      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
        cancelChord()
        return
      }

      // / — focus the active page's primary search input. Pages can
      // listen for this event and call inputRef.current?.focus().
      if (e.key === '/') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('nexus:focus-search'))
        cancelChord()
        return
      }

      // Chord state machine.
      if (chordLeader.current) {
        // We're mid-chord; this key is the second half.
        const chord = `${chordLeader.current} ${k}`
        cancelChord()
        const cmd = CHORD_TO_CMD[chord]
        if (cmd) {
          e.preventDefault()
          if (cmd.href) router.push(cmd.href)
          else cmd.run?.(router)
        }
        return
      }
      // Leader keys we recognise. 'g' is the only one today; adding
      // 'a' / 'c' / 'd' style leaders later is one entry away.
      if (k === 'g') {
        e.preventDefault()
        chordLeader.current = 'g'
        chordTimer.current = window.setTimeout(cancelChord, CHORD_TIMEOUT_MS)
        return
      }
    }
    const onOpenEvent = () => setOpen(true)
    // U.11 — the "Show keyboard shortcuts" action dispatches this
    // event so the help overlay opens regardless of whether the
    // palette is currently visible. Listening here keeps the help
    // overlay's state owned by CommandPalette.
    const onOpenHelp = () => {
      setOpen(false)
      setHelpOpen(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('nexus:open-command-palette', onOpenEvent)
    window.addEventListener('nexus:open-shortcut-help', onOpenHelp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('nexus:open-command-palette', onOpenEvent)
      window.removeEventListener('nexus:open-shortcut-help', onOpenHelp)
      cancelChord()
    }
  }, [open, helpOpen, router])

  // Reset query + focus input each time we open
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // U.11 — page-context commands: only the ones whose contextPath
  // matches the current pathname show up. Memoised so we don't filter
  // on every render.
  const activePageCommands = useMemo(() => {
    if (!pathname) return [] as Command[]
    return PAGE_COMMANDS.filter((cmd) => {
      if (!cmd.contextPath) return false
      if (typeof cmd.contextPath === 'string') return pathname === cmd.contextPath
      return cmd.contextPath.test(pathname)
    })
  }, [pathname])

  // U.11 — palette pool. Page-context commands precede the global
  // ones so "On this page" sits at the top when present, matching
  // the ordering most users expect (current scope first).
  // U.2 — wrap each remote listing match in a Command shape so the
  // existing render path (active-row, Enter-to-run, click-to-run)
  // works without special-casing. Status hint (DRAFT/ACTIVE/etc.) +
  // channel/marketplace string fold into the label so a screen-reader
  // pass and a sighted scan both surface the same context.
  const remoteListingCommands = useMemo<Command[]>(
    () =>
      remoteListings.map((l) => {
        const priceLabel =
          l.price != null
            ? ` · ${l.currency ?? ''}${l.price.toFixed(2)}`.trim().replace(/^· $/, '')
            : ''
        return {
          id: `listing-${l.id}`,
          label: `${l.product.sku} — ${l.product.name}`,
          icon: Boxes,
          group: 'Listings' as const,
          keywords: `${l.channel} ${l.marketplace} ${l.listingStatus}${priceLabel}`,
          // Search lands the operator on the master view filtered to
          // that exact SKU. /listings's grid shows it as the only row;
          // if multiple channels carry the SKU each appears so the
          // operator can pick the right marketplace.
          href: `/listings?search=${encodeURIComponent(l.product.sku)}`,
        } as Command
      }),
    [remoteListings],
  )

  // O.62 — wrap remote shipment matches in Command shape. Each hit
  // deep-links to /fulfillment/outbound?drawer={orderId} (drawer-on-
  // load pattern the workspace already supports) when an order is
  // attached, falling back to the shipments list filtered by tracking
  // when the shipment is order-less (rare — manual shipments).
  const remoteShipmentCommands = useMemo<Command[]>(
    () =>
      remoteShipments.map((s) => {
        const tracking = s.trackingNumber ? ` · ${s.trackingNumber}` : ''
        const customer = s.order?.customerName ? ` · ${s.order.customerName}` : ''
        const channelOrder = s.order?.channelOrderId ?? s.id.slice(0, 6)
        const channelTag = s.order
          ? ` · ${s.order.channel}${s.order.marketplace ? `:${s.order.marketplace}` : ''}`
          : ''
        // Order-attached shipments → drawer-on-load. Order-less
        // manual shipments fall back to the shipments tab pre-
        // filtered to the tracking number (O.63 wires the param).
        const href = s.orderId
          ? `/fulfillment/outbound?drawer=${s.orderId}`
          : `/fulfillment/outbound?tab=shipments&search=${encodeURIComponent(
              s.trackingNumber ?? '',
            )}`
        return {
          id: `shipment-${s.id}`,
          label: `${channelOrder}${customer}${tracking}`,
          icon: Truck,
          group: 'Shipments' as const,
          keywords: `${s.status} ${s.carrierCode}${channelTag}`,
          href,
        } as Command
      }),
    [remoteShipments],
  )

  // O.90 — wrap remote pending-order matches in Command shape. Each
  // hit deep-links to /fulfillment/outbound?drawer={orderId} (same
  // pattern as O.62's order-attached shipment hits) so the operator
  // lands directly on the drawer for that order.
  const remotePendingCommands = useMemo<Command[]>(
    () =>
      remotePending.map((o) => {
        const channelTag = `${o.channel}${o.marketplace ? `:${o.marketplace}` : ''}`
        const urgencyHint = o.urgency === 'OVERDUE' ? ' · OVERDUE' : o.urgency === 'TODAY' ? ' · ships today' : ''
        return {
          id: `pending-${o.id}`,
          label: `${o.channelOrderId} · ${o.customerName}`,
          icon: Package,
          group: 'Pending orders' as const,
          keywords: `${channelTag}${urgencyHint}`,
          href: `/fulfillment/outbound?drawer=${o.id}`,
        } as Command
      }),
    [remotePending],
  )

  const pool = useMemo(
    () => [...activePageCommands, ...remotePendingCommands, ...remoteShipmentCommands, ...remoteListingCommands, ...COMMANDS],
    [activePageCommands, remotePendingCommands, remoteShipmentCommands, remoteListingCommands],
  )

  // U.11 — fuzzy-ish match: query has to appear in label OR keywords
  // (not full Levenshtein, but enough that "reload" → "Refresh page"
  // when the keyword is set). Matching is space-insensitive on the
  // query side so "create product" still hits "Create new product".
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pool
    return pool.filter((c) => {
      const haystack = `${c.label} ${c.keywords ?? ''}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [pool, query])

  // Group filtered list, preserving the canonical group order.
  // U.2 — Listings sits high so a SKU lookup query lands at the top
  // of results when remote matches are available.
  const GROUP_ORDER: Command['group'][] = [
    'On this page',
    // O.90: Pending orders sit above Shipments because a freshly-
    // received order that hasn't been packed yet is the operator's
    // most likely "where is X" lookup.
    'Pending orders',
    'Shipments',
    'Listings',
    'Recent',
    'Action',
    'Catalog',
    'Navigation',
    'System',
  ]
  const grouped: Record<string, Command[]> = {}
  for (const cmd of filtered) {
    ;(grouped[cmd.group] ??= []).push(cmd)
  }

  // Flat list (matches keyboard navigation order). Built in group
  // order so ↓/↑ moves through what the user sees, not insertion
  // order.
  const flat: Command[] = []
  for (const g of GROUP_ORDER) {
    if (grouped[g]) flat.push(...grouped[g])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = flat[activeIdx]
      if (cmd) runCommand(cmd)
    }
  }

  // Help can be opened independently of the palette (via `?`), so we
  // can't return null until BOTH overlays are closed.
  if (!open && !helpOpen) return null

  if (!open && helpOpen) {
    return <ShortcutHelp onClose={() => setHelpOpen(false)} />
  }

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-[1px] z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-[600px] max-w-[90vw] overflow-hidden border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIdx(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent text-lg text-slate-900 placeholder:text-slate-400 outline-none"
          />
          <kbd className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 font-mono">
            ESC
          </kbd>
        </div>

        <div className="max-h-[400px] overflow-y-auto p-2">
          {flat.length === 0 ? (
            <div className="text-center text-md text-slate-500 py-8">
              {remoteLoading ? 'Searching listings…' : 'No commands found'}
            </div>
          ) : (
            GROUP_ORDER.filter((g) => grouped[g]).map((group) => (
              <div key={group} className="mb-1 last:mb-0">
                <div className="px-3 pt-2 pb-1 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  {group}
                </div>
                {grouped[group]!.map((cmd) => {
                  const flatIdx = flat.indexOf(cmd)
                  const isActive = flatIdx === activeIdx
                  const Icon = cmd.icon
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      onMouseEnter={() => setActiveIdx(flatIdx)}
                      onClick={() => runCommand(cmd)}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-2 rounded-md text-md text-left transition-colors',
                        isActive
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-slate-700 hover:bg-slate-50'
                      )}
                    >
                      <Icon
                        className={cn(
                          'w-4 h-4 flex-shrink-0',
                          isActive ? 'text-blue-600' : 'text-slate-400'
                        )}
                      />
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.chord && (
                        <kbd
                          className={cn(
                            'text-xs font-mono px-1.5 py-0.5 rounded',
                            isActive
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-slate-100 text-slate-500',
                          )}
                        >
                          {cmd.chord}
                        </kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-400 flex items-center justify-between gap-2">
          <span>↑↓ navigate · ↵ open</span>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setHelpOpen(true)
            }}
            className="hover:text-slate-700 inline-flex items-center gap-1"
          >
            <Keyboard className="w-3 h-3" />
            Shortcuts
          </button>
        </div>
      </div>
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

/**
 * Shortcut help overlay. Surfaced via `?` (anywhere) or the
 * "Shortcuts" link in the command palette footer. Keeps the chord
 * registry as the source of truth so a new entry shows up here
 * automatically.
 */
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  // Esc closes when the palette isn't also open. The palette's
  // global handler covers the case when both are open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const navChords = COMMANDS.filter((c) => c.chord)
  const generalShortcuts: Array<{ keys: string; label: string }> = [
    { keys: '⌘ K', label: 'Open command palette' },
    { keys: '?', label: 'Show this help' },
    { keys: '/', label: 'Focus the page search' },
    { keys: 'Esc', label: 'Close any overlay' },
  ]
  // P.15 — page-specific shortcuts surfaced here so operators
  // discover them through `?` instead of by trial. Per-page entries
  // are scoped by pathname; pages that don't match render nothing.
  // Adding a new page's shortcuts is one entry below — no event-bus
  // contract needed because the help overlay is global anyway.
  const pageShortcuts = (() => {
    const path = typeof window !== 'undefined' ? window.location.pathname : ''
    if (path === '/products' || path.startsWith('/products?')) {
      return {
        title: '/products',
        items: [
          { keys: 'n', label: 'New product (open the create wizard)' },
          { keys: 'f', label: 'Toggle the filter panel' },
          { keys: 'r', label: 'Refresh the grid' },
        ],
      }
    }
    return null
  })()

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-[1px] z-[60] flex items-start justify-center pt-[12vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-[560px] max-w-[90vw] overflow-hidden border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-slate-500" />
            <h2 className="text-lg font-semibold text-slate-900">
              Keyboard shortcuts
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-0.5"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          <section>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              General
            </div>
            <ul className="space-y-1.5">
              {generalShortcuts.map((s) => (
                <li
                  key={s.keys}
                  className="flex items-center justify-between text-md text-slate-700"
                >
                  <span>{s.label}</span>
                  <kbd className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-500">
                    {s.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </section>

          {pageShortcuts && (
            <section>
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                On {pageShortcuts.title}
              </div>
              <ul className="space-y-1.5">
                {pageShortcuts.items.map((s) => (
                  <li
                    key={s.keys}
                    className="flex items-center justify-between text-md text-slate-700"
                  >
                    <span>{s.label}</span>
                    <kbd className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-500">
                      {s.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Navigation (chord — press {'g'} then …)
            </div>
            <ul className="space-y-1.5">
              {navChords.map((cmd) => (
                <li
                  key={cmd.id}
                  className="flex items-center justify-between text-md text-slate-700"
                >
                  <span>{cmd.label}</span>
                  <kbd className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-500">
                    {cmd.chord}
                  </kbd>
                </li>
              ))}
            </ul>
          </section>

          <p className="text-sm text-slate-500 leading-relaxed">
            Shortcuts are skipped while you&rsquo;re typing in a field. The
            command palette also accepts ⌘ P / ⌘ L / ⌘ O / ⌘ , as direct
            navigation (legacy).
          </p>
        </div>
      </div>
    </div>
  )
}
