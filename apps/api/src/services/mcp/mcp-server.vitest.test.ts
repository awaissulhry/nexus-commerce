/**
 * MCP.7 — how every registered tool is described to Claude, computed from the tool itself.
 *
 * The integration test (routes/mcp.routes.vitest.test.ts) checks the wire; this one holds the
 * rules for the whole registry, so a new tool is covered the day it is added.
 */
import { describe, expect, it } from 'vitest'
import { listTools } from '../agents/tool-registry.js'
import { offeredOn } from '../agents/call-tool.js'
import { mcpInputSchema, mcpInstructions, mcpServerInfo, requiredScope, toolAnnotations } from './mcp-server.js'
import { inputJsonSchema } from '../agents/tool-loop.service.js'
import { BRAIN_MAP_VIEWS } from '../advertising/brain/read-map.js'

/** Call OUR AI provider: offered in the app only. */
const AI_DRAFTS = ['draft-alt-text', 'draft-customer-message', 'draft-listing-content', 'draft-seo', 'translate-content']
/** Their preview or their action reaches a marketplace or a buyer. */
// 07 O5 — shipping-rates asks a carrier (Sendcloud, Amazon Buy Shipping) live: outside Nexus too.
// L3 — publish-review reads the channel live (the studio's review). publication-status only reads what Nexus stored.
// MCP full control P8 — save-channel-mapping: activating a mapping queues the listings' pushes to the channels.
// C6 — a change plan says so too: its steps may reach a marketplace or a buyer (each step's preview says which).
// R10–R17 (automation) — a level move, a resume, a suggestion decided, an engine tuned or a price rule saved
// changes what the engines then send to a marketplace.
// 07 O8 — buying and voiding labels reach a carrier (and cost money).
// 08 S6 — a stock change moves what listings that follow stock show: the cascade queues the new quantity to channels.
// 08 S12 — a promotion's sales and a scheduled master price reach the channels when they run.
// 08 S9 — sending a purchase order e-mails the supplier. 08 S10 — a receive raises what listings that follow stock show.
// 08 S13 — an eBay promotion and an FBA plan reach the marketplace. (Step 4: FBA options are read from what Nexus stored, not live.)
// T11 — the three content tools that read a channel live (a Shopify store, a listing on its channel) are open world too.
// I8/I9 — channel-identity-check reads the marketplace live; link-channel-id verifies on the channel before it asks.
// L8 — stock and price per listing reach the channels (the Matrix door queues the pushes); a revert sends the old values.
// L9 — closing and reopening a listing changes it on the channel. Phase 3 (T1) — so do ending, relisting and deleting it.
// Phase 3 T3 — ebay-categories reads eBay's category suggestions and a category's details live (it stores nothing).
// Ads autonomy W3-1 — apply-ad-recommendations asks for a plan whose steps reach Amazon.
// FBA shipment drafts (Owner 2026-10-08) — plan-fba-shipment fills a draft in Nexus only; a person's "Send to Amazon" reaches Amazon.
// Ads autonomy (auto-undo, A19) — undo-worse-ad-change puts a bid, budget or placement back at Amazon.

const OPEN_WORLD = [
  'add-ad-targets', 'add-negative-targets', 'add-photo-from-url', 'add-product-ads', 'advance-purchase-order',
  'apply-ad-recommendations', 'apply-ads-playbook', 'apply-brain-harvest', 'archive-ads', 'build-sp-wizard-campaigns', 'bulk-ad-bid-change',
  'bulk-listing-price-change', 'bulk-listing-stock', 'bulk-price-change', 'buy-shipping-label', 'cancel-order',
  'channel-identity-check', 'close-listing', 'confirm-shipment', 'create-ad-campaign', 'create-ad-group',
  'create-ai-goal-campaigns',
  'create-ebay-campaign', 'create-negative-keyword', 'decide-automation-suggestions', 'delete-listing', 'dispose-return-items',
  'ebay-categories', 'ebay-keywords-change', 'email-supplier', 'enable-ads', 'end-listing', 'graduate-keyword', 'harvest-search-term', 'import-catalog', 'issue-refund',
  'link-channel-id', 'listing-live-content', 'lower-ad-bids-for-stock', 'pause-ads', 'promote-ebay-listings', 'publish-listing',
  'publish-review', 'receive-stock', 'reconcile-stock-count', 'relist-listing', 'reopen-listing', 'replicate-ad-structure', 'reply-to-review', 'request-review', 'resend-prices',
  'reserve-stock', 'restore-ad-bids-after-stock', 'restore-budget-baselines', 'restore-campaign', 'resume-automation',
  'retire-negatives', 'revert-listing-change', 'rollback-bulk-operation', 'run-ad-engine-now',
  'save-channel-mapping', 'save-price-rule', 'schedule-pickup', 'schedule-price-change', 'send-customer-message',
  'set-ad-group', 'set-bid-brain-enrollment', 'set-budget-pool', 'set-budget-schedule', 'set-campaign-budget', 'set-campaign-settings',
  'set-ebay-ad-rates', 'set-ebay-campaign-budget', 'set-ebay-price-promotion', 'set-hourly-bid-plan',
  'set-listing-price', 'set-listing-stock', 'set-master-prices', 'set-monthly-ad-budget', 'set-placement-multipliers',
  'set-portfolio', 'set-price',
  'set-promotion', 'set-shopify-content', 'set-stock', 'set-stock-policy', 'set-stock-source', 'set-target-bid', 'shipping-rates',
  'shopify-content', 'submit-change-plan', 'suppress-campaign', 'sync-orders-now', 'transfer-stock', 'tune-ad-engine',
  'turn-down-automation', 'turn-up-automation', 'undo-ad-change', 'undo-worse-ad-change', 'void-shipping-label',
]

