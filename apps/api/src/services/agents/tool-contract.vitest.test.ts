/**
 * MCP full control C1 — the tool contract (plan section 05 §3.7), held for every registered tool.
 *
 * Rules 1–7, where code can check them:
 *   1. name kebab-case `verb-noun`; a short title; a change tool's description says it waits for a person — and, when
 *      its ceiling lets the business confirm it in Claude or run it by rule, never that it ALWAYS waits for a person in
 *      Nexus, nor that a person approves it in Nexus without the other way (in Claude; by rule); at `auto`, never that
 *      it always waits for, or needs, a person at all (N3, widened in AA-W2-1).
 *   2. `requires` names real permissions (ai.run is added by the door).
 *   3. `input` is a zod object; every argument is described; every list is bounded (≤ 250); a `channel`
 *      argument is an enum; NO argument names a business or workspace — the business comes from the caller.
 *   4. `readOnly` is honest (a read cannot execute and carries no change contract); a change tool states
 *      `openWorld` either way.
 *   5. `restrictedFields` name real money permissions.
 *   6. `surfaces`, when set, name real surfaces.
 *   7. a change tool states `reversibility` and `maxClaudeTrust`; `auto` needs limits with defaults and a
 *      `withinLimits` check; an executable one has MATERIAL_PREVIEW_FIELDS. ADS AUTONOMY AA-W2-1 (Owner D-W2-1 = A):
 *      7a `alwaysAsk` above `ask` only for a strategy-bound tool on AD_STRATEGY_AUTO (or one of ALWAYS_ASK_ABOVE_ASK,
 *         raised before W2) — outside the lists, `ask` at most;
 *      7b a strategy-bound tool has limits and refuses a preview without its strategy facts (`limitFacts`), and is a
 *         kind of ad action the ads strategy narrows; such a kind of ad action runs by rule only strategy-bound;
 *      7c an irreversible one is `ask` at most, unless it is strategy-bound, on IRREVERSIBLE_AUTO, and its DEFAULT
 *         limits refuse a sample preview that is inside the strategy (by default nothing permanent runs alone).
 *      7d ADS AUTONOMY W4-1 — a journal tool (runs at once, no approval: Claude's own record, no change of the business)
 *         is on JOURNAL_TOOLS, closed world, offered or not (ceiling ask), never alwaysAsk, strategy-bound or limited.
 *
 * Each rule is also run against a tool built to break it, so a check that cannot fail is caught here.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isValidPermission } from '@nexus/shared/permissions'
import { listTools } from './tool-registry.js'
import { inputJsonSchema } from './tool-loop.service.js'
import { MATERIAL_PREVIEW_FIELDS } from '../agent-fleet/approval-inbox.service.js'
import { actionOfTool, PLACES } from '../advertising/ads-strategy/claude.js'
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

/**
 * AA-W2-1 (Owner decision D-W2-1 = A, 2026-10-06) — the `alwaysAsk` tools that may be set above `ask`: strategy-bound
 * Amazon ad tools, each of which may run by rule only inside its own limits and the ads strategy (rule 7a). An exact
 * ratchet: adding a name is a reviewed change, and an entry whose tool is no longer alwaysAsk, strategy-bound and above
 * `ask` must be removed (checked below).
 */
const AD_STRATEGY_AUTO: readonly string[] = [
  'bulk-ad-bid-change', // AA-W2-6 — many bids, every row inside the ads strategy of its ad group
  // AA-W2-8 — a campaign's daily budget and its placement adjustments.
  'set-campaign-budget',
  'set-placement-multipliers',
  // AA-W2-9 — starting a stopped campaign again, and the live-write allowlist (on: only a campaign Claude created).
  'restore-campaign',
  'set-campaign-live-writes',
  // AA-W2-12 — a real pause, and switching back on what a Claude request paused.
  'pause-ads', 'enable-ads',
  // AA-W2-13 — an archive (irreversible: also on IRREVERSIBLE_AUTO), and a new campaign (D-W2-6: its own kind).
  'archive-ads', 'create-ad-campaign',
  // W3-3 — giving an ad group's bids back once its stock returns (it adds spend).
  'restore-ad-bids-after-stock',
  // PB-5a — a playbook build, the create kind: only at the floor and off the allowlist (nothing spends until START),
  // by default never by rule (maxCampaigns 0); an adopt writes Nexus links only. PB-5b — a start (restore and allowlist
  // kinds) needs the approver's code, by rule only with allowStart (off by default: a loosening needs the code); a stop
  // is a brake.
  'apply-ads-playbook',
  // B-3 — a one-off SP Super Wizard set, the create kind: only at the floor and off the allowlist (nothing spends until
  // restore-campaign), by default never by rule (maxCampaigns 0, no market).
  'build-sp-wizard-campaigns',
  // B-1 — a copy of a running structure with the Replicate Structure builder, the create kind: only at the floor and off
  // the allowlist (it spends nothing until set-campaign-live-writes and restore-campaign), by default never by rule
  // (maxCampaigns 0), and never by rule with a clash the product's own campaigns already buy.
  'replicate-ad-structure',
  // B-2 — an AI goal, the create kind: only at the floor, off the allowlist, its rules and plan off (nothing spends until
  // restore-campaign); by default never by rule (maxCampaigns 0).
  'create-ai-goal-campaigns',
  // W4-3 — campaign settings (the settings kind) and portfolios (the portfolio kind; an archive is the archive kind too):
  // by default never by rule (maxItems 0 / no market listed); whatever adds spend needs the approver's code.
  'set-campaign-settings', 'set-portfolio',
  // W4-1 — one hourly bid plan (its own kind, hourly): Nexus only but for a give-back; a raise needs the approver's code;
  // by default never by rule (maxItems 0, no market), and a person's plan never by rule unless allowPeoplesPlans.
  'set-hourly-bid-plan',
]

