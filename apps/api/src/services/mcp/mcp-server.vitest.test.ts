/**
 * MCP.7 — how every registered tool is described to Claude, computed from the tool itself.
 *
 * The integration test (routes/mcp.routes.vitest.test.ts) checks the wire; this one holds the
 * rules for the whole registry, so a new tool is covered the day it is added.
 */
import { describe, expect, it } from 'vitest'
import { listTools } from '../agents/tool-registry.js'
import { offeredOn } from '../agents/call-tool.js'
import { INSTRUCTIONS_LIMIT, mcpInputSchema, mcpInstructions, mcpServerInfo, requiredScope, toolAnnotations } from './mcp-server.js'
import { inputJsonSchema } from '../agents/tool-loop.service.js'
import { BRAIN_MAP_VIEWS } from '../advertising/brain/read-map.js'
import { GOOGLE_UNCHECKED_CHANGE_RULES } from '../agents/tools/google-ads-kit.js'
import { GOOGLE_PARTLY_CHECKED_RULES } from '../agents/tools/google-ads-account.tools.js'
import { MERCHANT_CHANGE_RULES } from '../agents/tools/google-merchant-kit.js'

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
// Google Ads G5 (2026-10-15) — labels, Google's recommendations (apply, dismiss, auto-apply) and portfolio bid strategies change the Google Ads account.
// Google Ads G8b (2026-10-15) — the account's settings, users, links and billing.
// Google Ads G6 (2026-10-15) — assets of every type and their links at the account, campaigns and ad groups change the Google Ads account.
// Google Ads G9 (2026-10-15) — experiments and campaign drafts change the Google Ads account; google-ads-experiments reads it live.
// Google Ads G8a (2026-10-15) — conversion actions, goals and value rules change the Google Ads account; Shopify sales and their adjustments are sent to Google.
// Google Ads G11 (2026-10-15) — Demand Gen, Display and App campaigns, their ad groups and ads, and video responsive ads change the Google Ads account.
// Google Ads G10 (2026-10-16) — Performance Max campaigns are built, copied and changed, and customer acquisition is set, in the Google Ads account.
// Google Ads G14a (2026-10-16) — custom conversion goals, custom segments, user lists and reusable audiences change the Google Ads account.
// Amazon A+ (2026-10-19) — aplus-content reads A+ content live from Amazon; set-aplus-content, set-aplus-asins and submit-aplus-content change it there.
// SD creatives (2026-10-20) — ad-creatives and ad-assets read Sponsored Display creatives and the asset library live from Amazon; set-ad-creative and upload-ad-asset change them there.
// Sponsored Display extras (P3c, 2026-10-20) — the sd-… reads ask Amazon live; set-sd-optimization-rule, set-sd-budget-rule and set-sd-brand-safety change it there.
// Meta ads step 1 (2026-10-20) — meta-connection reads the Meta connection live from Meta (views check, permissions, app,
// choices); set-meta-connection's preview reads what the system user can see from Meta (its change stays in Nexus).
// Meta ads step 2 (2026-10-20) — meta-ad-accounts, meta-ads-live and meta-ads-graph-read read Meta live (meta-ads-overview reads Nexus's stored read).
// Meta ads step 17 (2026-10-21) — set-meta-status reads Meta live and changes it (pause, switch on, archive).
// Meta ads step 9 (2026-10-21) — meta-targeting-search and meta-targeting-check read Meta live.
// Meta ads step 6 (2026-10-21) — meta-campaigns, meta-ad-sets, meta-ad-details, meta-labels and meta-value-rules read Meta live.
// Meta ads step 10 (2026-10-21) — meta-media-library, meta-page-posts, meta-instagram-media, meta-ad-preview and meta-instant-experiences read Meta live.
// Meta ads step 16 (2026-10-21) — meta-partnership-content, meta-ad-library, meta-brand-safety and meta-webhooks read Meta live.
// Meta ads step 8 (2026-10-21) — meta-recommendations, meta-experiments and meta-ad-rules read Meta live.
// Meta ads step 14 (2026-10-21) — meta-lead-forms, meta-leads and meta-comments read Meta live.
// Meta ads step 11 (2026-10-21) — meta-audiences and meta-datasets read Meta live.
// Meta ads step 18 (2026-10-21) — set-meta-campaign, set-meta-ad-set and set-meta-budget-schedule read Meta live and change it.
// Meta ads step 31 (2026-10-21) — create-meta-audience, set-meta-audience, set-meta-audience-members, set-meta-audience-sharing and
// remove-meta-audience read Meta live and change it.

