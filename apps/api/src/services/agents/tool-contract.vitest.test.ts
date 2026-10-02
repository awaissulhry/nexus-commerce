/**
 * MCP full control C1 — the tool contract (plan section 05 §3.7), held for every registered tool.
 *
 * Rules 1–7, where code can check them:
 *   1. name kebab-case `verb-noun`; a short title; a change tool's description says it waits for a person.
 *   2. `requires` names real permissions (ai.run is added by the door).
 *   3. `input` is a zod object; every argument is described; every list is bounded (≤ 250); a `channel`
 *      argument is an enum; NO argument names a business or workspace — the business comes from the caller.
 *   4. `readOnly` is honest (a read cannot execute and carries no change contract); a change tool states
 *      `openWorld` either way.
 *   5. `restrictedFields` name real money permissions.
 *   6. `surfaces`, when set, name real surfaces.
 *   7. a change tool states `reversibility` and `maxClaudeTrust`; an irreversible one is `ask` at most; `auto`
 *      needs limits with defaults and a `withinLimits` check; an executable one has MATERIAL_PREVIEW_FIELDS.
 *
 * Each rule is also run against a tool built to break it, so a check that cannot fail is caught here.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isValidPermission } from '@nexus/shared/permissions'
import { listTools } from './tool-registry.js'
import { inputJsonSchema } from './tool-loop.service.js'
import { MATERIAL_PREVIEW_FIELDS } from '../agent-fleet/approval-inbox.service.js'
import { CLAUDE_TRUST_LEVELS, type AgentTool } from './tool-types.js'

const MAX_LIST = 250
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/
const REVERSIBILITY = ['full', 'partial', 'none']
const SURFACES = ['app', 'mcp']
/**
 * C2 — executable tools that can be put back but whose inverse is not built yet: each with the part that builds it.
 * A ratchet: a new tool starts at zero, and an entry whose tool gains an undo must be removed (checked below).
 */
const UNDO_PENDING: Record<string, string> = {
  'bulk-attribute-change': 'putting back different values per product needs a change plan (C6) or a per-product attribute tool',
  'merge-duplicate-products': 'restoring the duplicate from the trash (and moving an adopted listing back) is a person\'s step in Nexus until a restore tool exists (identity, section 04)',
}

/** An argument that would let a caller pick (or name) a business: never, the business is the caller's. */
const BUSINESS_ARGUMENT = /^(business|workspace|tenant|profile)(id|name|_id)?$|^(businessid|workspaceid|tenantid)$/i

type JsonSchema = Record<string, unknown>

function arraysOf(schema: unknown, path: string, out: Array<{ path: string; maxItems: unknown }>) {
  if (!schema || typeof schema !== 'object') return out
  const node = schema as JsonSchema
  if (node.type === 'array') out.push({ path, maxItems: node.maxItems })
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value as JsonSchema)) arraysOf(child, `${path}.${name}`, out)
    } else if (Array.isArray(value)) value.forEach((child, i) => arraysOf(child, `${path}[${i}]`, out))
    else if (value && typeof value === 'object') arraysOf(value, `${path}.${key}`, out)
  }
  return out
}

function propertyNames(schema: unknown, out: string[] = []): string[] {
  if (!schema || typeof schema !== 'object') return out
  for (const [key, value] of Object.entries(schema as JsonSchema)) {
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value as JsonSchema)) {
        out.push(name)
        propertyNames(child, out)
      }
    } else if (Array.isArray(value)) value.forEach((child) => propertyNames(child, out))
    else if (value && typeof value === 'object') propertyNames(value, out)
  }
  return out
}

