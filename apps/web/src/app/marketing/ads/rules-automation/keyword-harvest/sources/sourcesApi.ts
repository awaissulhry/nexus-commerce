/**
 * Keyword Harvest page, Sources view (2026-10-11, lane HRULES) — the one read beyond the shared harvest client: which
 * harvest rules exist and how each reaches its sources (GET /api/advertising/automation-rules — the stored rules; a
 * builder rule reads the ad groups its mapping names, an engine rule its scope). The writes are the shared client's.
 */
import { getBackendUrl } from '@/lib/backend-url'
import { refusalWords } from '../../bid/rules/ruleChanges'
import { ruleReachOf, type PickRule } from './sourcesModel'

interface StoredRuleRow { id: string; name: string; actions?: unknown; scopeMarketplace?: string | null }

/** Every harvest rule with its reach, by name; `offered` when it works in this market (or every market). */
export async function readPickRules(market: string): Promise<PickRule[]> {
  const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' })
  const j = await r.json().catch(() => null) as { items?: StoredRuleRow[] } | null
  if (!r.ok) throw new Error(refusalWords(r.status, j))
  const m = market.toUpperCase()
  return (j?.items ?? [])
    .map((x) => ({ x, reach: ruleReachOf(x.actions) }))
    .filter(({ reach }) => reach != null)
    .map(({ x, reach }) => ({ id: x.id, name: x.name, reach, offered: !x.scopeMarketplace || market === 'all' || x.scopeMarketplace.toUpperCase() === m }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
