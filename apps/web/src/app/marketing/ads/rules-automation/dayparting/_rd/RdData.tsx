'use client'

/**
 * RD.P0 — the page's one data layer.
 *
 * Every section of Rank & Dayparting reads from here, so P1–P7 do not each invent a fetch. Before
 * this existed the page made five requests on load and `/rank-schedule-groups` was among them
 * TWICE — once in the route client for the schedule pickers, once inside the grid.
 *
 * Four requests now, and they buy more than the five did:
 *
 *   /rank-schedule-groups            the schedules, with the runtime the list already renders
 *   /rank-targets                    the goal library — names and swatches (READ-ONLY here; the
 *                                    library is edited in the builder, which is off limits)
 *   /scope-options                   campaigns · portfolios · product lines — the four scope grains,
 *                                    and the read Automations, Keyword Tracker and Negative
 *                                    Targeting already use, so this page cannot offer a line or
 *                                    portfolio the server would resolve differently
 *   /rank-schedule-groups/memberships  campaign → schedule, which is the campaign-grain join
 *
 * `/advertising/portfolios` and `/advertising/campaigns?limit=500` are both GONE — `scope-options`
 * already returns portfolios and every campaign with its marketplace, so those two were a second
 * answer to a question that already had one.
 *
 * **Real-time is a seam, not a subscription.** The engine moves these rows every 15 minutes and the
 * ads SSE bus carries 0.21% of writes, so the correct shape is polling a cursor — `refresh()` is
 * where that lands. P0 wires no timer: nothing on the page is stale enough yet to justify one, and
 * an unattended poll is a behaviour change.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import type { RdCampaignRow, RdCampaignRuntime, RdGroupRow, RdGroupRuntime, RdTargetMeta } from './types'
import { EMPTY_RUNTIME } from './types'

/** Built-in keys + the builder's palette, so a row renders before /rank-targets lands. */
const FALLBACK_TARGETS: Record<string, RdTargetMeta> = {
  'own-top': { key: 'own-top', name: 'Own Top of Search', color: '#0a7d48' },
  'defend-top': { key: 'defend-top', name: 'Defend Top', color: '#3aa873' },
  'rest-of-search': { key: 'rest-of-search', name: 'Rest of Search', color: '#e6b067' },
  pause: { key: 'pause', name: 'Min bid', color: '#d97757' },
  'own-top-allout': { key: 'own-top-allout', name: 'Own Top — All-Out', color: '#b91c1c' },
}

export interface RdData {
  groups: RdGroupRow[]
  /** One row per campaign under rank control. Identity resolves today; `runtime` is P2's. */
  campaigns: RdCampaignRow[]
  targets: Record<string, RdTargetMeta>
  /** External portfolio id → name. */
  portfolioNames: Record<string, string>
  /** Product line id → a label the pickers can show. */
  productLines: Array<{ id: string; label: string }>
  /** Every marketplace the ACCOUNT advertises in — what the header's switch offers. */
  markets: string[]
  /** RD.P2 — the group grain's roll-up, keyed by group id. A SPREAD, never an average. */
  groupRuntime: Map<string, RdGroupRuntime>
  /** The clock the runtime was resolved against, and its skew from this process. */
  clock: { source: string; skewMinutes: number } | null
  loading: boolean
  /**
   * Set when a request failed. Sections must distinguish this from an empty account: rendering
   * "no rank schedules yet" over a failed fetch is the false-empty this field exists to prevent.
   * P0 stores it; P2 renders it.
   */
  error: string | null
  /** Re-read everything. The seam a cursor poll lands on. */
  refresh: () => void
}

const RdDataContext = createContext<RdData | null>(null)

type Json = Record<string, unknown>
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : [])