/** Every rule this file holds, for one tool: an empty list means it keeps the contract. */
function contractProblems(tool: AgentTool, material: Record<string, string[]> = MATERIAL_PREVIEW_FIELDS): string[] {
  const problems: string[] = []
  const bad = (rule: number, what: string) => problems.push(`${tool.name} — rule ${rule}: ${what}`)
  const change = !tool.readOnly

  // 1 — names and words
  if (!KEBAB.test(tool.name)) bad(1, 'name is not kebab-case verb-noun')
  if (!tool.title?.trim() || tool.title.length > 40) bad(1, 'title missing or longer than 40')
  if (!tool.description?.trim()) bad(1, 'no description')
  if (change && !/approv|a person/i.test(tool.description)) bad(1, 'a change tool must say it waits for approval')

  // 2 — permissions
  if (!tool.requires?.length || !tool.requires.every(isValidPermission)) bad(2, 'requires an unknown permission')

  // 3 — arguments
  if (!(tool.input instanceof z.ZodObject)) bad(3, 'input is not a zod object')
  else {
    const schema = inputJsonSchema(tool) as { properties?: Record<string, JsonSchema> }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (typeof property.description !== 'string' || !property.description.trim()) bad(3, `argument ${name} has no describe()`)
      if (name.toLowerCase() === 'channel' && !Array.isArray(property.enum)) bad(3, 'channel is not an enum')
    }
    for (const list of arraysOf(schema, 'input', [])) {
      if (typeof list.maxItems !== 'number' || list.maxItems > MAX_LIST) bad(3, `${list.path} is not bounded to ${MAX_LIST}`)
    }
    for (const name of propertyNames(schema)) {
      if (BUSINESS_ARGUMENT.test(name)) bad(3, `argument ${name} names a business; the business is the caller's`)
    }
  }

  // 4 — honest flags
  if (tool.readOnly) {
    if (tool.execute) bad(4, 'a read tool cannot execute')
    if (tool.reversibility || tool.maxClaudeTrust || tool.limits || tool.withinLimits || tool.undo) {
      bad(4, 'a read tool carries no change contract')
    }
  } else if (typeof tool.openWorld !== 'boolean') bad(4, 'a change tool must state openWorld (true when it reaches a marketplace or a buyer)')

  // 5 — money keys
  for (const [key, permission] of Object.entries(tool.restrictedFields ?? {})) {
    if (!permission.startsWith('financials.') || !isValidPermission(permission)) bad(5, `restricted field ${key} names no money permission`)
  }

  // 6 — surfaces
  if (tool.surfaces && (!tool.surfaces.length || !tool.surfaces.every((s) => SURFACES.includes(s)))) bad(6, 'unknown surface')

  // 7 — the change contract
  if (change) {
    if (!REVERSIBILITY.includes(tool.reversibility as string)) bad(7, 'reversibility missing')
    if (!CLAUDE_TRUST_LEVELS.includes(tool.maxClaudeTrust as never)) bad(7, 'maxClaudeTrust missing')
    if (tool.reversibility === 'none' && !['off', 'ask'].includes(tool.maxClaudeTrust as string)) {
      bad(7, 'an irreversible change is ask at most')
    }
    if (!!tool.limits !== !!tool.withinLimits) bad(7, 'limits and withinLimits come together')
    // A control tool is judged at the level of the tool it asks for (C5), so it carries no limits of its own.
    if (tool.maxClaudeTrust === 'auto' && !tool.withinLimits && !tool.control) bad(7, 'auto needs limits and withinLimits')
    if (tool.limits && !tool.limits.safeParse({}).success) bad(7, 'every limit needs a default (limits.parse({}))')
    if (tool.execute && !material[tool.name]?.length) bad(7, 'an executable tool needs MATERIAL_PREVIEW_FIELDS')
    // C2 — an executable change that can be put back says how (or is a reasoned pending entry).
    if (tool.execute && tool.reversibility !== 'none' && !tool.undo && !UNDO_PENDING[tool.name]) {
      bad(7, 'an executable change that is not irreversible needs an undo')
    }
    if (tool.undo && tool.reversibility === 'none') bad(7, 'an irreversible tool has no undo')
    // C2 — a control tool asks for changes through the gate and never runs one itself.
    if (tool.control && (tool.execute || tool.limits || tool.withinLimits)) bad(7, 'a control tool has no execute and no limits of its own')
  } else if (tool.control) bad(4, 'a control tool asks for changes: it is not readOnly')
  return problems
}