/**
 * AA-W2-1 — irreversible tools that may be set above `ask` (rule 7c), each with a sample preview that is inside the
 * ads strategy, which the tool's DEFAULT limits must still refuse: by default nothing permanent runs alone. Exact, as
 * above. Empty until archive-ads.
 */
const IRREVERSIBLE_AUTO: Readonly<Record<string, unknown>> = {
  // AA-W2-13 — archive one enabled campaign in a market whose strategy lets Claude archive and allows the change today:
  // inside the strategy (the lists test below shows it runs with a count above 0), refused at the default count 0.
  'archive-ads': {
    action: 'archive-ads',
    // The write gate lets it through as a run by rule (AA-W2-6's kit).
    ruleGate: null,
    limitFacts: {
      v: 1, tool: 'archive-ads', action: 'archive',
      markets: { IT: { strategy: { version: 'test-v1' }, currency: 'EUR', maxActionsPerRun: null, maxChangesPerDay: 10, maxRaisesPerDay: 10, maxBudgetIncreasePerDayCents: 0, sources: {} } },
      scopes: { 'IT|campaign:c1': { market: 'IT', label: 'campaign "Test" (IT)', limits: {}, sources: {} } },
      entityScopes: { 'campaign:c1': 'IT|campaign:c1' }, labels: { 'campaign:c1': 'campaign "Test"' },
      this: {
        markets: ['IT'], items: 1, writes: 1, raises: 0, cuts: 1, largestRaisePct: 0, largestCutPct: 0, largestRaisePoints: 0, largestCutPoints: 0,
        highestNewBidCents: null, budgetIncreaseCents: 0, byMarket: { IT: { changes: 1, writes: 1, raises: 0, budgetIncreaseCents: 0, addedDailyCents: -1000 } },
        entities: ['campaign:c1'], rowsOutsideStrategy: 0, firstOutside: null,
      },
      today: { IT: { changes: 0, writes: 0, raises: 0, budgetIncreaseCents: 0 } }, perEntityToday: { maxChangesByRule: 0, entity: null },
      unplaced: [], engineOwned: [], protectedHit: [],
    },
  },
}

/**
 * AA-W2-1 — `alwaysAsk` tools an earlier, reviewed phase already let a business confirm in Claude or run by rule inside
 * the tool's own limits, before W2 (each with that phase). Closed: it only shrinks. A new `alwaysAsk` tool above `ask` is
 * a strategy-bound ad tool on AD_STRATEGY_AUTO, or it stays at `ask`.
 */
const ALWAYS_ASK_ABOVE_ASK: Readonly<Record<string, string>> = {
  'set-price': 'C5 — a master price, inside how far it may move',
  'bulk-price-change': 'MCP.10 / C5 — master prices of many products, inside their limits',
  'set-master-prices': 'MCP.10 / C5 — the undo of a bulk price change, inside its limits',
  'bulk-attribute-change': 'MCP.10 / C5 — master attributes, Nexus only, inside their limits',
  'bulk-listing-price-change': '08 S11 — listing prices, inside their limits',
  'schedule-price-change': '08 S12 — confirm in Claude at most',
  'set-stock': '08 S6 — confirm in Claude at most',
  'reconcile-stock-count': '08 S6 — confirm in Claude at most',
  'reserve-stock': '08 S6 — confirm in Claude at most',
  'bulk-listing-stock': '08 S7 — confirm in Claude at most',
  'receive-stock': '08 S10 — confirm in Claude at most',
  'buy-shipping-label': '07 O8 — confirm in Claude at most, inside the label limits',
  'void-shipping-label': '07 O8 — confirm in Claude at most',
}