const OPEN_WORLD = [
  'ad-assets', 'ad-creatives', 'add-ad-targets', 'add-google-assets', 'add-google-campaign-type-ads', 'add-negative-targets', 'add-photo-from-url', 'add-product-ads', 'adjust-google-sales',
  'advance-purchase-order', 'aplus-content',
  'apply-ad-recommendations', 'apply-ads-playbook', 'apply-brain-harvest', 'apply-brain-hourly-plan', 'apply-google-recommendations',
  'apply-harvest',
  'archive-ads', 'build-google-campaigns', 'build-google-pmax', 'build-sp-wizard-campaigns', 'bulk-ad-bid-change',
  'bulk-listing-price-change', 'bulk-listing-stock', 'bulk-price-change', 'buy-shipping-label', 'cancel-order',
  'channel-identity-check', 'check-google-ads-build', 'close-listing', 'confirm-shipment', 'copy-google-campaign',
  'copy-google-pmax', 'create-ad-campaign', 'create-ad-group', 'create-ai-goal-campaigns', 'create-ebay-campaign',
  'create-google-app-campaign', 'create-google-campaign', 'create-google-demand-gen-campaign',
  'create-google-display-campaign', 'create-google-experiment', 'create-google-rsa', 'create-meta-audience', 'create-negative-keyword',
  'decide-automation-suggestions',
  'delete-listing', 'dismiss-google-recommendations', 'dispose-return-items', 'ebay-categories',
  'ebay-keywords-change', 'edit-google-assets', 'edit-google-campaign-type-ads', 'edit-google-rsa', 'email-supplier',
  'enable-ads', 'enable-google-pmax-brand-guidelines', 'end-google-experiment', 'end-listing', 'google-ads-experiments', 'google-ads-live',
  'google-ads-numbers', 'google-ads-query', 'google-merchant-live', 'graduate-google-experiment', 'graduate-keyword',
  'harvest-search-term',
  'import-catalog', 'issue-refund', 'link-channel-id', 'listing-live-content', 'lower-ad-bids-for-stock',
  'meta-ad-accounts', 'meta-ad-details', 'meta-ad-library', 'meta-ad-preview', 'meta-ad-rules', 'meta-ad-sets', 'meta-ads-graph-read',
  'meta-ads-live', 'meta-audiences', 'meta-brand-safety', 'meta-campaigns', 'meta-comments', 'meta-connection', 'meta-datasets', 'meta-experiments',
  'meta-instagram-media', 'meta-instant-experiences', 'meta-labels', 'meta-lead-forms', 'meta-leads', 'meta-media-library', 'meta-page-posts',
  'meta-partnership-content',
  'meta-recommendations', 'meta-targeting-check', 'meta-targeting-search', 'meta-value-rules', 'meta-webhooks',
  'move-google-ads', 'pause-ads', 'promote-ebay-listings', 'promote-google-campaign-draft', 'promote-google-experiment', 'publish-listing', 'publish-review', 'receive-stock',
  'reconcile-stock-count', 'relist-listing', 'remove-google-ads-items', 'remove-google-bid-strategy',
  'remove-google-conversion-actions', 'remove-google-labels', 'remove-meta-audience', 'reopen-listing', 'replace-google-keywords', 'replicate-ad-structure', 'reply-to-review',
  'request-review',
  'resend-prices', 'reserve-stock', 'restore-ad-bids-after-stock', 'restore-budget-baselines', 'restore-campaign',
  'resume-automation', 'retire-negatives', 'revert-listing-change', 'rollback-bulk-operation', 'run-ad-engine-now',
  'save-channel-mapping', 'save-price-rule', 'schedule-google-experiment', 'schedule-pickup', 'schedule-price-change',
  // SD-AUD and P3c — the Sponsored Display lookups and extras read Amazon live.
  'sd-audiences', 'sd-bid-recommendations', 'sd-brand-safety', 'sd-budget-insights', 'sd-budget-rules', 'sd-categories',
  'sd-forecast', 'sd-optimization-rules', 'sd-targeting-recommendations', 'send-customer-message',
  'set-ad-creative', 'set-ad-group', 'set-ads-brain', 'set-aplus-asins', 'set-aplus-content', 'set-bid-brain-enrollment', 'set-budget-pool', 'set-budget-schedule',
  'set-campaign-budget', 'set-campaign-settings', 'set-ebay-ad-rates', 'set-ebay-campaign-budget',
  'set-ebay-price-promotion', 'set-google-account-exclusions', 'set-google-account-links',
  'set-google-account-settings', 'set-google-ad-groups', 'set-google-asset-links', 'set-google-assets',
  'set-google-audiences', 'set-google-auto-apply', 'set-google-bid-strategy', 'set-google-billing',
  'set-google-budget', 'set-google-campaign', 'set-google-campaign-draft', 'set-google-campaign-exclusions',
  'set-google-campaign-type', 'set-google-conversion-actions', 'set-google-conversion-goals',
  'set-google-custom-audiences', 'set-google-custom-goals', 'set-google-customer-acquisition', 'set-google-demographics',
  'set-google-exclusion-list', 'set-google-experiment', 'set-google-inventory-filter', 'set-google-keywords',
  'set-google-labels', 'set-google-merchant-data-sources', 'set-google-merchant-products',
  'set-google-merchant-promotions', 'set-google-negative-list', 'set-google-negatives', 'set-google-page-feed',
  'set-google-pmax', 'set-google-product-groups', 'set-google-reusable-audiences',
  'set-google-shopping-settings', 'set-google-status', 'set-google-targeting', 'set-google-urls',
  'set-google-user-access', 'set-google-user-lists', 'set-google-value-rules', 'set-hourly-bid-plan', 'set-listing-price',
  'set-listing-stock',
  'set-master-prices', 'set-meta-ad-set', 'set-meta-audience', 'set-meta-audience-members', 'set-meta-audience-sharing', 'set-meta-budget-schedule', 'set-meta-campaign', 'set-meta-connection', 'set-meta-status', 'set-monthly-ad-budget', 'set-placement-multipliers', 'set-portfolio', 'set-price',
  'set-promotion', 'set-sd-brand-safety', 'set-sd-budget-rule', 'set-sd-optimization-rule', 'set-shopify-content', 'set-stock', 'set-stock-policy', 'set-stock-source', 'set-target-bid',
  'shipping-rates', 'shopify-content', 'submit-aplus-content', 'submit-change-plan', 'suppress-campaign', 'sync-orders-now', 'transfer-stock',
  'tune-ad-engine', 'turn-down-automation', 'turn-up-automation', 'undo-ad-change', 'undo-worse-ad-change',
  'upload-ad-asset', 'upload-google-sales', 'void-shipping-label',
]