describe('C1 — every registered tool keeps the contract', () => {
  it('finds tools at all (a registry that resolves to nothing would pass)', () => {
    expect(listTools().length).toBeGreaterThan(20)
    expect(listTools().filter((tool) => !tool.readOnly).length).toBeGreaterThan(5)
  })

  it('rules 1–7 hold for every tool', () => {
    expect(listTools().flatMap((tool) => contractProblems(tool))).toEqual([])
  })

  it('reversibility, as the Approvals page reads it, for the tools that can run', () => {
    const byName = Object.fromEntries(listTools().filter((t) => t.execute).map((t) => [t.name, t.reversibility]))
    expect(byName).toMatchObject({
      'set-price': 'full',
      'apply-content': 'full',
      'bulk-price-change': 'full',
      'bulk-attribute-change': 'full',
      'set-content': 'full',
      'set-listing-content': 'full',
      'bulk-content-change': 'full',
      'set-shopify-content': 'full',
      'publish-listing': 'partial',
      'send-customer-message': 'none',
    })
  })

  it('C2 — the pending-undo list is exact: each entry is a real executable tool still without an undo', () => {
    for (const name of Object.keys(UNDO_PENDING)) {
      const tool = listTools().find((t) => t.name === name)
      expect(tool?.execute, `${name} is no longer an executable tool: remove it from UNDO_PENDING`).toBeTypeOf('function')
      expect(tool?.undo, `${name} has an undo now: remove it from UNDO_PENDING`).toBeUndefined()
    }
  })

  it('C2 — the undo of each undoable tool asks for a registered, executable tool', () => {
    const names = new Set(listTools().filter((t) => t.execute).map((t) => t.name))
    const sample: Record<string, { before: unknown; after: unknown }> = {
      'set-price': { before: { productId: 'p1', price: 10 }, after: { productId: 'p1', price: 12 } },
      'apply-content': { before: { productId: 'p1', title: 'Old', description: null }, after: { productId: 'p1', title: 'New', description: 'x' } },
      'bulk-price-change': { before: { prices: { p1: 10, p2: 20 } }, after: { prices: { p1: 11, p2: 22 } } },
      'set-master-prices': { before: { prices: { p1: 10 } }, after: { prices: { p1: 11 } } },
      'set-content': {
        before: { productId: 'p1', language: 'de', tier: 'language', fields: { title: { value: 'Alt' }, description: null, care_note: { value: 'x' } } },
        after: { productId: 'p1', language: 'de', tier: 'language', fields: { title: { value: 'Neu' }, description: { value: 'y' }, care_note: { value: 'z' } } },
      },
      'set-listing-content': {
        before: { productId: 'p1', coordinate: { channel: 'AMAZON', market: 'DE', accountId: 'a1', aliasKey: '' }, language: 'de',
          pins: { title: { value: 'Alt' }, description: null }, attributes: { attr_color: { value: 'Rot' }, attr_fit: null } },
        after: { productId: 'p1', coordinate: { channel: 'AMAZON', market: 'DE', accountId: 'a1', aliasKey: '' }, language: 'de',
          pins: { title: { value: 'Neu' }, description: { value: 'x' } }, attributes: { attr_color: { value: 'Schwarz' }, attr_fit: { value: 'Slim' } } },
      },
      'set-shopify-content': {
        before: { productId: 'p1', accountId: 'store', aliasKey: null, language: 'en', fields: { vendor: { value: 'Old', nexusDraft: true }, tags: { value: '["a"]', nexusDraft: false } } },
        after: { productId: 'p1', accountId: 'store', aliasKey: null, language: 'en', fields: { vendor: { value: 'New', nexusDraft: true }, tags: { value: '["b"]', nexusDraft: true } } },
      },
      'bulk-content-change': {
        before: { language: 'de', tier: 'language', products: { p1: { sku: 'S1', fields: { title: { value: 'Alt' } } }, p2: { sku: 'S2', fields: { description: null } } } },
        after: { language: 'de', tier: 'language', products: { p1: { sku: 'S1', fields: { title: { value: 'Neu' } } }, p2: { sku: 'S2', fields: { description: { value: 'x' } } } } },
      },
      // I10 — identity fixes.
      'set-product-sku': { before: { productId: 'p1', sku: 'OLD' }, after: { productId: 'p1', sku: 'NEW' } },
      'set-gtin': { before: { productId: 'p1', field: 'gtin', code: null }, after: { productId: 'p1', field: 'gtin', code: '4006381333931' } },
      'set-brand': { before: { brands: [{ productId: 'p1', brand: 'Old' }] }, after: { brands: [{ productId: 'p1', brand: 'New' }] } },
      'set-listing-sku': { before: { extraListingId: 'a1', sku: null }, after: { extraListingId: 'a1', sku: 'SKU-2' } },
      // I9 — unlink is undone by link (verified on the channel again), and link by unlink.
      'unlink-channel-id': { before: { listingId: 'l1', channel: 'EBAY', externalId: '510000000001' }, after: { listingId: 'l1', externalId: null } },
      'link-channel-id': { before: { listingId: 'l1', externalId: null }, after: { listingId: 'l1', externalId: '510000000001' } },
      // I11 — fix-parent puts the parent back (a merge is on UNDO_PENDING).
      'fix-parent': { before: { productId: 'p1', action: 'move', parentId: 'p0', isParent: false }, after: { productId: 'p1', parentId: 'p2', isParent: false } },
      // A4 — a bid change puts the old bid back through set-target-bid itself.
      'set-target-bid': { before: { targetId: 't1', bidCents: 45, changeSetId: 'ap1' }, after: { targetId: 't1', bidCents: 52 } },
      // A5 — a negative is retired by undo-ad-change; a graduated keyword goes to the floor through set-target-bid.
      'create-negative-keyword': { before: { changeSetId: 'ap1', negatives: [] }, after: { negatives: [{ targetId: 't9' }] } },
      'graduate-keyword': { before: { changeSetId: 'ap1', keyword: null }, after: { targetId: 't9', bidCents: 37 } },
      // A12 — the allowlist switch is set back through itself.
      'set-campaign-live-writes': { before: { campaignId: 'c1', enabled: false }, after: { campaignId: 'c1', enabled: true } },
      // A8 — a suppression is undone by a restore, a restore by a suppression.
      'suppress-campaign': { before: { campaignId: 'c1', suppressed: false, by: null, changeSetId: 'ap1' }, after: { campaignId: 'c1', suppressed: true, by: 'user:u1' } },
      'restore-campaign': { before: { campaignId: 'c1', suppressed: true, by: 'user:u1', changeSetId: 'ap1' }, after: { campaignId: 'c1', suppressed: false, by: null } },
      // A7 — a bulk bid change is reversed as one change set by undo-ad-change.
      'bulk-ad-bid-change': { before: { changeSetId: 'ap1', bids: { t1: 30 } }, after: { bids: { t1: 35 } } },
      // A6 — a budget or the placement adjustments are set back through the same tool.
      'set-campaign-budget': { before: { campaignId: 'c1', dailyBudgetCents: 2000, changeSetId: 'ap1' }, after: { campaignId: 'c1', dailyBudgetCents: 2500 } },
      'set-placement-multipliers': {
        before: { campaignId: 'c1', placements: { topOfSearchPct: 50, productPagesPct: null, restOfSearchPct: null }, changeSetId: 'ap1' },
        after: { campaignId: 'c1', placements: { topOfSearchPct: 80, productPagesPct: null, restOfSearchPct: null } },
      },
      // L6 — drafts started and removed; a listing's own attribute set (one followed the product before).
      'create-draft-listings': { before: { listings: [] }, after: { coordinate: { channel: 'EBAY', market: 'IT', accountId: 'a1' }, listings: [{ id: 'l1', version: 1 }] } },
      'remove-draft-listings': { before: { listings: [{ id: 'l1' }] },
        after: { coordinates: [{ rootId: 'p1', productIds: ['p1'], channel: 'EBAY', market: 'IT', accountId: 'a1', aliasKey: '' }], present: [] } },
      'set-listing-fields': {
        before: { coordinate: { productId: 'p1', rootId: 'p1', sku: 'S-1', channel: 'EBAY', market: 'IT', accountId: 'a1', aliasKey: '' }, kind: 'values',
          values: { attr_color: { value: 'Red', own: true }, attr_size: { value: 'M', own: false } } },
        after: { coordinate: { productId: 'p1' }, kind: 'values', values: {} },
      },
      // MCP full control P7 — organizing changes.
      'set-product-tags': { before: { productId: 'p1', sku: 'TEST-SKU-1', tags: ['Sale'] }, after: { productId: 'p1', tags: ['Outlet', 'Sale'] } },
      'move-workflow-stage': { before: { productId: 'p1', sku: 'TEST-SKU-1', stageId: 's1', stage: 'Draft' }, after: { productId: 'p1', stageId: 's2' } },
      'save-view': {
        before: { savedViewId: 'v1', view: { name: 'Mine', filters: { search: 'x' }, alert: { comparison: 'GT', threshold: 3, cooldownMinutes: 60, active: true } } },
        after: { savedViewId: 'v1', view: { name: 'Renamed', filters: { search: 'x' }, alert: { comparison: 'GT', threshold: 3, cooldownMinutes: 60, active: false } } },
      },
      'set-alert-rule': {
        before: { ruleId: 'r1', name: 'Queue deep', description: null, metric: 'queueDepth', operator: 'gt', threshold: 100, windowMinutes: 15, channel: null, enabled: true },
        after: { ruleId: 'r1', name: 'Queue deep', description: null, metric: 'queueDepth', operator: 'gt', threshold: 150, windowMinutes: 15, channel: null, enabled: true },
      },
      'acknowledge-alerts': {
        before: { events: { e1: { status: 'TRIGGERED', acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, notes: null } }, notifications: { n1: null } },
        after: { events: { e1: { status: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-01T10:00:00.000Z', acknowledgedBy: 'Olga', resolvedAt: null, resolvedBy: null, notes: null } }, notifications: { n1: '2026-10-01T10:00:00.000Z' } },
      },
      'organize-image-library': {
        before: { assets: { a1: { label: 'Front', folderId: null, tagIds: [] } } },
        after: { assets: { a1: { label: 'Front', folderId: 'f1', tagIds: ['t1'] } } },
      },
      // MCP full control P8 — structure changes.
      'save-attribute': {
        before: { kind: 'attribute', id: 'a1', code: 'fit', label: 'Fit', description: null, groupId: 'g1', type: 'text', localizable: false, scope: 'global', sortOrder: 0 },
        after: { kind: 'attribute', id: 'a1', code: 'fit', label: 'Cut', description: null, groupId: 'g1', type: 'text', localizable: false, scope: 'global', sortOrder: 0 },
      },
      'save-product-family': {
        before: { id: 'f1', code: 'jackets', label: 'Jackets', description: null, parentFamilyId: null, attributes: [] },
        after: { id: 'f1', code: 'jackets', label: 'Jackets', description: null, parentFamilyId: null, attributes: [{ attributeId: 'a1', required: true, channels: [], sortOrder: 0 }] },
      },
      'save-category': { before: { id: 'c1', name: 'Boots', slug: 'boots', code: null, parentId: 'c0' }, after: { id: 'c1', name: 'Boots', slug: 'boots', code: null, parentId: null } },
      'save-channel-mapping': { before: { channel: 'EBAY', market: 'IT', kind: 'rules', token: 't1', restoreRevisionId: 'rev-1', fields: ['title'] }, after: { channel: 'EBAY', market: 'IT', token: 't2' } },
      'save-listing-template': { before: { kind: 'description-theme', themeId: 'th1', name: 'Classic', notes: null, active: true, html: '<div>{{body}}</div>', version: 3 }, after: { kind: 'description-theme', themeId: 'th1', name: 'Classic', notes: null, active: true, htmlHash: 'h', version: 4 } },
      // MCP full control P10 — the business's settings.
      'set-business-settings': { before: { companyName: 'Old Srl', primaryMarketplace: 'IT' }, after: { companyName: 'New Srl', primaryMarketplace: 'DE' } },
      // R10 — a level move: undo is the opposite move to the level it replaced.
      'turn-up-automation': { before: { automation: 'ads-rules', rowId: 'r1', name: 'Rule', level: 'OBSERVE' }, after: { automation: 'ads-rules', rowId: 'r1', name: 'Rule', level: 'PROPOSE' } },
      'turn-down-automation': { before: { automation: 'ads-dial', rowId: null, name: 'Dial', level: 'PROPOSE' }, after: { automation: 'ads-dial', rowId: null, name: 'Dial', level: 'OFF' } },
      // R12 — a stop is undone by a resume of exactly what it stopped, and the other way round.
      'stop-automation': { before: { area: 'rules', domain: 'replenishment', ruleIds: ['r1'], halted: false }, after: { area: 'rules', domain: 'replenishment', ruleIds: ['r1'], halted: true } },
      'resume-automation': { before: { area: 'amazon-ads', halted: true }, after: { area: 'amazon-ads', halted: false } },
      // R13 — a raised ceiling: undo sets it back.
      'set-ad-guardrail': { before: { kind: 'spend-ceiling', key: { grain: 'MARKET', scopeId: 'IT' }, row: { label: 'Italy', dailyCapCents: 5000, enabled: true, note: null } }, after: { kind: 'spend-ceiling', key: { grain: 'MARKET', scopeId: 'IT' }, row: { label: 'Italy', dailyCapCents: 9000, enabled: true, note: null } } },
      // R14 — a raised pool budget: undo sets it back; a harvest scope given its own policy inherits again.
      'tune-ad-engine': {
        before: { setting: 'budget-pool', subjectId: 'p1', name: 'Pool', state: { totalDailyBudgetCents: 5000, strategy: 'STATIC', coolDownMinutes: 60, maxShiftPerRebalancePct: 20 } },
        after: { setting: 'budget-pool', subjectId: 'p1', name: 'Pool', state: { totalDailyBudgetCents: 7000, strategy: 'STATIC', coolDownMinutes: 60, maxShiftPerRebalancePct: 20 } },
      },
      // R15 — a worker paused: undo resumes it.
      'steer-fleet': {
        before: { steer: 'charter', charterKey: 'amazon-bid-tuner', name: 'Bid tuner', level: 'OBSERVE', cap: 'OBSERVE', pausedUntil: null, pausedReason: null },
        after: { steer: 'charter', charterKey: 'amazon-bid-tuner', name: 'Bid tuner', level: 'OBSERVE', cap: 'OBSERVE', pausedUntil: '2999-01-01T00:00:00.000Z', pausedReason: 'test' },
      },
      // R17 — an edited repricing rule: undo saves it as it was.
      'save-price-rule': {
        before: { priceRuleId: 'r1', productId: 'p1', sku: 'TEST-SKU-1', channel: 'EBAY', marketplace: 'IT', enabled: false, minPrice: 10, maxPrice: 20, strategy: 'match_buy_box', beatPct: null, beatAmount: null, activeFromHour: null, activeToHour: null, activeDays: [], notes: null },
        after: { priceRuleId: 'r1', productId: 'p1', sku: 'TEST-SKU-1', channel: 'EBAY', marketplace: 'IT', enabled: false, minPrice: 12, maxPrice: 20, strategy: 'match_buy_box', beatPct: null, beatAmount: null, activeFromHour: null, activeToHour: null, activeDays: [], notes: null },
      },
      // R18 — an edited operations rule: undo saves it as it was.
      'save-ops-rule': {
        before: { domain: 'replenishment', opsRuleId: 'r1', name: 'Restock', description: null, trigger: 'cron_tick', conditions: [{ field: 'product.sku', op: 'eq', value: 'TEST-SKU-1' }], actions: [{ type: 'notify' }], maxExecutionsPerDay: 5, maxValueCentsEur: 100 },
        after: { domain: 'replenishment', opsRuleId: 'r1', name: 'Restock', description: 'edited', trigger: 'cron_tick', conditions: [{ field: 'product.sku', op: 'eq', value: 'TEST-SKU-1' }], actions: [{ type: 'notify' }], maxExecutionsPerDay: 5, maxValueCentsEur: 100 },
      },
      // R11 — dismissed suggestions: undo restores them.
      'decide-automation-suggestions': { before: { kind: 'amazon-ads', items: [{ id: 's1', status: 'pending' }] }, after: { kind: 'amazon-ads', items: [{ id: 's1', status: 'dismissed' }] } },
      // R9 — an edit of a rule: undo saves the rule as it was.
      'save-ad-rule': {
        before: { kind: 'amazon-ads', ruleId: 'r1', name: 'Rule', description: null, trigger: 'KEYWORD_HIGH_ACOS', conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.6 }], actions: [{ type: 'bid_down', percent: 5 }], scope: { marketplace: 'IT' }, caps: { maxExecutionsPerDay: 5, maxWritesPerDay: 5, maxValueCentsEur: 100, maxDailyAdSpendCentsEur: null } },
        after: { kind: 'amazon-ads', ruleId: 'r1', name: 'Rule', description: null, trigger: 'KEYWORD_HIGH_ACOS', conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.5 }], actions: [{ type: 'bid_down', percent: 5 }], scope: { marketplace: 'IT' }, caps: { maxExecutionsPerDay: 5, maxWritesPerDay: 5, maxValueCentsEur: 100, maxDailyAdSpendCentsEur: null } },
      },
      // 07 O7 — the order desk's changes.
      'update-order': { before: { orderId: 'o1', tags: ['a'] }, after: { orderId: 'o1', noteId: 'n1', tags: ['a', 'b'] } },
      'update-customer': { before: { customerId: 'c1', tags: [], manualReview: 'NONE' }, after: { customerId: 'c1', tags: ['x'], manualReview: 'APPROVED' } },
      'triage-reviews': {
        before: { reviews: [{ reviewId: 'r1', status: 'NONE', assignee: null, tags: [], note: null }] },
        after: { reviews: [{ reviewId: 'r1', status: 'RESOLVED', assignee: 'Ops', tags: ['x'], note: 'done' }] },
      },
      // 07 O8 — shipments and labels.
      'create-shipments': { before: { orderIds: ['o1'] }, after: { shipmentIds: ['s1'] } },
      'update-shipment': {
        before: { shipments: [{ shipmentId: 's1', action: 'hold', status: 'DRAFT', heldReason: null, carrierCode: 'SENDCLOUD', serviceCode: null, serviceName: null }] },
        after: { shipments: [{ shipmentId: 's1', status: 'ON_HOLD', heldReason: 'x', carrierCode: 'SENDCLOUD', serviceCode: null, serviceName: null }] },
      },
      'buy-shipping-label': { before: { shipments: [{ shipmentId: 's1', status: 'PACKED' }] }, after: { shipments: [{ shipmentId: 's1', status: 'LABEL_PRINTED', carrier: 'SENDCLOUD', trackingNumber: 't', parcel: '1' }], returns: [] } },
      'void-shipping-label': { before: { shipments: [{ shipmentId: 's1', status: 'LABEL_PRINTED' }] }, after: { shipments: [{ shipmentId: 's1', status: 'PACKED' }] } },
      // 07 O12 — returns (undo rejects a REQUESTED return; puts a warranty diagnosis back).
      'create-return': { before: { orderId: 'o1', returnId: null }, after: { returnId: 'r1', rmaNumber: 'RMA-1', status: 'REQUESTED' } },
      'update-return': {
        before: { returns: [{ returnId: 'r1', action: 'warranty', rmaNumber: 'RMA-1', status: 'RECEIVED', warrantyStatus: 'PENDING_DIAGNOSIS', warrantyResolution: null, manufacturerRef: null }] },
        after: { returns: [{ returnId: 'r1', rmaNumber: 'RMA-1', status: 'RECEIVED', warrantyStatus: 'DIAGNOSED', warrantyResolution: 'REPAIR', manufacturerRef: 'M-1' }] },
      },
      // 08 S6 — stock changes.
      'set-stock': { before: { items: [{ productId: 'p1', sku: 'S1', location: 'IT-MAIN', quantity: 5 }] }, after: { items: [{ productId: 'p1', location: 'IT-MAIN', quantity: 7 }] } },
      'transfer-stock': { before: { items: [{ productId: 'p1', sku: 'S1', from: 'A', to: 'B', quantity: 2 }] }, after: { transfers: [{ productId: 'p1', from: 'A', to: 'B', quantity: 2 }] } },
      'stock-count': { before: { action: 'record', countId: 'c1', counts: [{ productId: 'p1', sku: 'S1', counted: 4 }] }, after: { countId: 'c1', counts: [{ productId: 'p1', counted: 5 }] } },
      'reconcile-stock-count': { before: { countId: 'c1', items: [{ productId: 'p1', sku: 'S1', location: 'IT-MAIN', quantity: 5 }] }, after: { items: [{ productId: 'p1', location: 'IT-MAIN', quantity: 4 }] } },
      'reserve-stock': { before: { action: 'reserve', productId: 'p1', sku: 'S1', location: 'IT-MAIN', quantity: 2, reason: 'MANUAL_HOLD' }, after: { reservationId: 'r1', active: true } },
      'set-stock-location': { before: { action: 'rename', code: 'IT-B', name: 'Old' }, after: { code: 'IT-B', name: 'New' } },
      'set-stock-source': { before: { products: [{ productId: 'p1', sku: 'S1', source: 'own', lender: null }] }, after: { products: [{ productId: 'p1', source: 'pool', lender: 'Lender' }] } },
      // 08 S7 — Sync Control: a pause is resumed on the same listings; a policy is set back through itself.
      'bulk-listing-stock': { before: { action: 'PAUSE', listings: [{ listingId: 'l1', sku: 'S1', syncPaused: false, follows: true, quantity: 4, stockBuffer: 0 }], shared: [] }, after: { action: 'PAUSE', listings: [{ listingId: 'l1', syncPaused: true }], shared: [] } },
      'set-stock-policy': { before: { kind: 'policy', channel: 'EBAY', marketplace: 'IT', accountId: null, pushesPaused: false, newListingDefaultMode: 'FOLLOW' }, after: { kind: 'policy', channel: 'EBAY', marketplace: 'IT', accountId: null, pushesPaused: true, newListingDefaultMode: 'FOLLOW' } },
      // 08 S11 — a floor and ceiling set back through itself; listing prices back to their own price (or the master).
      'set-price-bounds': { before: { items: [{ productId: 'p1', sku: 'S1', minPrice: null, maxPrice: 50 }] }, after: { items: [{ productId: 'p1', minPrice: 10, maxPrice: 50 }] } },
      'bulk-listing-price-change': { before: { prices: [{ listingId: 'l1', sku: 'S1', price: 20 }, { listingId: 'l2', sku: 'S2', price: null }] }, after: { prices: [{ listingId: 'l1', price: 21 }, { listingId: 'l2', price: 22 }] } },
      // 08 S12 — pricing records.
      'set-pricing-rule': { before: { action: 'update', ruleId: 'r1', fields: { priority: 3 } }, after: { ruleId: 'r1', fields: { priority: 5 } } },
      'set-promotion': { before: { action: 'create', name: 'Spring' }, after: { promotionId: 'e1', isActive: true } },
      'schedule-price-change': { before: { action: 'create', productId: 'p1', sku: 'S1' }, after: { scheduledChangeId: 's1', status: 'PENDING' } },
      // 08 S9 — suppliers and purchase orders.
      'upsert-supplier': { before: { action: 'update', supplierId: 'sup1', fields: { leadTimeDays: 14 }, products: [{ productId: 'p1', row: { costCents: 900, moq: 1, isPrimary: false } }, { productId: 'p2', row: null }] }, after: { supplierId: 'sup1', fields: { leadTimeDays: 21 }, products: [] } },
      // 08 S13 — tier prices (an eBay promotion and an FBA plan cannot be undone from Nexus).
      'set-tier-prices': { before: { productId: 'p1', sku: 'S1', tiers: [{ minQty: 5, customerGroup: null, price: 9 }] }, after: { productId: 'p1', tiers: [{ minQty: 5, customerGroup: null, price: 8 }] } },
      // 08 S10 — receiving, inbound shipments, costs, replenishment.
      'receive-stock': { before: { shipmentId: 's1', items: [{ productId: 'p1', sku: 'S1', location: 'IT-MAIN', quantity: 5 }] }, after: { items: [{ productId: 'p1', location: 'IT-MAIN', quantity: 8 }] } },
      'update-inbound-shipment': { before: { action: 'details', shipmentId: 's1', fields: { trackingNumber: null }, lineCosts: [] }, after: { shipmentId: 's1', fields: { trackingNumber: 'T1' }, lineCosts: [] } },
      'set-product-costs': { before: { mode: 'costs', costs: [{ productId: 'p1', sku: 'S1', costPrice: 4 }] }, after: { costs: [{ productId: 'p1', costPrice: 5 }] } },
      'replenishment-action': { before: { action: 'dismiss', productIds: ['p1'] }, after: { action: 'dismiss', recs: [{ id: 'r1', status: 'DISMISSED' }] } },
      'draft-purchase-order': { before: { action: 'edit', purchaseOrderId: 'po1', lines: [{ productId: 'p1', sku: 'S1', supplierSku: null, quantity: 4, unitCostCents: 900 }], header: { notes: null } }, after: { purchaseOrderId: 'po1', version: 2 } },
      // A14 — eBay: rates and a budget go back through the same tool; a promotion is lowered to eBay's 2% minimum
      // (an ad is never removed); keyword bids go back and added keywords go to the floor.
      'set-ebay-ad-rates': { before: { ebayCampaignId: 'e1', rates: { '110000000001': 6 }, changeSetId: 'ap1' }, after: { ebayCampaignId: 'e1', rates: { '110000000001': 8 } } },
      'promote-ebay-listings': { before: { ebayCampaignId: 'e1', promoted: [], changeSetId: 'ap1' }, after: { ebayCampaignId: 'e1', rates: { '110000000001': 5 } } },
      'set-ebay-campaign-budget': { before: { ebayCampaignId: 'e1', dailyBudgetCents: 1000, changeSetId: 'ap1' }, after: { ebayCampaignId: 'e1', dailyBudgetCents: 1500 } },
      'ebay-keywords-change': { before: { ebayCampaignId: 'e1', bids: { k1: 40 }, changeSetId: 'ap1' }, after: { ebayCampaignId: 'e1', bids: { k1: 55, k2: 30 }, added: ['k2'], negatives: 1 } },
      // L7 — products created (parent and a variation), and products binned.
      'create-product': { before: { products: [] }, after: { products: [{ id: 'p1', deleted: false }, { id: 'p2', deleted: false }] } },
      'create-variations': { before: { products: [] }, after: { products: [{ id: 'p3', deleted: false }] } },
      'discard-new-products': { before: { restore: true, products: [{ id: 'p1', deleted: false }] }, after: { restore: false, products: [{ id: 'p1', deleted: true }] } },
      // L10 — a photo edit is put back by its own inverse ops at the same layer.
      'arrange-photos': { before: { productId: 'p1', address: { layer: 'SHARED' }, revision: 1, undo: [{ op: 'axis', axis: null }] }, after: { productId: 'p1', address: { layer: 'SHARED' }, revision: 2 } },
      // L9 — a close and a reopen are each other's undo; a first publish is undone by closing its listings.
      'close-listing': { before: { listingIds: ['l1'], closed: false }, after: { listingIds: ['l1'], closed: true } },
      'reopen-listing': { before: { listingIds: ['l1'], closed: true }, after: { listingIds: ['l1'], closed: false } },
      // L11 — a photo from a link is removed again while unused; a removal adds the stored file back.
      'add-photo-from-url': { before: { productId: 'p1', photoId: 'i1', url: 'https://res.example.test/p1/1.png', label: null, present: false }, after: { productId: 'p1', photoId: 'i1', url: 'https://res.example.test/p1/1.png', label: null, present: true } },
      'remove-unused-photo': { before: { productId: 'p1', photoId: 'i1', url: 'https://res.example.test/p1/1.png', label: 'side', present: true }, after: { productId: 'p1', photoId: 'i1', url: 'https://res.example.test/p1/1.png', label: 'side', present: false } },
      'publish-listing': { before: { fields: [] }, after: { productId: 'p1', publicationId: 'pub1', publish: 'first publish', listingIds: ['l1', 'l2'], closed: false } },
      // L8 — a Matrix operation (reverted by revert-listing-change); a sale (set back by the price tool itself).
      'set-listing-stock': { before: { productId: 'p1', operationId: 'op1', changes: [] }, after: { productId: 'p1', operationId: 'op1', reverted: false } },
      'set-listing-price': { before: { kind: 'sale', productId: 'p1', sale: [{ rowId: 'r1', coordinateKey: 'AMAZON:IT', value: null, start: null, end: null }] },
        after: { kind: 'sale', productId: 'p1', sale: [{ rowId: 'r1', coordinateKey: 'AMAZON:IT', value: 8, start: '2026-11-01', end: '2026-11-30' }] } },
      // MCP full control P9 — an import; its undo re-imports the "before" record (rollback-bulk-operation).
      'import-catalog': { before: { jobId: 'j1', file: 'claude-import.csv', records: 2 }, after: { jobId: 'j1', changedSince: [] } },
    }
    const withUndo = listTools().filter((t) => t.undo)
    expect(withUndo.map((t) => t.name).sort()).toEqual(Object.keys(sample).sort())
    for (const tool of withUndo) {
      const request = tool.undo!.request(sample[tool.name])
      expect('tool' in request ? request.tool : request.refusal, tool.name).toSatisfy((t: string) => names.has(t))
      const parsed = 'tool' in request ? listTools().find((t) => t.name === request.tool)!.input.safeParse(request.args) : null
      expect(parsed?.success, `${tool.name}: its undo request parses as ${'tool' in request ? request.tool : '?'} arguments`).toBe(true)
    }
  })

  it('every limit schema has a default, and the default answers', () => {
    for (const tool of listTools().filter((t) => t.limits)) {
      const limits = tool.limits!.parse({}) as Record<string, unknown>
      expect(typeof tool.withinLimits!(null, limits), tool.name).toBe('string') // no preview is never inside limits
    }
  })
})