describe('MCP.7 — every tool, as Claude sees it', () => {
  it('has a short title', () => {
    const bad = listTools().filter((tool) => !tool.title?.trim() || tool.title.length > 40).map((tool) => tool.name)
    expect(bad).toEqual([])
  })

  it('a read is readOnly and needs nexus.read; anything else is destructive and needs nexus.write', () => {
    for (const tool of listTools()) {
      const hints = toolAnnotations(tool)
      expect({ name: tool.name, title: hints.title, readOnlyHint: hints.readOnlyHint }).toEqual({
        name: tool.name,
        title: tool.title,
        readOnlyHint: tool.readOnly,
      })
      expect({ name: tool.name, scope: requiredScope(tool) }).toEqual({
        name: tool.name,
        scope: tool.readOnly ? 'nexus.read' : 'nexus.write',
      })
      if (!tool.readOnly || tool.alwaysAsk || tool.riskTier === 'high') {
        expect({ name: tool.name, destructiveHint: hints.destructiveHint }).toEqual({ name: tool.name, destructiveHint: true })
      }
    }
  })

  it('a change needs a person by its own code: no policy can let it run unasked', () => {
    // tool-policy.service.ts can loosen approval only for a change tool without one of these. W4-1 — the journal tools
    // (Claude's own record, no change of the business; an exact list in tool-contract.vitest.test.ts) run at once by design.
    const loose = listTools()
      .filter((tool) => !tool.readOnly && tool.execute)
      .filter((tool) => !tool.alwaysAsk && tool.riskTier !== 'high' && !tool.requiresApprovalDefault)
      .map((tool) => tool.name)
    expect(loose).toEqual(listTools().filter((tool) => tool.journal).map((tool) => tool.name))
    expect(loose).toEqual(['report-ads-run'])
  })

  it('open world exactly where a marketplace or a buyer is reached', () => {
    const open = listTools().filter((tool) => toolAnnotations(tool).openWorldHint).map((tool) => tool.name).sort()
    expect(open).toEqual(OPEN_WORLD)
  })

  it('A2 — the ad reads (T4: and the eBay ad details) are offered to Claude as reads: nexus.read, closed world, ads.view', () => {
    const reads = ['ads-overview', 'ad-campaigns', 'ad-targets', 'ad-search-terms', 'ad-changes', 'ad-recommendations', 'ebay-ad-details']
    for (const name of reads) {
      const tool = listTools().find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      expect({ name, offered: offeredOn(tool!, 'mcp'), scope: requiredScope(tool!), open: toolAnnotations(tool!).openWorldHint, readOnly: tool!.readOnly, execute: !!tool!.execute, requires: tool!.requires })
        .toEqual({ name, offered: true, scope: 'nexus.read', open: false, readOnly: true, execute: false, requires: ['ads.view'] })
    }
  })

  it('the AI drafts, and only they, are kept from Claude', () => {
    const appOnly = listTools().filter((tool) => !offeredOn(tool, 'mcp')).map((tool) => tool.name).sort()
    expect(appOnly).toEqual(AI_DRAFTS)
    // C7 — and only confirm-change is Claude's alone: a person confirms in Claude with a code; in Nexus they approve.
    // W4-1 — and report-ads-run: the scheduled Claude run's own report.
    expect(listTools().filter((tool) => !offeredOn(tool, 'app')).map((tool) => tool.name).sort()).toEqual(['confirm-change', 'report-ads-run'])
  })
})

