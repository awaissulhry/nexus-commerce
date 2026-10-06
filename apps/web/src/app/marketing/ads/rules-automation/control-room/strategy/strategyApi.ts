/**
 * ADS AUTONOMY W1-4 — the Strategy tab's calls, typed as the API answers them (apps/api routes/advertising-strategy.routes.ts,
 * services/advertising/ads-strategy/read.ts and write.ts). The API decides everything: what is in force and where it comes
 * from, raise or lower, who may save. This file only fetches it.
 *
 *   GET  /api/advertising/automation/strategy?market=            every strategy row of the market, the campaigns whose own
 *                                                                 target ACoS wins (rows view)
 *   GET  /api/advertising/automation/strategy/effective?market=&categoryId|productId=
 *                                                                 every field in force at one scope, its source, its readers,
 *                                                                 what Claude may do alone (effective view)
 *   GET  /api/advertising/automation/strategy/history?market=&categoryId|productId=   the recorded versions
 *   POST /api/advertising/automation/strategy/preview             one change planned: from → to, raise or lower, nothing saved
 *   PUT  /api/advertising/automation/strategy                     save it (expectVersion; a raise with `code`); answers `undo`
 *
 * Money keys are absent (not null) when this person may not see ad-spend money: `'maxBidCents' in row` tells the two apart.
 */
import { getBackendUrl } from '@/lib/backend-url'
import type { ClaudeActionKey, FieldKey, Level } from './strategyWords'

export type Direction = 'raise' | 'lower' | 'same'
export type ClaudeLevel = 'off' | 'ask' | 'confirm' | 'auto'

/** One stored row (rows view): every setting column, null = not set here; a money key is absent when hidden. */
export interface StrategyRowOut {
  strategyId: string
  level: Level
  scopeId: string
  label: string
  version: number
  updatedAt: string | null
  updatedBy: string
  goal: string | null
  goalNote: string | null
  targetKind: string | null
  targetPct?: number | null
  monthlySpendCapCents?: number | null
  minBidCents?: number | null
  maxBidCents?: number | null
  maxChangePct: number | null
  maxActionsPerRun: number | null
  protect: boolean | null
  harvestMinOrders: number | null
  harvestMinClicks: number | null
  harvestMaxAcosPct?: number | null
  harvestWindowDays: number | null
  negateMinClicks: number | null
  negateMinSpendCents?: number | null
  negateMaxOrders: number | null
  negateWindowDays: number | null
  stopMethod: string | null
  stopBidCents?: number | null
  claudeAutonomy: Partial<Record<ClaudeActionKey, ClaudeLevel>> | null
  reviewEveryDays: number | null
  /** Why the row's category or product is gone (it binds nothing). */
  orphan?: string
}

export interface ShadowCampaign { campaignId: string; name: string; targetAcosPct?: number }

export interface RowsMarket {
  market: string
  note?: string
  rows: StrategyRowOut[]
  ignored: string[]
  shadowedBy: ShadowCampaign[]
  shadowedCount: number
  warnings?: string[]
}

/** Which row a number in force came from. */
export interface StrategySourceOut {
  level: 'market' | 'category' | 'product'
  scopeId: string
  label: string
  version: number
  strategyId: string
  via?: 'parent'
  product?: string
}

/** One field in force at a scope (effective view); its value sits under its own column keys. */
export interface FieldEntry {
  field: FieldKey | 'targetAcosPct'
  label: string
  source?: StrategySourceOut | null
  readBy: string[]
  alsoInForce?: Array<Record<string, unknown> & { setting: string }>
  stricter?: { from: string }
  /** The monthly cap: each scope's own cap (none is inherited). */
  caps?: Array<StrategySourceOut & { monthlySpendCapCents?: number }>
  /** targetAcosPct: what Nexus's bid optimiser aims at today. */
  today?: { from: string; targetAcosPct?: number }
  [column: string]: unknown
}

export interface ClaudeEntry {
  action: ClaudeActionKey
  tools: Array<{ tool: string; business: ClaudeLevel; effective: ClaudeLevel }>
  strategy: ClaudeLevel | null
  source: StrategySourceOut | null
}

export interface EffectiveMarket {
  market: string
  scope: { kind: 'market' | 'category' | 'product'; name?: string; products?: Array<{ productId: string; sku: string; parentSku?: string | null; category: string | null }> }
  strategyRows: number
  note?: string
  fields: FieldEntry[]
  claude: ClaudeEntry[]
  shadowedBy: ShadowCampaign[]
  shadowedCount: number
  warnings: string[]
}

export interface Effective { markets: EffectiveMarket[]; notReadYet: string[] }

export interface HistoryVersion {
  strategyId: string
  level: Level
  scopeId: string
  version: number
  op: string
  direction: Direction
  via: string
  actor: string
  stepUpAt: string | null
  reason: string | null
  at: string | null
  changes: Array<Record<string, unknown> & { field: string | null; direction: Direction | null }>
}