/**
 * The hard rules: every one must reach Claude inside the first 4,096 characters (the 4,096 block below). One key phrase
 * per rule; the comments say where each came from.
 */
const HARD_RULES = [
  // C3 — one business per connection; ids never cross; the business named on every change.
  'never reuse an id, a SKU or an approvalId', 'any other name is refused', 'submit-change-plan, undo-change and confirm-change',
  'before naming a market or an account',
  // N3 — the rules every skill used to repeat, once, here.
  'Before any change: tell the person which business it is for, read what is there now, show the plan',
  'go on only after a clear yes', 'ONE submit-change-plan', 'never a loop of single requests',
  'A change tool changes nothing from here', 'approveAt; it expires at expiresAt', 'status runs_by_rule',
  'You cannot approve changes, and you cannot change what may run by rule', 'confirm-change (approvalId, planHash, code)',
  'never guess, store or reuse a code', 'Never say a change ran until approval-status says so',
  'undo-change asks to put a change back', 'Never change an Amazon FBA quantity', 'old Amazon or eBay flat-file pages',
  'pass the reason on in plain words and carry on',
  // Platform health watchdog (2026-10-07) — the daily checks are read first in an unattended run.
  'In a daily or unattended run read platform-health-checks first',
  'make no change that rests on a feed it calls late or failing',
  // W1-8 — the ads strategy only narrows.
  'The Amazon ads strategy (ads-strategy) only narrows what this business lets', 'never widens it',
  // AA-W2-12 (Owner 2026-10-06) — a temporary stop is low bids; a real pause only when meant; an archive is for good.
  'To stop an ad for a while, lower its bids', 'Pause an ad (pause-ads) only when the person means a real pause',
  'Archive an ad (archive-ads) only when it is meant for good',
  // PB — campaigns only through Nexus's own builders.
  "Amazon campaigns are built only with Nexus's own builders",
  // Never by rule: Google (2026-10-15), a strategy raise (W1-8), a harvest (HMCP, AB-11), the brains (BB-6, AB-13, AB-15,
  // AB-20, one brain), a copy into another market and a person's pause (W4-14).
  "Never by rule, always a person's decision: every Google Ads and Merchant Center change (approved in Nexus)",
  'a raise of the ads strategy, a harvest, any change to the ads or bid brain or an hourly plan the brain painted',
  'a copy of campaigns into another market', 'switching on an ad no Claude request paused (enable-ads includePeoplesPauses)',
  // Google Ads changes (2026-10-15, G13) — checked first except …, spend marked, new campaigns paused, removes only asked,
  // a build is one call.
  'Google checks a Google change first (validate_only), except apply-google-recommendations',
  'make the account spend more is marked SPENDS MONEY in the preview', 'A new campaign is always made paused',
  'enabling anything is set-google-status (SPENDS MONEY)', 'remove-google-… tools delete only what the person asked to delete',
  'New parts that point at new parts are ONE call (build-google-campaigns', 'never steps of a change plan',
  // Meta ads step 17 (2026-10-21) — Meta changes are the set-meta-… tools; a Meta app secret or token is a person's to enter in
  // Settings, never Claude's.
  'Meta changes go through set-meta-… tools; never take a Meta app secret or token in chat',
]