/**
 * W4-1 (lead decision 2026-10-06) — the journal tools: Claude's door runs them at once, never as a request a person
 * approves, so each must change nothing of the business. Exact: a new name is a reviewed change, and no other tool may
 * carry the flag (rule 7d and the exact-list test below).
 */
const JOURNAL_TOOLS: readonly string[] = [
  'report-ads-run', // the daily Claude ads run's own record, its bell notice and at most one e-mail a day
]

interface ContractLists {
  adStrategyAuto: readonly string[]
  irreversibleAuto: Readonly<Record<string, unknown>>
  alwaysAskAboveAsk: Readonly<Record<string, string>>
  journal: readonly string[]
}
const LISTS: ContractLists = { adStrategyAuto: AD_STRATEGY_AUTO, irreversibleAuto: IRREVERSIBLE_AUTO, alwaysAskAboveAsk: ALWAYS_ASK_ABOVE_ASK, journal: JOURNAL_TOOLS }

/** 7b — a preview with everything but the strategy's facts: a strategy-bound tool never lets it run alone. */
const WITHOUT_FACTS = { summary: 'A change whose preview carries no limitFacts.' }

/**
 * N3 (AA-W2-1, widened) — the wordings tools use to say a person decides. "Always … in Nexus" is false once the business
 * may let a change be confirmed in Claude or run by rule; "always … a person" is false once its rule may run it alone;
 * "a person approves it in Nexus" is true, but alone it hides the other way the business may allow.
 */
const ALWAYS_IN_NEXUS = /\balways waits for a person(?: to approve it)?\s+in Nexus\b/i
const ALWAYS_A_PERSON = /\balways (?:waits for|needs|asks for) a person\b|\ba person always (?:approves|decides)\b|\bevery (?:change|move|request|step) waits for a person\b/i
const A_PERSON_IN_NEXUS =
  /\b(?:waits for a person|a person approves (?:it|this|the change)|nothing (?:changes|is created) until a person approves (?:it|this))\b[^.;]*\bin Nexus\b|\brequires approval\b/i
