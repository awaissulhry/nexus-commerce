/**
 * MCP full control I2/I3 — product identity tools: where a product's ids disagree, and what each id is.
 * Plan: docs/mcp-full-control/sections/04-identity.md §3.
 *
 * Read-only and low risk: they read this business's own database — no marketplace call, no write. The business is the
 * one call-tool.ts bound; no argument names one. The checks and their SQL live in services/identity/.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  MAX_RESULT_BYTES,
  pageSize,
} from '../../../lib/pagination/cursor.js'
import { IDENTITY_CHECKS, IDENTITY_CHECK_KINDS, IDENTITY_SEVERITIES, identityCheck, type IdentitySeverity } from '../../identity/identity-checks.js'
import { auditIdentity, identityIssuesPage, type IdentityAudit } from '../../identity/identity-audit.service.js'
import { FIND_KINDS, findById, readProductIdentity, type FindKind } from '../../identity/identity-read.service.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'
import { CHECK_COORDINATES, checkFamilyIdentity } from '../../identity/channel-identity-check.service.js'
import { takeToolCall } from '../tool-rate.js'
import type { AgentTool, ToolResult } from '../tool-types.js'

const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]

const checkFilter = z.array(z.preprocess(lower, z.enum(IDENTITY_CHECK_KINDS))).min(1).max(IDENTITY_CHECKS.length)
  .describe('only these checks, by name (each finding and each audit line names its check)')
const severityFilter = z.preprocess(lower, z.enum(IDENTITY_SEVERITIES as [IdentitySeverity, ...IdentitySeverity[]]))
  .describe('only checks of this severity: error, warning or info')

/** The most examples per check one audit shows; the rest are paged by identity-issues. */
const MAX_EXAMPLES = 5
const DEFAULT_EXAMPLES = 3

/** Is a fix tool registered now? Read at call time: the registry imports this file. */
async function toolExists(): Promise<(name: string) => boolean> {
  const { getTool } = await import('../tool-registry.js')
  return (name) => getTool(name) !== undefined
}

/** An audit held under the size limit: examples go first, from the last check up, and the answer says so. */
function fitAudit(audit: IdentityAudit): IdentityAudit & { examplesCut?: number } {
  let cut = 0
  const size = () => Buffer.byteLength(JSON.stringify(audit))
  for (let i = audit.findings.length - 1; i >= 0 && size() > MAX_RESULT_BYTES; i--) {
    while (audit.findings[i].examples.length > 1 && size() > MAX_RESULT_BYTES) {
      audit.findings[i].examples.pop()
      cut++
    }
  }
  return cut ? { ...audit, examplesCut: cut } : audit
}