/**
 * Tool-by-tool guidance that left the instructions (2026-10-16, 4,096): each sentence is said in the named tool's own
 * description, which Claude always gets in full.
 */
const MOVED_TO_DESCRIPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['business-overview', 'Read it before naming a market or an account'],
  ['ads-strategy', 'the strategy only narrows it, never widens it'], ['ads-strategy', 'trust.strategy'],
  ['set-ads-strategy', 'a RAISE never does'],
  ['approval-status', 'An approved change runs as the person who approved it, after its facts are checked again'],
  ['ads-overview', 'Google (channel google): the Google Ads account a person chose for this business'],
  ['ad-campaigns', 'Google (channel google)'], ['google-ad-details', 'brand-split'], ['google-ad-details', 'alerts:'],
  ['google-ads-live', 'change-history'], ['google-ads-numbers', 'up to and including TODAY'],
  ['google-ads-query', 'the catch-all for any read'], ['google-ads-experiments', 'read LIVE from Google'],
  ['google-merchant-live', 'Merchant Center, read LIVE from Google'], ['check-google-ads-build', 'nothing waits in Approvals'],
  ['build-google-campaigns', 'Use it, not a change plan, when new parts point at new parts'],
  ['bid-brain', 'in SHADOW'], ['bid-brain', 'for a campaign set-bid-brain-enrollment put LIVE'], ['bid-brain', 'view what-if'],
  ['bid-brain', 'view diff'], ['set-bid-brain-enrollment', 'never by rule'],
  ['apply-brain-harvest', 'it never runs by rule'], ['apply-brain-harvest', 'Claude cannot approve it'],
  ['apply-harvest', 'as ONE change set'], ['apply-harvest', 'it never runs by rule, and Claude cannot approve it'],
  ['apply-harvest', 'then its keyword paused'], ['harvest-search-term', 'same change set'], ['graduate-keyword', 'same change set'],
  ['harvest-candidates', 'one row per search term × product × market'], ['harvest-destinations', 'destination picker'],
  ['harvest-history', 'too early'], ['skip-harvest-terms', 'for 7 days, 30 days or for'], ['harvest-rules', 'Rules view'],
  ['set-harvest-rules', 'Rules view'], ['harvest-sources', 'Sources view'], ['set-harvest-sources', 'detach'],
  ['apply-brain-hourly-plan', 'never by rule'],
  ['apply-brain-hourly-plan', 'the hourly bid engine applies it at Amazon from its next run'],
  ['set-ads-brain', "always win over the brain's defaults and over the brain"], ['set-ads-brain', 'portfolioCapLimitCents) included'],
  ['set-brain-kill-switch', "a person's normal approval (as a kill itself is)"],
  ['retire-ads-writers', 'never deleted'], ['retire-ads-writers', 'ads-brain view retire shows what would retire'],
  ['apply-ads-playbook', "Starting to spend is a person's approval"], ['apply-ads-playbook', 'allowlist'],
  ['replicate-ad-structure', 'a copy into another market never runs by rule'],
  ['replicate-ad-structure', 'off the live-write allowlist'], ['build-sp-wizard-campaigns', 'allowlist'],
  ['create-ai-goal-campaigns', 'off the live-write allowlist'], ['create-ad-campaign', 'off the live-write allowlist'],
  ['undo-worse-ad-change', 'born OBSERVE'], ['undo-worse-ad-change', '3 settled days'],
  ['automation-detail', 'auto-undo (A19) lists its judgements'],
  // P2a — Sponsored Display is created here too (born paused); Sponsored Brands stays on the Nexus screens.
  ['create-ad-campaign', 'A Sponsored Display campaign is born PAUSED'], ['create-ad-campaign', 'Sponsored Brands campaigns are created on the Nexus screens'],
  ['create-ad-group', 'In a Sponsored Display campaign it creates an SD ad group'], ['add-product-ads', 'In a Sponsored Display ad group'],
  ['add-ad-targets', 'For an ad group of a Sponsored Display campaign it takes sdTargets'],
  ['set-campaign-budget', 'Sponsored Brands'], ['set-target-bid', 'Sponsored Brands'], ['bulk-ad-bid-change', 'Sponsored Brands'],
  ['pause-ads', 'Sponsored Brands'], ['enable-ads', 'Sponsored Brands'], ['add-negative-targets', 'Sponsored Brands'],
  ['retire-negatives', 'which Amazon never lets be added to that campaign again'],
  ['set-hourly-bid-plan', 'A plan a person made or last changed changes by rule only where the business allowed it'],
  ['enable-ads', 'it never runs by rule'],
  ['platform-health-checks', 'Read it first in a daily run'], ['platform-health-checks', 'the watchdog itself did not run'],
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

  it('A2 — the ad reads (T4: and the eBay ad details; Google Ads 1b: the Google ad details) are offered to Claude as reads: nexus.read, closed world, ads.view', () => {
    const reads = ['ads-overview', 'ad-campaigns', 'ad-targets', 'ad-purchased-products', 'ad-search-terms', 'ad-changes', 'ad-recommendations', 'ebay-ad-details', 'google-ad-details']
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
    // Meta ads step 10 (review A2) — and meta-ad-preview: its links are public, and the in-app chat keeps tool results.
    // Meta ads step 14 — and meta-leads, meta-comments: people's data is never kept in an in-app run.
    expect(listTools().filter((tool) => !offeredOn(tool, 'app')).map((tool) => tool.name).sort()).toEqual(['confirm-change', 'meta-ad-preview', 'meta-comments', 'meta-leads', 'report-ads-run'])
  })
})