const THE_OTHER_WAY = {
  confirm: /\bin Claude\b/i,
  auto: /\bby (?:its|their|the business(?:'|’)?s?) rule\b|\bitself\b|\blets it run\b|\brun inside\b/i,
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
function contractProblems(tool: AgentTool, material: Record<string, string[]> = MATERIAL_PREVIEW_FIELDS, lists: ContractLists = LISTS): string[] {
  const problems: string[] = []
  const bad = (rule: string | number, what: string) => problems.push(`${tool.name} — rule ${rule}: ${what}`)
  const change = !tool.readOnly
  const ceiling = tool.maxClaudeTrust
  const above = ceiling === 'confirm' || ceiling === 'auto'

  // 1 — names and words
  if (!KEBAB.test(tool.name)) bad(1, 'name is not kebab-case verb-noun')
  if (!tool.title?.trim() || tool.title.length > 40) bad(1, 'title missing or longer than 40')
  if (!tool.description?.trim()) bad(1, 'no description')
  if (change && !/approv|a person/i.test(tool.description)) bad(1, 'a change tool must say it waits for approval')
  if (change && above) {
    const can = ceiling === 'auto' ? 'run by the business\'s rule' : 'confirmed in Claude'
    // N3 — "always … in Nexus" is false when the business may let it be confirmed in Claude or run by rule.
    if (ALWAYS_IN_NEXUS.test(tool.description)) bad(1, `says it always waits for a person in Nexus, but it can be ${can}`)
    // N3 (widened) — at auto, "always … a person" in any of the tools' wordings is false: the rule may run it alone.
    if (ceiling === 'auto' && ALWAYS_A_PERSON.test(tool.description)) {
      bad(1, 'says it always waits for (or needs) a person, but the business\'s rule may run it alone')
    }
    // D4 (widened) — "a person approves it in Nexus" alone is false for the same tools: it must also say the other way.
    if (A_PERSON_IN_NEXUS.test(tool.description) && !THE_OTHER_WAY[ceiling as 'confirm' | 'auto'].test(tool.description)) {
      bad(1, `says a person approves it in Nexus, but not that it can be ${can}`)
    }
  }

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
    if (tool.reversibility || tool.maxClaudeTrust || tool.limits || tool.withinLimits || tool.undo || tool.journal) {
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
    // 7c — irreversible: ask at most, unless strategy-bound, listed, and its default limits run nothing permanent alone.
    if (tool.reversibility === 'none' && above) {
      if (!(tool.name in lists.irreversibleAuto)) bad(7, 'an irreversible change is ask at most')
      else if (!tool.strategyBound) bad('7c', 'an irreversible change above ask must be strategy-bound')
      else if (tool.limits && typeof tool.withinLimits?.(lists.irreversibleAuto[tool.name], tool.limits.parse({}) as Record<string, unknown>) !== 'string') {
        bad('7c', 'an irreversible change above ask must be refused by its default limits')
      }
    }
    // 7a — alwaysAsk stays a floor: above ask only for a strategy-bound tool on AD_STRATEGY_AUTO (or one raised before W2).
    if (tool.alwaysAsk && above && !(tool.name in lists.alwaysAskAboveAsk)) {
      if (!lists.adStrategyAuto.includes(tool.name)) bad('7a', 'an alwaysAsk tool is ask at most unless it is on AD_STRATEGY_AUTO')
      else if (!tool.strategyBound) bad('7a', 'an alwaysAsk tool above ask must be strategy-bound')
    }
    // 7b — strategy-bound: its limits are judged against the ads strategy, so it never runs alone without its facts …
    if (tool.strategyBound) {
      if (!tool.limits || !tool.withinLimits) bad('7b', 'a strategy-bound tool needs limits and withinLimits')
      else if (typeof tool.withinLimits(WITHOUT_FACTS, tool.limits.parse({}) as Record<string, unknown>) !== 'string') {
        bad('7b', 'a strategy-bound tool refuses a preview without limitFacts')
      }
      if (!actionOfTool(tool.name) || !PLACES[tool.name]) {
        bad('7b', 'a strategy-bound tool is a kind of ad action the ads strategy narrows (CLAUDE_ACTION_TOOLS and PLACES)')
      }
    }
    // … and a kind of ad action the strategy narrows runs by rule only strategy-bound.
    if (ceiling === 'auto' && actionOfTool(tool.name) && !tool.strategyBound) {
      bad('7b', 'a kind of ad action the ads strategy narrows may run by rule only when strategy-bound')
    }
    // 7d — a journal (W4-1): it runs at once, so it is a reviewed name that reaches no one and is offered or not.
    if (tool.journal) {
      if (!lists.journal.includes(tool.name)) bad('7d', 'a journal tool is on JOURNAL_TOOLS')
      if (tool.openWorld !== false) bad('7d', 'a journal tool reaches no one outside Nexus')
      if (tool.maxClaudeTrust !== 'ask') bad('7d', 'a journal tool is offered or not: ceiling ask')
      if (tool.alwaysAsk || tool.strategyBound || tool.limits || tool.control) bad('7d', 'a journal tool is never alwaysAsk, strategy-bound, limited or a control tool')
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
      'end-listing': 'partial',
      'relist-listing': 'partial',
      'delete-listing': 'none',
      // AA-W2-9 — its own writes are a change set: undone in turn, but retired negatives are not created again.
      'undo-ad-change': 'partial',
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
      // T5 — each campaign's earlier target ACoS (a fraction, or none) is set back through the tool's own list.
      'set-campaign-target-acos': { before: { targets: { c1: 0.3, c2: null } }, after: { targets: { c1: 0.25, c2: 0.25 } } },
      // A8 — a suppression is undone by a restore, a restore by a suppression.
      'suppress-campaign': { before: { campaignId: 'c1', suppressed: false, by: null, changeSetId: 'ap1' }, after: { campaignId: 'c1', suppressed: true, by: 'user:u1' } },
      'restore-campaign': { before: { campaignId: 'c1', suppressed: true, by: 'user:u1', changeSetId: 'ap1' }, after: { campaignId: 'c1', suppressed: false, by: null } },
      // AA-W2-12 — a pause is undone by enable-ads of the same ads (a product ad named by its ad group and SKU), an enable by pause-ads.
      'pause-ads': {
        before: { changeSetId: 'ap1', items: [{ level: 'campaign', id: 'c1', status: 'ENABLED' }, { level: 'productAd', id: 'pa1', adGroupId: 'g1', product: 'TEST-SKU-1', status: 'ENABLED' }] },
        after: { items: [{ level: 'campaign', id: 'c1', status: 'PAUSED' }, { level: 'productAd', id: 'pa1', adGroupId: 'g1', product: 'TEST-SKU-1', status: 'PAUSED' }] },
      },
      'enable-ads': { before: { changeSetId: 'ap1', items: [{ level: 'target', id: 't1', status: 'PAUSED' }] }, after: { items: [{ level: 'target', id: 't1', status: 'ENABLED' }] } },
      // AA-W2-13 — a created campaign is put back (in part) by archiving it.
      'create-ad-campaign': { before: { campaignId: null }, after: { campaignId: 'c9', name: 'Test launch', market: 'IT' } },
      // W4-1 — an hourly plan's paint is put back by painting the week it replaced (the same tool, the inverse op).
      [`set-hourly-bid-plan`]: {
        before: { op: 'update-windows', planId: 'rg1', name: 'Test plan', enabled: true, windows: [{ days: [1], startHour: 0, endHour: 6, targetKey: 'test-floor' }], defaultTargetKey: 'test-top', members: ['c1'], overrides: {} },
        after: { op: 'update-windows', planId: 'rg1', name: 'Test plan', enabled: true, windows: [], defaultTargetKey: 'test-top', members: ['c1'], overrides: {}, versionId: 'v2' },
      },
      // B-2 — an AI goal is put back (in part) by archiving every campaign it made at Amazon.
      'create-ai-goal-campaigns': { before: { goalId: null, campaignIds: [] }, after: { goalId: 'g1', planId: 'pl1', market: 'IT', name: 'Test goal', campaignIds: ['c1', 'c2'], notAtAmazon: [] } },
      // W3-3 — a stock lowering is undone by a give-back (even while stock is short), a give-back by a lowering.
      'lower-ad-bids-for-stock': {
        before: { changeSetId: 'ap1', adGroups: [{ adGroupId: 'g1', floored: false, by: null }], steps: [{ adGroupId: 'g2', kind: 'target', id: 't1', fromCents: 50, toCents: 40 }] },
        after: { adGroups: [{ adGroupId: 'g1', floored: true, by: 'user:u1' }], stepAdGroupIds: ['g2'], steps: [{ kind: 'target', id: 't1', cents: 40 }] },
      },
      'restore-ad-bids-after-stock': {
        before: { changeSetId: 'ap1', adGroups: [{ adGroupId: 'g1', floored: true, by: 'user:u1' }], steps: [{ adGroupId: 'g2', kind: 'target', id: 't1', fromCents: 40, toCents: 50 }] },
        after: { adGroups: [{ adGroupId: 'g1', floored: false, by: null }], steps: [{ kind: 'target', id: 't1', cents: 50 }] },
      },
      // B-3 — a one-off SP Super Wizard set is put back (in part) by archiving every campaign its run made.
      'build-sp-wizard-campaigns': { before: { applicationId: null, market: 'IT', productGroupName: 'Test set', structure: 'advanced' }, after: { applicationId: 'run2', market: 'IT', productGroupName: 'Test set', structure: 'advanced' } },
      // PB-5a — a playbook build is archived (every campaign it made); an adopt is put back by the opposite adopt.
      'apply-ads-playbook': { before: { op: 'build', playbookId: 'pb1', state: 'DRAFT', slots: [] }, after: { op: 'build', playbookId: 'pb1', applicationId: 'run1' } },
      // B-1 — a Replicate copy is archived (every campaign its run made).
      'replicate-ad-structure': { before: { applicationId: null, market: 'IT', productToken: 'TEST' }, after: { applicationId: 'run2' } },
      // W4-3 — campaign settings go back through the tool, each campaign with its own values; a portfolio change through
      // set-portfolio (a create is archived).
      'set-campaign-settings': {
        before: { changeSetId: 'ap1', campaigns: [{ campaignId: 'c1', portfolioId: 'PF-1', biddingStrategy: 'legacyForSales' }, { campaignId: 'c2', portfolioId: null, endDate: '2026-12-31' }] },
        after: { campaigns: [{ campaignId: 'c1', portfolioId: 'PF-2', biddingStrategy: 'autoForSales' }, { campaignId: 'c2', portfolioId: 'PF-2', endDate: null }] },
      },
      'set-portfolio': {
        before: { op: 'update', portfolioId: 'PF-1', market: 'IT', name: 'Old name', cap: { amountCents: 50000, currency: 'EUR', policy: 'monthly', startDate: null, endDate: null }, state: 'ENABLED', changeSetId: 'ap1' },
        after: { op: 'update', portfolioId: 'PF-1', market: 'IT', name: 'New name', cap: { amountCents: 60000, currency: 'EUR', policy: 'monthly', startDate: null, endDate: null }, state: 'ENABLED' },
      },
      // A7 — a bulk bid change is reversed as one change set by undo-ad-change.
      'bulk-ad-bid-change': { before: { changeSetId: 'ap1', bids: { t1: 30 } }, after: { bids: { t1: 35 } } },
      'undo-ad-change': { before: { changeSetId: 'ap2', undid: { mode: 'set', changeSetId: 'ap1' } }, after: { changeSetId: 'ap2', standing: 3 } },
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
      // Ads autonomy W3-2 — a cancel of all of one Claude request: undo asks for that request again, through its own tool.
      'cancel-queued-ad-write': {
        before: { writes: [{ queueId: 'q1', label: 'keyword "test" (campaign "Test")' }], request: { approvalId: 'ap1', tool: 'set-target-bid', args: { targetId: 't1', proposedBidCents: 40, why: 'test' } } },
        after: { cancelled: ['q1'] },
      },
      // Ads autonomy W1-3 — a strategy change: undo writes the previous version back (with its terms and campaign targets).
      'set-ads-strategy': {
        before: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', version: 2, values: { maxBidCents: 150, targetKind: 'ACOS', targetPct: 30, claudeAutonomy: { bid: 'ask' } }, terms: { 'test term': false }, campaignTargets: { c1: 0.25 } },
        after: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', version: 3, values: { maxBidCents: 120, targetKind: 'ACOS', targetPct: 30, claudeAutonomy: null }, terms: { 'test term': { matchType: null } }, campaignTargets: { c1: null } },
      },
      // Ads playbook PB-3 — a playbook row change: undo writes the previous version back (its overrides set back or cleared).
      'set-ads-playbook': {
        before: { kind: 'playbook', channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: 'p1', version: 1, values: { templateId: 't1', overrides: null, enrolled: true, state: 'DRAFT', nameToken: 'TEST', portfolioName: null, dailyBudgetCents: 1000, baseBidCents: 30, terms: null, phaseRecipes: null } },
        after: { kind: 'playbook', channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: 'p1', version: 2, values: { templateId: 't1', overrides: { skipSlots: ['exact-brand'] }, enrolled: true, state: 'DRAFT', nameToken: 'TEST', portfolioName: null, dailyBudgetCents: 1200, baseBidCents: 30, terms: null, phaseRecipes: null } },
      },
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
      // Ads autonomy W3-1 — a mute is put back by an unmute of the same recommendations.
      'mute-ad-recommendations': { before: { op: 'mute', items: [{ id: 'bid:t1', state: 'shown' }] }, after: { op: 'mute', items: [{ id: 'bid:t1', state: 'muted' }] } },
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
      // Phase 3 (T1) — an End and a Relist are each other's undo (the family SKU confirms the inverse); a Delete has none.
      'end-listing': { before: { listingIds: ['l1'], ended: false, familySku: 'FAM-1' }, after: { listingIds: ['l1'], ended: true, familySku: 'FAM-1' } },
      'relist-listing': { before: { listingIds: ['l1'], ended: true, familySku: 'FAM-1' }, after: { listingIds: ['l1'], ended: false, familySku: 'FAM-1' } },
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
      // ADS AUTONOMY W4-1 — a run report: its bell notice is taken back and the run withdrawn (op withdraw).
      'report-ads-run': { before: { runId: 'r1', status: 'running', withdrawn: false }, after: { runId: 'r1', status: 'done', withdrawn: false } },
      // W4-2 — the expected report time it replaced, set again.
      'set-ads-report-time': { before: { expected: { time: '08:00', timeZone: 'Europe/Rome' } }, after: { expected: { time: '08:30', timeZone: 'Europe/Rome' } } },
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

  it('AA-W2-1 — outside the reviewed lists, every alwaysAsk tool is ask at most; the floors stay where they are', () => {
    const changeTools = listTools().filter((t) => !t.readOnly)
    const outside = changeTools
      .filter((t) => t.alwaysAsk && t.maxClaudeTrust !== 'ask' && t.maxClaudeTrust !== 'off')
      .filter((t) => !AD_STRATEGY_AUTO.includes(t.name) && !(t.name in ALWAYS_ASK_ABOVE_ASK))
      .map((t) => t.name)
    expect(outside).toEqual([])
    // Refunds, fiscal numbers, messages, publishing, eBay ads and Amazon spend: a person approves each in Nexus.
    const atAsk = new Set(changeTools.filter((t) => t.alwaysAsk && t.maxClaudeTrust === 'ask').map((t) => t.name))
    for (const name of ['issue-refund', 'issue-fiscal-document', 'send-customer-message', 'publish-listing', 'delete-listing',
      'set-ebay-ad-rates', 'set-ebay-campaign-budget']) {
      expect(atAsk.has(name), `${name} is alwaysAsk at ask`).toBe(true)
    }
  })

  it('W4-1 — the journal tools are exactly JOURNAL_TOOLS: no other tool runs at once without a request', () => {
    expect(listTools().filter((tool) => tool.journal).map((tool) => tool.name).sort()).toEqual([...JOURNAL_TOOLS].sort())
    for (const name of JOURNAL_TOOLS) expect(listTools().find((tool) => tool.name === name)?.execute, name).toBeTypeOf('function')
  })

  it('AA-W2-1 — the lists are exact: each entry is a registered tool that still needs to be on it', () => {
    const byName = new Map(listTools().map((t) => [t.name, t]))
    const aboveAsk = (t?: AgentTool) => t?.maxClaudeTrust === 'confirm' || t?.maxClaudeTrust === 'auto'
    for (const name of AD_STRATEGY_AUTO) {
      const tool = byName.get(name)
      expect(tool?.alwaysAsk && tool.strategyBound && aboveAsk(tool), `${name}: alwaysAsk, strategy-bound and above ask, or off AD_STRATEGY_AUTO`).toBe(true)
    }
    for (const name of Object.keys(IRREVERSIBLE_AUTO)) {
      const tool = byName.get(name)
      expect(tool?.reversibility === 'none' && aboveAsk(tool), `${name}: irreversible and above ask, or off IRREVERSIBLE_AUTO`).toBe(true)
      // The sample is inside the strategy: with a count above 0 the tool's own limits let it run (rule 7c's refusal is
      // the default count, not a broken sample).
      expect(tool!.withinLimits!(IRREVERSIBLE_AUTO[name], tool!.limits!.parse({ maxItems: 1 }) as Record<string, unknown>), name).toBeNull()
    }
    for (const name of Object.keys(ALWAYS_ASK_ABOVE_ASK)) {
      const tool = byName.get(name)
      expect(tool?.alwaysAsk && aboveAsk(tool) && !tool.strategyBound, `${name}: alwaysAsk above ask (not strategy-bound), or off ALWAYS_ASK_ABOVE_ASK`).toBe(true)
    }
    expect(AD_STRATEGY_AUTO.filter((name) => name in ALWAYS_ASK_ABOVE_ASK)).toEqual([])
  })

  it('N3 (AA-W2-1) — an ad tool at ask that says it always waits for a person is caught the day its ceiling rises', () => {
    for (const name of ['set-campaign-budget', 'set-placement-multipliers', 'bulk-ad-bid-change', 'restore-campaign', 'set-campaign-live-writes', 'create-ad-campaign']) {
      const tool = listTools().find((t) => t.name === name)!
      if (tool.maxClaudeTrust !== 'ask') continue // raised: its text was made honest with it (rules 1–7 hold above)
      expect(contractProblems({ ...tool, maxClaudeTrust: 'auto' }).join('\n'), name).toContain('says it always waits for (or needs) a person')
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
  const problemsOf = (patch: Partial<AgentTool>, lists?: Partial<ContractLists>) =>
    contractProblems({ ...good, ...patch } as AgentTool, {}, { ...LISTS, ...lists })

  // AA-W2-1 — a strategy-bound ad tool, made as the contract wants it (a real kind of ad action, so the strategy narrows it).
  const facts = { limits: z.object({ maxRaisePct: z.number().default(0).describe('x') }), withinLimits: (preview: unknown) => ((preview as { limitFacts?: unknown } | null)?.limitFacts ? null : 'no limit facts') }
  const bound: Partial<AgentTool> = {
    name: 'set-target-bid', category: 'advertising', alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', ...facts,
    description: 'Changes a bid. A person approves it in Nexus, unless the business lets it run by its rule inside its limits and the ads strategy.',
  }
  const onList = { adStrategyAuto: ['set-target-bid'] }
  const refusesByDefault = { withinLimits: (preview: unknown, limits: Record<string, unknown>) => (limits.maxItems ? null : 'archiving waits for a person by default') }

  it('a well-made tool passes', () => {
    expect(problemsOf({})).toEqual([])
    // W4-1 — and as a journal, on the list.
    expect(problemsOf({ journal: true }, { journal: ['set-example'] })).toEqual([])
  })

  it('AA-W2-1 — a well-made strategy-bound ad tool passes, alwaysAsk and above ask, on AD_STRATEGY_AUTO', () => {
    expect(problemsOf(bound, onList)).toEqual([])
    // The tools a person confirms or runs inside limits before W2 are a closed list, not this class.
    expect(problemsOf({ alwaysAsk: true, maxClaudeTrust: 'confirm', description: 'Changes an example. Waits for a person: approved in Nexus, or confirmed in Claude.' },
      { alwaysAskAboveAsk: { 'set-example': 'test' } })).toEqual([])
    // An irreversible one whose default limits refuse even a change inside the strategy.
    expect(problemsOf({ ...bound, ...refusesByDefault, reversibility: 'none' }, { ...onList, irreversibleAuto: { 'set-target-bid': { limitFacts: {} } } })).toEqual([])
  })

  it.each([
    [{ name: 'setExample' }, 'rule 1: name'],
    [{ description: 'Changes an example.' }, 'rule 1: a change tool must say'],
    [{ description: 'Changes an example. Always waits for a person to approve it in Nexus.', maxClaudeTrust: 'confirm' }, 'but it can be confirmed in Claude'],
    [{ description: 'Changes an example. Nothing changes until a person approves it in Nexus.', maxClaudeTrust: 'confirm' }, 'says a person approves it in Nexus, but not that it can be confirmed in Claude'],
    // N3, widened (AA-W2-1): the wordings the tools use.
    [{ description: 'Changes an example. Always waits for a person in Nexus.', maxClaudeTrust: 'confirm' }, 'says it always waits for a person in Nexus'],
    [{ description: 'Changes an example. Waits for a person to approve it in Nexus.', maxClaudeTrust: 'confirm' }, 'says a person approves it in Nexus, but not that it can be confirmed in Claude'],
    [{ description: 'Changes an example. A person approves it in Nexus first.', maxClaudeTrust: 'confirm' }, 'but not that it can be confirmed in Claude'],
    [{ description: 'Changes an example (requires approval).', maxClaudeTrust: 'auto', ...facts }, 'but not that it can be run by the business\'s rule'],
    [{ description: 'Changes an example. Waits for a person: approved in Nexus, or confirmed in Claude.', maxClaudeTrust: 'auto', ...facts }, 'but not that it can be run by the business\'s rule'],
    [{ description: 'Changes an example. Nothing changes until a person approves it in Nexus; it always waits for a person.', maxClaudeTrust: 'auto', ...facts }, 'says it always waits for (or needs) a person'],
    [{ description: 'Changes an example by its rule. A raise always waits for a person.', maxClaudeTrust: 'auto', ...facts }, 'says it always waits for (or needs) a person'],
    [{ description: 'Changes an example by its rule. A brake can raise spend, so it always needs a person.', maxClaudeTrust: 'auto', ...facts }, 'says it always waits for (or needs) a person'],
    [{ description: 'Changes an example by its rule. Every move waits for a person.', maxClaudeTrust: 'auto', ...facts }, 'says it always waits for (or needs) a person'],
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

  // AA-W2-1 — rules 7a–7c.
  it.each([
    [{ alwaysAsk: true, maxClaudeTrust: 'confirm', description: 'Changes an example. Waits for a person: approved in Nexus, or confirmed in Claude.' }, {}, 'rule 7a: an alwaysAsk tool is ask at most unless it is on AD_STRATEGY_AUTO'],
    [{ ...bound }, {}, 'rule 7a: an alwaysAsk tool is ask at most unless it is on AD_STRATEGY_AUTO'],
    [{ ...bound, strategyBound: undefined }, onList, 'rule 7a: an alwaysAsk tool above ask must be strategy-bound'],
    [{ ...bound, limits: undefined, withinLimits: undefined }, onList, 'rule 7b: a strategy-bound tool needs limits and withinLimits'],
    [{ ...bound, withinLimits: () => null }, onList, 'rule 7b: a strategy-bound tool refuses a preview without limitFacts'],
    [{ ...bound, name: 'set-example' }, { adStrategyAuto: ['set-example'] }, 'rule 7b: a strategy-bound tool is a kind of ad action the ads strategy narrows'],
    [{ ...bound, alwaysAsk: false, strategyBound: undefined }, {}, 'rule 7b: a kind of ad action the ads strategy narrows may run by rule only when strategy-bound'],
    [{ ...bound, reversibility: 'none' }, onList, 'rule 7: an irreversible change is ask at most'],
    [{ ...bound, reversibility: 'none', strategyBound: undefined }, { ...onList, irreversibleAuto: { 'set-target-bid': {} } }, 'rule 7c: an irreversible change above ask must be strategy-bound'],
    [{ ...bound, reversibility: 'none' }, { ...onList, irreversibleAuto: { 'set-target-bid': { limitFacts: {} } } }, 'rule 7c: an irreversible change above ask must be refused by its default limits'],
    // W4-1 — rule 7d.
    [{ journal: true }, {}, 'rule 7d: a journal tool is on JOURNAL_TOOLS'],
    [{ journal: true, openWorld: true }, { journal: ['set-example'] }, 'rule 7d: a journal tool reaches no one outside Nexus'],
    [{ journal: true, maxClaudeTrust: 'auto', ...facts, description: 'Changes an example by its rule, or a person approves it.' }, { journal: ['set-example'] }, 'rule 7d: a journal tool is offered or not: ceiling ask'],
    [{ journal: true, alwaysAsk: true }, { journal: ['set-example'] }, 'rule 7d: a journal tool is never alwaysAsk'],
    [{ journal: true, readOnly: true, reversibility: undefined, maxClaudeTrust: undefined }, { journal: ['set-example'] }, 'rule 4: a read tool carries no change contract'],
  ] as Array<[Partial<AgentTool>, Partial<ContractLists>, string]>)('%o with lists %o breaks: %s', (patch, lists, expected) => {
    expect(problemsOf(patch, lists).join('\n')).toContain(expected)
  })
})