const identityAudit: AgentTool = {
  name: 'identity-audit',
  title: 'Product identity audit',
  input: z.object({
    checks: checkFilter.optional(),
    severity: severityFilter.optional(),
    examples: z.coerce.number().int().min(1).max(MAX_EXAMPLES).optional()
      .describe(`examples per check that found something (default ${DEFAULT_EXAMPLES}, max ${MAX_EXAMPLES})`),
  }),
  requires: [F.productsView, F.listingsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Check where the ids of this business\'s products and listings disagree, and say how to fix each kind. One line per '
    + 'check that found something: how many, the first examples, what it means and the fix tool (fix.available says '
    + 'whether that tool exists yet). Checks: one eBay Item ID, Shopify product or Etsy listing on two families; live '
    + 'listings with no channel id; eBay Item IDs that differ between a listing and its shared variations; old product id '
    + 'columns; variations pointing at another item than their parent; broken families; duplicate products and SKU '
    + 'collisions; Shopify variants on two products; shared accounts without a claim; listings on an account the business '
    + 'may not use or on no account; invalid, duplicate or mismatched GTIN/EAN/UPC; brand spellings; orphans; eBay '
    + 'accounts without a seller identity. Reads Nexus\'s saved data only: nothing is asked of a channel, so an id another '
    + 'business or the channel itself holds is not checked here. clean lists the checks that found nothing; skipped says '
    + 'why a check did not run. Use identity-issues to page through every finding of a check.',
  async handler(args) {
    const a = args as { checks?: string[]; severity?: IdentitySeverity; examples?: number }
    const audit = await auditIdentity({
      checks: a.checks,
      severity: a.severity,
      examples: a.examples ?? DEFAULT_EXAMPLES,
      toolExists: await toolExists(),
    })
    return { ok: true, data: fitAudit(audit) }
  },
}

const identityIssues: AgentTool = {
  name: 'identity-issues',
  title: 'Product identity issues',
  input: z.object({
    checks: checkFilter.optional(),
    severity: severityFilter.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
      .describe(`findings per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
      .describe('nextCursor from the previous page, with the same filters; omit it for the first page'),
  }),
  requires: [F.productsView, F.listingsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Every finding of the identity checks (see identity-audit), one page at a time: check by check, in a fixed order. '
    + 'Each item names its check and severity, the product (sku, productId) and listing (listingId, channel, market) it '
    + 'is about when there is one, and the ids that disagree in details. checks explains each check met on the page and '
    + 'names its fix tool. Filter by checks or severity. Returns { items, nextCursor }; follow nextCursor for the rest. '
    + 'A page can hold fewer items than limit to stay within a size limit. Reads Nexus\'s saved data only.',
  async handler(args) {
    const a = args as { checks?: string[]; severity?: IdentitySeverity; limit?: number; cursor?: string }
    try {
      const page = await identityIssuesPage({ checks: a.checks, severity: a.severity, size: pageSize(a.limit), cursor: a.cursor })
      const exists = await toolExists()
      const met = [...new Set(page.items.map((item) => item.check))]
      const checks = Object.fromEntries(met.map((kind) => {
        const check = identityCheck(kind)!
        return [kind, {
          number: check.number,
          title: check.title,
          explanation: check.explanation,
          fix: { tool: check.fix.tool, available: check.fix.tool ? exists(check.fix.tool) : false, how: check.fix.how },
        }]
      }))
      return {
        ok: true,
        data: {
          items: page.items,
          nextCursor: page.nextCursor,
          checks,
          ...(page.skipped.length ? { skipped: page.skipped } : {}),
          ...(page.nextCursor
            ? { more: `More findings follow${page.cut ? ` (this page was cut by ${page.cut} to stay within the size limit)` : ''}: `
                + 'call again with cursor set to nextCursor, or narrow with checks or severity.' }
            : {}),
        },
      } satisfies ToolResult
    } catch (error) {
      if (error instanceof InvalidCursorError) return { ok: false, error: `identity-issues was called wrongly — cursor: ${error.message}` }
      throw error
    }
  },
}

// ── I3: one family's ids, and what an id is ───────────────────────────────────────────────────────────

const productIdentity: AgentTool = {
  name: 'product-identity',
  title: 'Product identity',
  input: z.object({
    productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family\'s parent or any of its variations'),
    channel: z.preprocess(upper, z.enum(CHANNELS)).optional().describe('only listings on this channel'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('only listings in this marketplace code, e.g. IT or DE; GLOBAL for single-store channels such as Shopify and Etsy'),
  }),
  requires: [F.productsView, F.listingsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Every id of one product family, from every place Nexus keeps one: each product\'s SKU, GTIN/EAN/UPC, SKU aliases and '
    + 'old channel-id columns; each listing\'s channel ids (ASIN and parent ASIN, eBay Item ID, Shopify product, variant and '
    + 'inventory item, Etsy listing id), account (ownedHere = this business owns it; visible false = no longer shared with '
    + 'it), extra listing, seller SKU, offers and shared-account claim; the extra listings; the shared eBay listings '
    + '(variation rows) and the Shopify colour products. Name the parent or any variation. Filter listings by channel or '
    + 'market; a long family names the first ones and counts the rest in more. This business only; to see where ids '
    + 'disagree across the catalogue, use identity-audit.',
  async handler(args) {
    const a = args as { productId: string; channel?: string; market?: string }
    const identity = await readProductIdentity(a.productId, { channel: a.channel, market: a.market })
    if (!identity) return { ok: false, error: PRODUCT_NOT_FOUND }
    return { ok: true, data: identity }
  },
}

const findByIdTool: AgentTool = {
  name: 'find-by-id',
  title: 'Find by id',
  input: z.object({
    query: z.string().trim().min(1).max(200)
      .describe('the id to look for: a SKU, ASIN, eBay Item ID, Shopify product, variant or inventory item id, Etsy listing id, GTIN/EAN/UPC or Nexus product id'),
    kind: z.preprocess(lower, z.enum(FIND_KINDS)).optional()
      .describe(`what the id is, when known (${FIND_KINDS.join(', ')}); omitted = look in every place`),
  }),
  requires: [F.productsView, F.listingsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'What an id is in this business: every place it is used — a product SKU, SKU alias, offer SKU, shared eBay variation '
    + 'SKU, claimed seller SKU or extra listing SKU; an ASIN or parent ASIN; an eBay Item ID (listings, shared eBay '
    + 'listings, the eBay listing index); a Shopify product, variant, inventory item or colour product (gid:// or short); '
    + 'an Etsy listing id; a GTIN/EAN/UPC (leading zeros ignored); a Nexus product id; and the old product id columns. '
    + 'SKUs match without case; each match names its product, family, listing, channel, market and account, and families '
    + 'sums the matches per family. Deleted products are not searched. For an eBay Item ID, Shopify product or Etsy listing '
    + 'this business holds, elsewhere says whether another business holds it too (named only when you are a member of '
    + 'that business); nothing of the other business is shown.',
  async handler(args) {
    const a = args as { query: string; kind?: FindKind }
    const found = await findById(a.query, a.kind)
    return {
      ok: true,
      data: {
        query: a.query,
        ...(a.kind ? { kind: a.kind } : {}),
        matches: found.matches,
        families: found.families,
        ...(found.elsewhere.length ? { elsewhere: found.elsewhere } : {}),
        ...(found.more ? { more: `${found.more} more matches are not shown: name the kind of id to narrow the search.` } : {}),
        ...(found.matches.length ? {} : { note: 'Nothing in this business uses this id.' }),
      },
    }
  },
}

// ── I8: one family's ids, checked live on the channel ─────────────────────────────────────────────────

/** Live reads spend the channel's rate budget: this many checks per business per hour (NEXUS_IDENTITY_CHECK_PER_HOUR). */
export const CHECKS_PER_HOUR = () => Math.max(1, Number(process.env.NEXUS_IDENTITY_CHECK_PER_HOUR ?? 20))

const channelIdentityCheck: AgentTool = {
  name: 'channel-identity-check',
  title: 'Check ids live on the channel',
  input: z.object({
    productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family\'s parent or any variation'),
    channel: z.preprocess(upper, z.enum(CHANNELS)).optional().describe('only listings on this channel'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only listings in this marketplace code, e.g. IT or DE'),
  }),
  requires: [F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  description:
    `Read one family's listings LIVE from the channel (up to ${CHECK_COORDINATES} listings a call) and say, per listing: held (the `
    + 'account holds the item and it is live), ended, foreign (another seller lists it — eBay compares the seller with '
    + 'the account), unverifiable (the account has no recorded seller), or not-readable (and why: no account, no channel '
    + 'id yet, or a channel whose live read is not built). Also the SKUs missing on the channel or there but not in Nexus. '
    + 'Nothing is changed. Limited per business per hour; a read from the last 30 seconds is reused.',
  async handler(args) {
    const a = args as { productId: string; channel?: string; market?: string }
    const limit = CHECKS_PER_HOUR()
    const verdict = await takeToolCall('channel-identity-check:live', limit)
    if (!verdict.ok) {
      return { ok: false, error: `channel-identity-check is limited to ${limit} live checks per hour in this business. Try again in ${Math.max(1, Math.ceil(verdict.retryAfterSec / 60))} min.` }
    }
    const out = await checkFamilyIdentity(a.productId, { channel: a.channel, market: a.market })
    if (!out) return { ok: false, error: PRODUCT_NOT_FOUND }
    return { ok: true, data: out }
  },
}

export const IDENTITY_TOOLS: AgentTool[] = [identityAudit, identityIssues, productIdentity, findByIdTool, channelIdentityCheck]