describe('C3 — the server and every change tool name the business', () => {
  const business = { id: 'ws-1', name: 'Xavia Racing' }

  it('the server title and the instructions name it', () => {
    expect(mcpServerInfo(business)).toMatchObject({ name: 'nexus', title: 'Nexus — Xavia Racing' })
    expect(mcpInstructions(business)).toContain('This connection works in the business "Xavia Racing" only')
    expect(mcpInstructions(business)).toContain('business: "Xavia Racing"')
    for (const rule of HARD_RULES) expect(mcpInstructions(business), rule).toContain(rule)
  })

  it('every Amazon ads, harvest and Google tool the instructions once listed is registered and offered to Claude: its own description, which Claude always gets in full, says what it does', () => {
    const tools = new Map(listTools().map((tool) => [tool.name, tool]))
    // W4-14 (Wave 4 Amazon ads), HMCP (the harvest engine), the ads brain, G13 (Google reads and builds).
    for (const name of ['ad-hourly-plans', 'set-hourly-bid-plan', 'enable-ads', 'ad-portfolios', 'set-portfolio', 'set-campaign-settings',
      'add-ad-targets', 'add-negative-targets', 'retire-negatives', 'harvest-search-term', 'set-harvest-destination', 'ad-groups',
      'create-ad-group', 'add-product-ads', 'set-ad-group', 'ad-budgets', 'set-monthly-ad-budget', 'set-budget-schedule', 'set-budget-pool',
      'restore-budget-baselines', 'assign-ad-rules', 'set-coverage-set', 'run-ad-engine-now', 'ad-recommendations', 'apply-ad-recommendations',
      'mute-ad-recommendations', 'replicate-ad-structure',
      'harvest-candidates', 'harvest-destinations', 'apply-harvest', 'harvest-history', 'skip-harvest-terms', 'graduate-keyword',
      'harvest-rules', 'set-harvest-rules', 'harvest-sources', 'set-harvest-sources',
      'bid-brain', 'set-bid-brain-enrollment', 'ads-brain', 'apply-brain-harvest', 'apply-brain-hourly-plan', 'set-ads-brain',
      'set-brain-kill-switch', 'retire-ads-writers', 'ads-playbook', 'set-ads-playbook', 'undo-worse-ad-change',
      'google-ad-details', 'google-ads-live', 'google-ads-numbers', 'google-ads-query', 'google-ads-experiments', 'google-merchant-live',
      'check-google-ads-build', 'create-google-demand-gen-campaign', 'create-google-display-campaign', 'create-google-app-campaign']) {
      const tool = tools.get(name)
      expect(tool, name).toBeDefined()
      expect({ name, offered: offeredOn(tool!, 'mcp') }).toEqual({ name, offered: true })
    }
  })

  it('what left the instructions is said in the named tool\'s own description, so nothing is lost', () => {
    const description = (name: string) => listTools().find((tool) => tool.name === name)?.description ?? ''
    for (const [name, said] of MOVED_TO_DESCRIPTIONS) expect(description(name), `${name}: ${said}`).toContain(said)
    // The ads brain's map names every view, in the tool's own order (a new view cannot be left out).
    const brain = description('ads-brain')
    const at = BRAIN_MAP_VIEWS.map((view) => brain.indexOf(`view ${view}`))
    expect(at.every((index) => index >= 0), `${BRAIN_MAP_VIEWS.join(', ')}`).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect([...BRAIN_MAP_VIEWS]).toEqual(['map', 'clashes', 'setup', 'money', 'terms', 'state', 'hours', 'negatives', 'harvest', 'report', 'structure', 'bidding', 'retire', 'proof'])
    // "Never by rule": every Google Ads and Merchant Center change tool says so itself.
    const google = listTools().filter((tool) => !tool.readOnly && /google/.test(tool.name))
    expect(google.length).toBeGreaterThan(0)
    for (const tool of google) expect(tool.description, tool.name).toMatch(/never (?:run )?by (?:a )?rule/)
  })

  it('G13 — the Google part names every change Google cannot check first, and the builds that are one call, from the tools themselves', () => {
    const text = mcpInstructions(business)
    const tools = listTools()
    const registered = new Set(tools.map((tool) => tool.name))
    const named = (name: string) => expect(text, name).toMatch(new RegExp(`(^|[^a-z-])${name}([^a-z-]|$)`))
    for (const name of ['set-google-status', 'build-google-campaigns', 'copy-google-campaign', 'build-google-pmax', 'copy-google-pmax']) {
      expect(registered.has(name), name).toBe(true)
      named(name)
    }
    // A Google Ads change whose description says Google cannot check it (or some of its actions) first is named.
    const unchecked = tools.filter((tool) => !tool.readOnly
      && (tool.description.endsWith(GOOGLE_UNCHECKED_CHANGE_RULES) || tool.description.endsWith(GOOGLE_PARTLY_CHECKED_RULES)))
    expect(unchecked.map((tool) => tool.name).sort()).toEqual(['apply-google-recommendations', 'dismiss-google-recommendations',
      'enable-google-pmax-brand-guidelines', 'set-google-account-links', 'set-google-billing', 'set-google-user-access'])
    for (const tool of unchecked) named(tool.name)
    // No Merchant Center write can be checked first: they are all set-google-merchant-…, named as one family.
    const merchant = tools.filter((tool) => tool.description.endsWith(MERCHANT_CHANGE_RULES))
    expect(merchant.length).toBeGreaterThan(0)
    for (const tool of merchant) expect(tool.name, tool.name).toMatch(/^set-google-merchant-/)
    expect(text).toContain('set-google-merchant-…: their preview says so')
    // Every create-google-…-campaign builds its ad groups and ads in ONE request, as the instructions say.
    for (const name of ['create-google-demand-gen-campaign', 'create-google-display-campaign', 'create-google-app-campaign']) {
      expect(registered.has(name), name).toBe(true)
      expect(tools.find((tool) => tool.name === name)!.description, name).toContain('ONE request')
    }
    expect(text).toContain('create-google-…-campaign), never steps of a change plan')
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

describe('4,096 — Claude Code and the claude.ai connector keep only the first 4,096 characters of the instructions', () => {
  // The longest business name the instructions must carry whole, twice: 80 characters (a made-up name, no real business).
  const longest = { id: 'ws-long', name: 'B'.repeat(80) }

  it('the whole text fits, with an 80-character business name: nothing is cut, and it ends on a whole sentence', () => {
    const text = mcpInstructions(longest)
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_LIMIT)
    const kept = text.slice(0, INSTRUCTIONS_LIMIT)
    expect(kept).toBe(text)
    expect(kept).toMatch(/\.$/)
  })

  it('every hard rule ends before character 4,096', () => {
    const text = mcpInstructions(longest)
    expect(text).toContain(`This connection works in the business "${longest.name}" only`)
    expect(text).toContain(`business: "${longest.name}"`)
    for (const rule of HARD_RULES) {
      const at = text.indexOf(rule)
      expect(at, rule).toBeGreaterThanOrEqual(0)
      expect(at + rule.length, rule).toBeLessThanOrEqual(INSTRUCTIONS_LIMIT)
    }
  })
})