async function getJson(path: string): Promise<Json> {
  const r = await fetch(`${getBackendUrl()}${path}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return (await r.json()) as Json
}

export function RdDataProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = useState<{ groups: Json; targets: Json; scope: Json; members: Json; runtime: Json } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [groups, targets, scope, members, runtime] = await Promise.all([
          getJson('/api/advertising/rank-schedule-groups'),
          getJson('/api/advertising/rank-targets'),
          getJson('/api/advertising/scope-options'),
          getJson('/api/advertising/rank-schedule-groups/memberships'),
          // RD.P2 — the campaign grain. Both grains come from ONE derivation server-side, so the
          // group roll-up below can never disagree with the members it summarises.
          getJson('/api/advertising/rank-runtime'),
        ])
        if (!alive) return
        setRaw({ groups, targets, scope, members, runtime })
        setError(null)
      } catch (e) {
        // Kept, not swallowed. The old grid caught this and set rows to [], which rendered
        // "No rank schedules yet" over a network failure — a false empty on a page whose whole
        // job is telling the operator what is running.
        if (alive) setError(e instanceof Error ? e.message : 'Could not load rank schedules')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [nonce])

  const value = useMemo<RdData>(() => {
    const targets: Record<string, RdTargetMeta> = { ...FALLBACK_TARGETS }
    for (const t of arr(raw?.targets?.['items'] ?? raw?.targets)) {
      const key = String(t.key ?? '')
      if (key) targets[key] = { key, name: String(t.name ?? key), color: (t.color as string | null) ?? null }
    }

    // ── scope-options: campaigns · portfolios · product lines ────────────────────────────────
    const scopeCampaigns = arr(raw?.scope?.['campaigns'])
    const campaignById = new Map<string, { name: string; marketplace: string | null; portfolioId: string | null; status: string | null }>()
    for (const c of scopeCampaigns) {
      const id = String(c.id ?? '')
      if (!id) continue
      campaignById.set(id, {
        name: String(c.name ?? id),
        marketplace: (c.marketplace as string | null) ?? null,
        portfolioId: c.portfolioId ? String(c.portfolioId) : null,
        status: (c.status as string | null) ?? null,
      })
    }

    const portfolioNames: Record<string, string> = {}
    for (const p of arr(raw?.scope?.['portfolios'])) {
      const id = String(p.externalPortfolioId ?? p.portfolioId ?? p.id ?? '')
      if (id) portfolioNames[id] = String(p.name ?? id)
    }

    const productLines: Array<{ id: string; label: string }> = []
    const linesByCampaign = new Map<string, string[]>()
    for (const l of arr(raw?.scope?.['productLines'])) {
      const id = String(l.id ?? '')
      if (!id) continue
      const variations = Number(l.variations ?? 0)
      productLines.push({ id, label: `${String(l.sku ?? id)} · ${variations} variation${variations === 1 ? '' : 's'}` })
      for (const cid of Array.isArray(l.campaigns) ? (l.campaigns as unknown[]) : []) {
        const key = String(cid)
        const list = linesByCampaign.get(key) ?? []
        list.push(id)
        linesByCampaign.set(key, list)
      }
    }

    // ── memberships: campaign → schedule, inverted to schedule → campaigns ───────────────────
    const memberOf = new Map<string, { groupId: string; groupName: string }>()
    const membersRaw = (raw?.members?.['items'] ?? {}) as Record<string, { groupId?: string; groupName?: string }>
    for (const [campaignId, m] of Object.entries(membersRaw)) {
      if (m?.groupId) memberOf.set(campaignId, { groupId: String(m.groupId), groupName: String(m.groupName ?? m.groupId) })
    }
    const campaignsByGroup = new Map<string, string[]>()
    for (const [campaignId, m] of memberOf) {
      const list = campaignsByGroup.get(m.groupId) ?? []
      list.push(campaignId)
      campaignsByGroup.set(m.groupId, list)
    }

    // ── groups ───────────────────────────────────────────────────────────────────────────────
    const groups: RdGroupRow[] = arr(raw?.groups?.['items'] ?? raw?.groups).map((g) => {
      const id = String(g.id ?? '')
      const memberIds = campaignsByGroup.get(id) ?? []
      const ownPortfolio = g.portfolioId ? String(g.portfolioId) : null
      const windowsRaw = arr(g.windows)
      const perf = (g.performance ?? {}) as Json
      // The market set comes from the SERVER's derived array rather than from the membership
      // join: the endpoint already derives it, and if /memberships were the only source a failure
      // there would silently empty the market filter instead of degrading the finer grains alone.
      const marketplaces = (Array.isArray(g.marketplaces) ? (g.marketplaces as string[]) : []).filter(Boolean)
      const portfolioIds = [...new Set([
        ...(ownPortfolio ? [ownPortfolio] : []),
        ...memberIds.map((c) => campaignById.get(c)?.portfolioId).filter((x): x is string => !!x),
      ])]
      const productLineIds = [...new Set(memberIds.flatMap((c) => linesByCampaign.get(c) ?? []))]
      return {
        id,
        name: String(g.name ?? 'Rank schedule'),
        enabled: g.enabled !== false,
        timezone: String(g.timezone ?? 'Europe/Rome'),
        defaultTargetKey: String(g.defaultTargetKey ?? ''),
        activeTargetKey: String(g.activeTargetKey ?? ''),
        windowsRaw,
        windowCount: windowsRaw.filter((w) => !!(w as { targetKey?: string })?.targetKey).length,
        portfolioId: ownPortfolio,
        portfolioName: ownPortfolio ? (portfolioNames[ownPortfolio] ?? ownPortfolio) : null,
        scope: { marketplaces, portfolioIds, productLineIds, campaignIds: memberIds },
        campaignCount: Number(g.campaignCount ?? 0),
        membersTotal: Number(g.membersTotal ?? g.campaignCount ?? 0),
        membersEnabled: Number(g.membersEnabled ?? 0),
        lastEvaluatedAt: g.lastEvaluatedAt ? String(g.lastEvaluatedAt) : null,
        lastApplied: g.lastApplied ? String(g.lastApplied) : null,
        failedWrites: Number(g.failedWrites ?? 0),
        governedElsewhere: Number(g.governedElsewhere ?? 0),
        performance: {
          costCents: Number(perf.costCents ?? 0),
          salesCents: Number(perf.salesCents ?? 0),
          orders: Number(perf.orders ?? 0),
          clicks: Number(perf.clicks ?? 0),
          impressions: Number(perf.impressions ?? 0),
          acos: (perf.acos as number | null) ?? null,
          windowDays: Number(perf.windowDays ?? 30),
        },
      }
    })

    // ── campaign grain — the seam ─────────────────────────────────────────────────────────────
    //
    // Identity only, and it is complete: measured 2026-08-12, all 45 campaigns under rank control
    // resolve a name, market, portfolio, line and schedule. `runtime` stays empty until P2's
    // endpoint exists, because mode, band, live placement, goal-vs-actual, signal age and ceiling
    // state cannot be derived client-side from anything this page can already read.
    // RD.P2 — runtime by campaign, and the group roll-up, both from /rank-runtime.
    const runtimeByCampaign = new Map<string, RdCampaignRuntime & { lastEvaluatedAt: string | null; lastApplied: string | null; scheduleEnabled: boolean | null }>()
    for (const r of arr(raw?.runtime?.['campaigns'])) {
      const cid = String(r.campaignId ?? '')
      if (!cid) continue
      runtimeByCampaign.set(cid, {
        mode: (r.mode ?? null) as RdCampaignRuntime['mode'],
        placement: (r.livePlacement ?? null) as RdCampaignRuntime['placement'],
        goal: (r.goal ?? null) as RdCampaignRuntime['goal'],
        signal: (r.signal ?? null) as RdCampaignRuntime['signal'],
        ceiling: (r.ceiling ?? null) as RdCampaignRuntime['ceiling'],
        activeTargetKey: r.activeTargetKey ? String(r.activeTargetKey) : null,
        band: (r.band ?? null) as RdCampaignRuntime['band'],
        canChase: !!r.canChase,
        canConverge: r.canConverge !== false,
        cannotConvergeReason: r.cannotConvergeReason ? String(r.cannotConvergeReason) : null,
        eventName: r.eventName ? String(r.eventName) : null,
        lastEvaluatedAt: r.lastEvaluatedAt ? String(r.lastEvaluatedAt) : null,
        lastApplied: r.lastApplied ? String(r.lastApplied) : null,
        scheduleEnabled: typeof r.scheduleEnabled === 'boolean' ? r.scheduleEnabled : null,
      })
    }
    const groupRuntime = new Map<string, RdGroupRuntime>()
    for (const g of arr(raw?.runtime?.['groups'])) {
      const gid = String(g.groupId ?? '')
      if (gid) groupRuntime.set(gid, g as unknown as RdGroupRuntime)
    }
    const clock = (raw?.runtime?.['clock'] ?? null) as RdData['clock']

    const groupById = new Map(groups.map((g) => [g.id, g]))
    const campaigns: RdCampaignRow[] = [...memberOf.entries()].map(([campaignId, m]) => {
      const c = campaignById.get(campaignId)
      const g = groupById.get(m.groupId)
      const portfolioId = c?.portfolioId ?? null
      const rt = runtimeByCampaign.get(campaignId)
      return {
        campaignId,
        campaignName: c?.name ?? campaignId,
        marketplace: c?.marketplace ?? null,
        portfolioId,
        portfolioName: portfolioId ? (portfolioNames[portfolioId] ?? portfolioId) : null,
        productLineIds: linesByCampaign.get(campaignId) ?? [],
        status: c?.status ?? null,
        groupId: m.groupId,
        groupName: g?.name ?? m.groupName,
        // P0 left this null because no endpoint carried it. /rank-runtime does.
        scheduleEnabled: rt?.scheduleEnabled ?? null,
        lastEvaluatedAt: rt?.lastEvaluatedAt ?? null,
        lastApplied: rt?.lastApplied ?? null,
        runtime: rt ?? { ...EMPTY_RUNTIME },
      }
    }).sort((a, b) => a.campaignName.localeCompare(b.campaignName))

    const markets = [...new Set(
      scopeCampaigns.map((c) => (c.marketplace ? String(c.marketplace) : '')).filter(Boolean),
    )].sort()

    return { groups, campaigns, targets, portfolioNames, productLines, markets, groupRuntime, clock, loading, error, refresh }
  }, [raw, loading, error, refresh])

  return <RdDataContext.Provider value={value}>{children}</RdDataContext.Provider>
}

/** Every section reads the page's data through this. Throws outside the provider on purpose. */
export function useRdData(): RdData {
  const ctx = useContext(RdDataContext)
  if (!ctx) throw new Error('useRdData must be used inside <RdDataProvider>')
  return ctx
}