describe('C3 — the server and every change tool name the business', () => {
  const business = { id: 'ws-1', name: 'Xavia Racing' }

  it('the server title and the instructions name it', () => {
    expect(mcpServerInfo(business)).toMatchObject({ name: 'nexus', title: 'Nexus — Xavia Racing' })
    expect(mcpInstructions(business)).toContain('This connection works in the business "Xavia Racing" only')
    expect(mcpInstructions(business)).toContain('business: "Xavia Racing"')
    // N3 — the rules every skill used to repeat, once, here.
    for (const rule of ['submit-change-plan, undo-change and confirm-change', 'read it before naming a market or an account',
      'go on only after a clear yes', 'ONE submit-change-plan', 'approveAt; it expires at expiresAt', 'the approvalId, the planHash and the',
      'Never say a change ran until approval-status says so', 'Never change an Amazon FBA quantity', 'old Amazon or eBay flat-file pages',
      // AA-W2-12 (Owner 2026-10-06) — a temporary stop is low bids; a real pause only when meant; an archive is for good.
      'To stop an ad for a while, lower its bids', 'Pause an ad (pause-ads) only when the person means a real pause',
      'Archive an ad (archive-ads) only when it is meant for good',
      // W1-8 — where the ads strategy lives, and that it only narrows.
      'read it with ads-strategy, change', 'It only narrows what this business lets',
      // BB-4 — the bid brain's read tool; BB-6 — it writes only for a campaign put LIVE, with the approver's code.
      'bid-brain (read only; the bid', 'writes only for a campaign set-bid-brain-enrollment put LIVE',
      "needs the approver's authenticator code; its diff view",
      // AB-3 — the brain's map, read only; every view it has (AB-7 money, AB-9 terms, AB-12 state, AB-13 hours, AB-10 negatives, AB-11 harvest).
      'ads-brain (read only; views map, clashes, setup, money, terms, state, hours, negatives, harvest)',
      // AB-11 — the brain's harvest request, a person's decision.
      'person for is apply-brain-harvest (the keyword and its source negatives in one change set',
      // PB-11 — where the playbook lives, and that a start needs the approver's code.
      'read it with ads-playbook, change it with', 'start, stop or sync its campaigns, switch its phase',
      "a start needs the approver's authenticator code",
      // W4-14 — a copy into another market, a person's hourly plan and a person's pause keep their own doors.
      'a copy into another market never runs by rule',
      'An hourly bid plan a person made changes by rule only where the business allowed it',
      "only with enable-ads includePeoplesPauses and the approver's authenticator code, never by rule",
      // Platform health watchdog (2026-10-07) — the daily checks are read first in an unattended run.
      'read platform-health-checks first in a daily or unattended run']) {
      expect(mcpInstructions(business), rule).toContain(rule)
    }
  })

  it('the instructions name every view of ads-brain, in the tool\'s own order (a new view cannot be left out)', () => {
    expect(mcpInstructions(business)).toContain(`ads-brain (read only; views ${BRAIN_MAP_VIEWS.join(', ')}).`)
    expect([...BRAIN_MAP_VIEWS]).toEqual(['map', 'clashes', 'setup', 'money', 'terms', 'state', 'hours', 'negatives'])
  })

  it('W4-14 — the instructions name every Wave 4 Amazon ads tool, and each is a registered tool', () => {
    const registered = new Set(listTools().map((tool) => tool.name))
    for (const name of ['ad-hourly-plans', 'set-hourly-bid-plan', 'enable-ads', 'ad-portfolios', 'set-portfolio', 'set-campaign-settings',
      'add-ad-targets', 'add-negative-targets', 'retire-negatives', 'harvest-search-term', 'set-harvest-destination', 'ad-groups',
      'create-ad-group', 'add-product-ads', 'set-ad-group', 'ad-budgets', 'set-monthly-ad-budget', 'set-budget-schedule', 'set-budget-pool',
      'restore-budget-baselines', 'assign-ad-rules', 'set-coverage-set', 'run-ad-engine-now', 'ad-recommendations', 'apply-ad-recommendations',
      'mute-ad-recommendations', 'replicate-ad-structure']) {
      expect(registered.has(name), name).toBe(true)
      expect(mcpInstructions(business), name).toMatch(new RegExp(`(^|[^a-z-])${name}([^a-z-]|$)`))
    }
  })

  it('every change tool takes a required business name; a read takes none', () => {
    for (const tool of listTools()) {
      const schema = mcpInputSchema(tool, business) as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
      const own = inputJsonSchema(tool) as { properties?: Record<string, unknown>; required?: string[] }
      // N1 — every schema says no other argument is taken (the door refuses one by name).
      expect((schema as { additionalProperties?: unknown }).additionalProperties, tool.name).toBe(false)
      if (tool.readOnly) {
        expect(schema, tool.name).toEqual({ ...own, additionalProperties: false })
        continue
      }
      expect(schema.properties?.business, tool.name).toMatchObject({ type: 'string', description: expect.stringContaining('"Xavia Racing"') })
      expect(schema.required, tool.name).toContain('business')
      // The tool's own arguments are all still there, unchanged.
      for (const [key, value] of Object.entries(own.properties ?? {})) expect(schema.properties?.[key]).toEqual(value)
      for (const key of own.required ?? []) expect(schema.required).toContain(key)
      // The tool's own schema is untouched (the in-app assistant gets it as it is).
      expect(own.properties ?? {}).not.toHaveProperty('business')
    }
  })
})
