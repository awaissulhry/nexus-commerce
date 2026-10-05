/**
 * Phase 1 N1 — a market code this business does not have is refused at Claude's door, with the codes it does have.
 *
 * Tools take a market as a free string (IT, DE, UK, GLOBAL …), and only some check it later, in their own words. When
 * Claude names a channel and a market for a change (or publish-review), the pair is checked against this business's
 * own Marketplace rows (row-level security keeps them per business). Conservative on purpose:
 *   - only a call that names both `channel` and `market` / `marketplace`;
 *   - `*`, `EU`, `ALL` (a scope, not a market) are left to the tool;
 *   - `EBAY_IT` is read as IT; eBay's `GB` site as Nexus's `UK`;
 *   - a market the business already has listings in counts, even without a Marketplace row;
 *   - a channel with no Marketplace row and no listing is not checked (nothing to check against).
 */
import prisma from '../../db.js'
import { getTool } from './tool-registry.js'
import { PLAN_TOOL, type AgentTool } from './tool-types.js'

const CHANNELS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE'])
const SCOPES = new Set(['*', 'EU', 'ALL'])
const NAMES: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' }

/** The tools whose market is checked: every change tool, and the publish review a publish is decided on. */
const READS_CHECKED = new Set(['publish-review'])

interface Pair { channel: string; code: string; where: string }

/** The channel and market a call names, as the door reads them; null when it does not name both. */
export function namedMarket(args: Record<string, unknown>): { channel: string; code: string } | null {
  const channel = typeof args.channel === 'string' ? args.channel.trim().toUpperCase() : ''
  const raw = typeof args.market === 'string' ? args.market : typeof args.marketplace === 'string' ? args.marketplace : ''
  if (!CHANNELS.has(channel) || !raw.trim()) return null
  let code = raw.trim().toUpperCase()
  if (SCOPES.has(code)) return null
  if (code.startsWith(`${channel}_`)) code = code.slice(channel.length + 1)
  return { channel, code }
}

const sameMarket = (channel: string, a: string, b: string) => a === b || (channel === 'EBAY' && new Set([a, b]).size === 2 && [a, b].every((c) => c === 'GB' || c === 'UK'))

/**
 * Why the market(s) Claude named do not exist in this business, or null. A change plan's steps are checked against
 * their own tools; a read other than publish-review is not checked (a wrong filter only finds nothing).
 */
export async function marketRefusal(
  tool: Pick<AgentTool, 'name' | 'readOnly'>,
  args: Record<string, unknown>,
  toolNamed: (name: string) => Pick<AgentTool, 'name' | 'readOnly'> | undefined = getTool,
): Promise<string | null> {
  const pairs: Pair[] = []
  const take = (t: Pick<AgentTool, 'name' | 'readOnly'>, a: Record<string, unknown>, where: string) => {
    if (t.readOnly && !READS_CHECKED.has(t.name)) return
    const named = namedMarket(a)
    if (named) pairs.push({ ...named, where })
  }
  if (tool.name === PLAN_TOOL && Array.isArray(args.steps)) {
    ;(args.steps as unknown[]).forEach((step, index) => {
      const s = (step ?? {}) as { tool?: unknown; args?: unknown }
      const stepTool = typeof s.tool === 'string' ? toolNamed(s.tool) : undefined
      if (stepTool && s.args && typeof s.args === 'object' && !Array.isArray(s.args)) take(stepTool, s.args as Record<string, unknown>, `Step ${index + 1}: `)
    })
  } else {
    take(tool, args, '')
  }
  if (!pairs.length) return null
  const channels = [...new Set(pairs.map((p) => p.channel))]
  const [marketRows, listed] = await Promise.all([
    prisma.marketplace.findMany({
      where: { channel: { in: channels } },
      select: { channel: true, code: true, isActive: true },
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
    }),
    // A market the business already lists in counts too, even without a Marketplace row.
    prisma.channelListing.findMany({ where: { channel: { in: channels } }, distinct: ['channel', 'marketplace'], select: { channel: true, marketplace: true } }),
  ])
  const rows = [...marketRows]
  for (const l of listed) {
    if (l.marketplace && !rows.some((r) => r.channel === l.channel && r.code.toUpperCase() === l.marketplace.toUpperCase())) rows.push({ channel: l.channel, code: l.marketplace, isActive: true })
  }
  const problems: string[] = []
  for (const pair of pairs) {
    const own = rows.filter((row) => row.channel === pair.channel)
    if (!own.length || own.some((row) => sameMarket(pair.channel, row.code.toUpperCase(), pair.code))) continue
    const codes = own.map((row) => (row.isActive ? row.code : `${row.code} (inactive)`)).join(', ')
    // "not found", as every refusal of something this business does not hold says it (one wording for Claude).
    problems.push(`${pair.where}${NAMES[pair.channel]} market ${pair.code} not found in this business. Its ${NAMES[pair.channel]} markets: ${codes}.`)
  }
  if (!problems.length) return null
  const text = problems.slice(0, 5).join(' ') + (problems.length > 5 ? ` And ${problems.length - 5} more.` : '')
  return `${text} business-overview lists every market with its code. ${tool.readOnly ? 'Nothing was read.' : 'Nothing was queued.'}`
}