/** One recorded change in a preview or a save: a registry field (values under its column names), or a campaign's own target. */
export interface StrategyChange {
  field: string
  label: string
  from: unknown
  to: unknown
  effectiveFrom?: unknown
  effectiveTo?: unknown
  direction: Direction
  term?: string
  campaignId?: string
  campaign?: string
}

export interface StrategyPreview {
  summary: string
  scope: { market: string; level: Level; scopeId: string; label: string }
  op: 'set' | 'remove'
  version: { from: number; to: number | null }
  changes: StrategyChange[]
  direction: Direction
  raises: string[]
  stepUp: { raises: string[] } | null
  reachNote: string
  readBy: Record<string, readonly string[]>
  notReadYet: string[]
  shadowedBy: ShadowCampaign[]
  shadowedCount: number
  affects: { campaigns: number; products?: number }
  warnings?: string[]
  /** May THIS person save a raise (settings.security.manage)? */
  mayRaise: boolean
}

export interface SavedStrategy {
  ok: true
  version: number
  direction: Direction
  changes: StrategyChange[]
  /** The change that puts the previous version back (PUT it to undo). */
  undo: StrategyChangeBody
}

/** The body of a preview or a save (apps/api ads-strategy/write.ts STRATEGY_CHANGE_INPUT). */
export interface StrategyChangeBody {
  channel: 'AMAZON'
  market: string
  level: 'market' | 'category' | 'product'
  categoryId?: string
  productId?: string
  op?: 'set' | 'remove'
  values?: Record<string, unknown>
  clearCampaignTargets?: boolean
  restoreCampaignTargets?: Array<{ campaignId: string; targetAcosPct: number | null }>
  expectVersion?: number
  reason?: string
}

/** A refusal: the API's sentence, its code (`version_moved`, `mfa_required`, `mfa_invalid`, …) and HTTP status. */
export class StrategyError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly raises: string[] = []) {
    super(message)
  }
}

const BASE = '/api/advertising/automation/strategy'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getBackendUrl()}${BASE}${path}`, { cache: 'no-store', ...init })
  const body = (await response.json().catch(() => null)) as (T & { error?: string; code?: string; raises?: string[] }) | null
  if (!response.ok || !body) {
    throw new StrategyError(body?.error ?? `Nexus answered ${response.status}.`, response.status, body?.code ?? null, body?.raises ?? [])
  }
  return body
}

const query = (market: string, scope?: { categoryId?: string; productId?: string }, extra: Record<string, string> = {}) =>
  `?${new URLSearchParams({ market, ...(scope?.categoryId ? { categoryId: scope.categoryId } : {}), ...(scope?.productId ? { productId: scope.productId } : {}), ...extra })}`

const write = (body: StrategyChangeBody & { code?: string }) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const strategyApi = {
  rows: async (market: string) => (await call<{ markets: RowsMarket[] }>(query(market))).markets[0] ?? null,
  effective: (market: string, scope?: { categoryId?: string; productId?: string }) => call<Effective>(`/effective${query(market, scope)}`),
  history: async (market: string, scope?: { categoryId?: string; productId?: string }) =>
    (await call<{ markets: Array<{ versions: HistoryVersion[] }> }>(`/history${query(market, scope, { limit: '20' })}`)).markets[0]?.versions ?? [],
  preview: (body: StrategyChangeBody) => call<StrategyPreview>('/preview', { method: 'POST', ...write(body) }),
  save: (body: StrategyChangeBody, code?: string) => call<SavedStrategy>('', { method: 'PUT', ...write(code ? { ...body, code } : body) }),
}

/** A category of the business's own tree, as GET /api/pim/categories/tree answers. */
export interface CategoryNode { id: string; name: unknown; slug: string; isActive: boolean; children: CategoryNode[] }

/** The business's categories and a product search, for "Add a category / a product". */
export const catalogApi = {
  categories: async (): Promise<CategoryNode[]> => {
    const response = await fetch(`${getBackendUrl()}/api/pim/categories/tree`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Nexus answered ${response.status}.`)
    return ((await response.json()) as { tree?: CategoryNode[] }).tree ?? []
  },
  products: async (search: string, signal?: AbortSignal): Promise<Array<{ id: string; sku: string; name: string | null }>> => {
    const response = await fetch(`${getBackendUrl()}/api/products/search?${new URLSearchParams({ search, limit: '20' })}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error(`Nexus answered ${response.status}.`)
    const items = ((await response.json()) as { items?: Array<{ id: string; sku: string; name?: string | null }> }).items ?? []
    return items.map((p) => ({ id: p.id, sku: p.sku, name: p.name ?? null }))
  },
}