describe('C1 — each rule can fail', () => {
  const good: AgentTool = {
    name: 'set-example',
    title: 'Example',
    category: 'test',
    description: 'Changes an example in Nexus. Waits for a person to approve it.',
    riskTier: 'high',
    readOnly: false,
    openWorld: false,
    requires: ['products.edit'],
    input: z.object({ productId: z.string().describe('Nexus product id') }),
    reversibility: 'full',
    maxClaudeTrust: 'ask',
    handler: async () => ({ ok: true }),
  }
  const problemsOf = (patch: Partial<AgentTool>) => contractProblems({ ...good, ...patch } as AgentTool, {})

  it('a well-made tool passes', () => {
    expect(problemsOf({})).toEqual([])
  })

  it.each([
    [{ name: 'setExample' }, 'rule 1: name'],
    [{ description: 'Changes an example.' }, 'rule 1: a change tool must say'],
    [{ requires: ['products.fly'] as never }, 'rule 2'],
    [{ input: z.object({ productId: z.string() }) }, 'argument productId has no describe()'],
    [{ input: z.object({ ids: z.array(z.string()).describe('ids') }) }, 'input.ids is not bounded'],
    [{ input: z.object({ ids: z.array(z.string()).max(251).describe('ids') }) }, 'input.ids is not bounded'],
    [{ input: z.object({ channel: z.string().describe('channel') }) }, 'channel is not an enum'],
    [{ input: z.object({ workspaceId: z.string().describe('which business') }) }, 'argument workspaceId names a business'],
    [{ input: z.object({ business: z.string().describe('which business') }) }, 'argument business names a business'],
    [{ readOnly: true }, 'a read tool carries no change contract'],
    [{ readOnly: true, reversibility: undefined, maxClaudeTrust: undefined, execute: async () => ({ ok: true }) }, 'a read tool cannot execute'],
    [{ openWorld: undefined }, 'must state openWorld'],
    [{ surfaces: ['web' as never] }, 'unknown surface'],
    [{ reversibility: undefined }, 'reversibility missing'],
    [{ maxClaudeTrust: undefined }, 'maxClaudeTrust missing'],
    [{ reversibility: 'none', maxClaudeTrust: 'confirm' }, 'an irreversible change is ask at most'],
    [{ maxClaudeTrust: 'auto' }, 'auto needs limits'],
    [{ limits: z.object({ max: z.number() }), withinLimits: () => null }, 'every limit needs a default'],
    [{ limits: z.object({ max: z.number().default(1) }) }, 'limits and withinLimits come together'],
    [{ execute: async () => ({ ok: true }) }, 'needs MATERIAL_PREVIEW_FIELDS'],
    [{ execute: async () => ({ ok: true }) }, 'needs an undo'],
    [{ reversibility: 'none', undo: { current: async () => null, request: () => ({ refusal: 'x' }) } }, 'an irreversible tool has no undo'],
    [{ control: true, execute: async () => ({ ok: true }) }, 'a control tool has no execute'],
    [{ control: true, readOnly: true, reversibility: undefined, maxClaudeTrust: undefined }, 'a control tool asks for changes'],
  ] as Array<[Partial<AgentTool>, string]>)('%o breaks: %s', (patch, expected) => {
    expect(problemsOf(patch).join('\n')).toContain(expected)
  })
})
