/**
 * Reviews › Settings › Automations › Edit — a review automation in the rules builder
 * (`/marketing/ads/rules-automation/builder/review-automation?ruleId=<id>`). Pure: what the builder shows of a stored
 * rule, what a save may hold, the rule a save stores, and what the rule does in words. The reads and the save are in
 * review-automation-builder.service.ts; tested in review-automation-builder.vitest.test.ts.
 *
 *   When    complaints about a theme rise fast — the trigger REVIEW_SPIKE_DETECTED, one run per open alert of the hourly
 *           spike check (jobs/review-rule-evaluator.job.ts). Its settings are conditions on that alert:
 *             themes          spike.category in [...]            (none = every theme)
 *             how fast        spike.spikeMultiplier ≥ n          (none = every alert the check raises)
 *             products        product.familyId in [...]          (a product and every size and colour of it; none = all)
 *           and one column: the market (scopeMarketplace; none = every market).
 *   Then    tell the team (notify), or have the AI draft new bullet points or an A+ module — and tell the team too.
 *   Limit   at most n runs a day (maxExecutionsPerDay).
 * On / off and trial run stay on Reviews › Settings › Automations: a save here never changes them.
 *
 * Nothing runs differently until a person saves a change: a part the person did not change is stored exactly as it was
 * (its conditions or actions as they are), a condition the builder has no control for is kept as it is, and a part the
 * builder cannot draw — conditions grouped with and / or / not, an action it does not know — is shown held and kept.
 */
import { REVIEW_TEMPLATES } from './review-templates.js'
import { marketWords, themeWords } from './overviewMath.js'

export const SPIKE_TRIGGER = 'REVIEW_SPIKE_DETECTED'

/** The themes the review reading names (ReviewSentiment.categories), in the order the pages list them. */
export const REVIEW_AUTOMATION_THEMES = ['FIT_SIZING', 'DURABILITY', 'SHIPPING', 'VALUE', 'DESIGN', 'QUALITY', 'SAFETY', 'COMFORT', 'OTHER'] as const

export type ReviewAutomationDoes = 'notify' | 'bullets' | 'aplus'
export const REVIEW_AUTOMATION_DOES: readonly ReviewAutomationDoes[] = ['notify', 'bullets', 'aplus']

const ACTION_TYPE: Record<'bullets' | 'aplus', string> = {
  bullets: 'update_product_bullets_from_review',
  aplus: 'create_aplus_module_from_review',
}
/** What a new AI action records as its reason (the templates' own words). */
const ACTION_REASON: Record<'bullets' | 'aplus', string> = {
  bullets: 'Review spike — regenerate bullets to address customer concern',
  aplus: 'High-multiplier spike — generate A+ content response',
}

export const THEME_FIELD = 'spike.category'
export const SPEED_FIELD = 'spike.spikeMultiplier'
export const FAMILY_FIELD = 'product.familyId'

export const NAME_MAX = 120
export const MESSAGE_MAX = 500
export const MULTIPLIER_MIN = 1
export const MULTIPLIER_MAX = 50
export const PER_DAY_MAX = 500
export const FAMILIES_MAX = 200

/** What the builder edits. */
export interface ReviewAutomationView {
  name: string
  /** Theme keys; empty = every theme. */
  themes: string[]
  /** Complaints must rise at least this many times faster than usual; null = every alert the spike check raises. */
  minMultiplier: number | null
  /** Product ids, each a whole product (a parent, or a product with no sizes or colours); empty = every product. */
  families: string[]
  /** Market code; null = every market. */
  market: string | null
  does: ReviewAutomationDoes
  /** Also tell the team (always true when `does` is notify). */
  tellTeam: boolean
  /** What the team is told. */
  message: string
  /** At most this many runs a day; null = no limit is stored. */
  maxPerDay: number | null
}

/** The stored rule, as far as the builder reads it. */
export interface StoredReviewRule {
  name: string
  trigger: string
  conditions: unknown
  actions: unknown
  scopeMarketplace: string | null
  maxExecutionsPerDay: number | null
}

export interface ReviewRuleReading {
  view: ReviewAutomationView
  /** Conditions the builder has no control for, in words. Kept exactly as they are on a save. */
  kept: string[]
  /** Why the trigger's settings cannot be changed here (they are kept as they are), or null. */
  whenHeld: string | null
  /** Why the action cannot be changed here (it is kept as it is), or null. */
  thenHeld: string | null
}

type Leaf = { field: string; op: string; value?: unknown }
type ActionRow = { type: string; [key: string]: unknown }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isLeaf = (v: unknown): v is Leaf => isObject(v) && typeof v.field === 'string' && typeof v.op === 'string' && v.kind === undefined
const isTheme = (v: unknown): v is string => typeof v === 'string' && (REVIEW_AUTOMATION_THEMES as readonly string[]).includes(v)
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)

const OP_WORD: Record<string, string> = { eq: 'is', ne: 'is not', lt: '<', lte: '≤', gt: '>', gte: '≥', in: 'is one of', contains: 'contains', exists: 'is set' }

/** A condition the builder keeps as it is, in words: "spike.count ≥ 3". */
export function keptWords(c: Leaf): string {
  const value = c.op === 'exists' ? '' : ` ${Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')}`
  return `${c.field} ${OP_WORD[c.op] ?? c.op}${value}`
}

/** What the builder shows of a stored review rule. */
export function readReviewRule(rule: StoredReviewRule): ReviewRuleReading {
  const view: ReviewAutomationView = {
    name: rule.name, themes: [], minMultiplier: null, families: [], market: rule.scopeMarketplace ?? null,
    does: 'notify', tellTeam: true, message: '', maxPerDay: rule.maxExecutionsPerDay ?? null,
  }
  const kept: string[] = []
  let whenHeld: string | null = null
  let thenHeld: string | null = null

  if (rule.trigger !== SPIKE_TRIGGER) {
    whenHeld = 'Its trigger is not a complaint spike, so it has no settings here. It is kept as it is.'
  } else if (rule.conditions != null && !Array.isArray(rule.conditions)) {
    whenHeld = 'Its conditions are grouped (and / or / not), which the builder cannot show. They are kept as they are.'
  } else {
    let themes = false
    let speed = false
    let families = false
    for (const c of (rule.conditions as unknown[] | null) ?? []) {
      if (!isLeaf(c)) {
        kept.push('A condition the builder cannot read')
        continue
      }
      if (c.field === THEME_FIELD && !themes) {
        const list = c.op === 'in' ? strings(c.value) : c.op === 'eq' && typeof c.value === 'string' ? [c.value] : null
        if (list && list.length > 0 && list.every(isTheme)) {
          view.themes = [...list]
          themes = true
          continue
        }
      }
      if (c.field === SPEED_FIELD && !speed && c.op === 'gte') {
        const n = Number(c.value)
        if (c.value !== null && c.value !== '' && Number.isFinite(n) && n > 0) {
          view.minMultiplier = n
          speed = true
          continue
        }
      }
      if (c.field === FAMILY_FIELD && !families) {
        const list = c.op === 'in' ? strings(c.value) : c.op === 'eq' && typeof c.value === 'string' ? [c.value] : null
        if (list && list.length > 0) {
          view.families = [...list]
          families = true
          continue
        }
      }
      kept.push(keptWords(c))
    }
  }

  const actions = Array.isArray(rule.actions) ? (rule.actions as unknown[]) : null
  const rows = (actions ?? []).filter((a): a is ActionRow => isObject(a) && typeof a.type === 'string')
  const notify = rows.filter((a) => a.type === 'notify')
  const ai = rows.filter((a) => a.type === ACTION_TYPE.bullets || a.type === ACTION_TYPE.aplus)
  if (!actions || rows.length !== actions.length || rows.length !== notify.length + ai.length || notify.length > 1 || ai.length > 1 || rows.length === 0) {
    thenHeld = 'Its actions are not ones the builder can draw. They are kept as they are.'
  }
  view.does = ai[0]?.type === ACTION_TYPE.aplus ? 'aplus' : ai[0]?.type === ACTION_TYPE.bullets ? 'bullets' : 'notify'
  view.tellTeam = notify.length > 0 || view.does === 'notify'
  view.message = typeof notify[0]?.message === 'string' ? notify[0].message : ''
  return { view, kept, whenHeld, thenHeld }
}

// ── What a save may hold ─────────────────────────────────────────────────────────────────────────────────────────

export interface SaveContext {
  /** The rule as stored (the products it already names may since have left Nexus: they are not checked again). */
  stored: ReviewAutomationView
  /** Product ids a person may pick: whole products in Nexus. */
  pickable: ReadonlySet<string>
  /** Market codes a person may pick: the markets reviews are counted in (as stored there). */
  markets: ReadonlySet<string>
}

const themeList = () => REVIEW_AUTOMATION_THEMES.map(themeWords).join(', ')
const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((x) => right.has(x))
}

/** A save's body → the view to store, or what is wrong in words. */
export function validateReviewAutomation(body: unknown, ctx: SaveContext): { ok: true; view: ReviewAutomationView } | { ok: false; words: string } {
  if (!isObject(body)) return { ok: false, words: 'There is nothing to save.' }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return { ok: false, words: 'Give the automation a name.' }
  if (name.length > NAME_MAX) return { ok: false, words: `Keep the name to ${NAME_MAX} characters (it has ${name.length}).` }

  const rawThemes = body.themes ?? []
  if (!Array.isArray(rawThemes) || !rawThemes.every(isTheme)) return { ok: false, words: `Pick the themes from the list: ${themeList()}.` }
  const themes = REVIEW_AUTOMATION_THEMES.filter((t) => (rawThemes as string[]).includes(t))

  let minMultiplier: number | null = null
  if (body.minMultiplier != null && body.minMultiplier !== '') {
    const n = typeof body.minMultiplier === 'number' ? body.minMultiplier : Number.NaN
    if (!Number.isFinite(n) || n < MULTIPLIER_MIN || n > MULTIPLIER_MAX) {
      return { ok: false, words: `How fast complaints must rise: a number from ${MULTIPLIER_MIN} to ${MULTIPLIER_MAX} (2.5 means two and a half times faster than usual).` }
    }
    minMultiplier = Math.round(n * 100) / 100
  }

  const rawFamilies = body.families ?? []
  const familyList = strings(rawFamilies)
  if (!familyList) return { ok: false, words: 'Pick the products from the list.' }
  const families = [...new Set(familyList)]
  if (families.length > FAMILIES_MAX) return { ok: false, words: `Pick at most ${FAMILIES_MAX} products (${families.length} are picked).` }
  if (!sameSet(families, ctx.stored.families)) {
    const unknown = families.filter((id) => !ctx.pickable.has(id) && !ctx.stored.families.includes(id))
    if (unknown.length) return { ok: false, words: `${unknown.length === 1 ? 'A picked product is' : `${unknown.length} picked products are`} not in Nexus as a whole product. Pick the products from the list.` }
  }

  let market: string | null = null
  if (body.market != null && body.market !== '') {
    // The evaluator compares the market as stored, so a market is one of the stored codes, never rewritten.
    if (typeof body.market !== 'string' || (!ctx.markets.has(body.market) && body.market !== ctx.stored.market)) return { ok: false, words: 'Pick the market from the list.' }
    market = body.market
  }

  const does = body.does
  if (typeof does !== 'string' || !(REVIEW_AUTOMATION_DOES as readonly string[]).includes(does)) {
    return { ok: false, words: 'Pick what it does: tell the team, draft new bullet points, or draft an A+ module.' }
  }
  const tellTeam = does === 'notify' ? true : body.tellTeam === true
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (tellTeam && !message) return { ok: false, words: 'Write what the team is told.' }
  if (message.length > MESSAGE_MAX) return { ok: false, words: `Keep what the team is told to ${MESSAGE_MAX} characters (it has ${message.length}).` }

  const n = body.maxPerDay
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > PER_DAY_MAX) {
    return { ok: false, words: `At most how many times a day: a whole number from 1 to ${PER_DAY_MAX}.` }
  }

  return {
    ok: true,
    view: { name, themes, minMultiplier, families, market, does: does as ReviewAutomationDoes, tellTeam, message: tellTeam ? message : ctx.stored.message, maxPerDay: n },
  }
}

// ── The rule a save stores ───────────────────────────────────────────────────────────────────────────────────────

export interface ReviewRuleWrite {
  name?: string
  conditions?: object[]
  actions?: object[]
  scopeMarketplace?: string | null
  maxExecutionsPerDay?: number
  description?: string
}

/** The parts a person changed, in words, in the order the builder shows them. */
export type ChangedPart = 'name' | 'themes' | 'how fast' | 'products' | 'market' | 'action' | 'what the team is told' | 'runs a day'

/**
 * The stored rule after a save: only the parts that changed are written, each built from the stored one (a kept
 * condition stays, an AI action keeps its own fields), so a save that changes nothing writes nothing.
 */
export function buildReviewRuleWrite(rule: StoredReviewRule, reading: ReviewRuleReading, next: ReviewAutomationView): { data: ReviewRuleWrite; changed: ChangedPart[] } {
  const was = reading.view
  const changed: ChangedPart[] = []
  const data: ReviewRuleWrite = {}
  if (next.name !== was.name) { data.name = next.name; changed.push('name') }

  if (!reading.whenHeld) {
    const themes = !sameSet(next.themes, was.themes)
    const speed = next.minMultiplier !== was.minMultiplier
    const families = !sameSet(next.families, was.families)
    if (themes) changed.push('themes')
    if (speed) changed.push('how fast')
    if (families) changed.push('products')
    if (themes || speed || families) data.conditions = conditionsFor(rule.conditions, next)
  }
  if (next.market !== was.market) { data.scopeMarketplace = next.market; changed.push('market') }

  if (!reading.thenHeld) {
    const action = next.does !== was.does || next.tellTeam !== was.tellTeam
    const message = next.tellTeam && next.message !== was.message
    if (action) changed.push('action')
    if (message) changed.push('what the team is told')
    if (action || message) data.actions = actionsFor(rule.actions, next)
  }
  if (next.maxPerDay !== was.maxPerDay && next.maxPerDay != null) { data.maxExecutionsPerDay = next.maxPerDay; changed.push('runs a day') }
  if (changed.length) data.description = reviewAutomationWords(next)
  return { data, changed }
}

/** The settings' conditions, then every stored condition the builder does not draw, as it was. */
function conditionsFor(stored: unknown, next: ReviewAutomationView): object[] {
  const out: object[] = []
  if (next.themes.length) out.push({ field: THEME_FIELD, op: 'in', value: [...next.themes] })
  if (next.minMultiplier != null) out.push({ field: SPEED_FIELD, op: 'gte', value: next.minMultiplier })
  if (next.families.length) out.push({ field: FAMILY_FIELD, op: 'in', value: [...next.families] })
  // A stored condition the reading took into the settings is replaced above; every other one stays.
  const taken = { theme: false, speed: false, family: false }
  for (const c of Array.isArray(stored) ? stored : []) {
    if (isLeaf(c)) {
      const reading = readReviewRule({ name: '', trigger: SPIKE_TRIGGER, conditions: [c], actions: [], scopeMarketplace: null, maxExecutionsPerDay: null }).view
      if (c.field === THEME_FIELD && !taken.theme && reading.themes.length) { taken.theme = true; continue }
      if (c.field === SPEED_FIELD && !taken.speed && reading.minMultiplier != null) { taken.speed = true; continue }
      if (c.field === FAMILY_FIELD && !taken.family && reading.families.length) { taken.family = true; continue }
    }
    out.push(c as object)
  }
  return out
}

/** The AI action (its stored fields kept when it stays), then the team's notice (its stored fields kept, its words new). */
function actionsFor(stored: unknown, next: ReviewAutomationView): object[] {
  const rows = (Array.isArray(stored) ? stored : []).filter((a): a is ActionRow => isObject(a) && typeof a.type === 'string')
  const out: object[] = []
  if (next.does !== 'notify') {
    const type = ACTION_TYPE[next.does]
    out.push(rows.find((a) => a.type === type) ?? { type, reason: ACTION_REASON[next.does] })
  }
  if (next.tellTeam) {
    const notify = rows.find((a) => a.type === 'notify')
    out.push({ ...(notify ?? { type: 'notify', target: 'operator' }), message: next.message })
  }
  return out
}

// ── In words ─────────────────────────────────────────────────────────────────────────────────────────────────────

const times = (n: number) => `${Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, '')} times`
const listWords = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`)

/** What the automation does, in the words the Settings list shows (the templates' own words when unchanged). */
export function reviewAutomationWords(v: Pick<ReviewAutomationView, 'themes' | 'minMultiplier' | 'families' | 'market' | 'does' | 'tellTeam'>): string {
  const about = v.themes.length ? listWords(v.themes.map((t) => themeWords(t).toLowerCase())) : 'one theme'
  const speed = v.minMultiplier != null ? `${times(v.minMultiplier)} faster than usual or more` : 'fast'
  const product = v.families.length === 0 ? 'a product' : v.families.length === 1 ? 'the product picked' : `one of the ${v.families.length} products picked`
  const market = v.market ? `in ${marketWords(v.market) ?? v.market}` : 'in one market'
  if (v.does === 'notify') return `Tells the team when the spike check finds complaints about ${about} rising ${speed} for ${product} ${market}.`
  const when = `When complaints about ${about} rise ${speed} for ${product} ${market}`
  if (v.does === 'bullets') {
    return `${when}, the AI drafts five new bullet points that answer them${v.tellTeam ? ' and tells the team' : ''}. A person reads them and applies them; nothing changes on a channel by itself. Out of trial run, it also saves them as an A+ draft in Nexus.`
  }
  return `${when}, the AI drafts an A+ module that answers them and saves it as an A+ draft in Nexus${v.tellTeam ? ', and tells the team' : ''}. A person approves it before anything is published.`
}

/** JSON with every object's keys in one order: the database stores JSON with its keys in its own order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

/** True when the rule is one of the review templates exactly as it was loaded (the Settings list keeps its own words). */
export function isUnchangedTemplate(rule: StoredReviewRule): boolean {
  const t = REVIEW_TEMPLATES.find((x) => x.name === rule.name)
  if (!t) return false
  return t.trigger === rule.trigger
    && stableJson(t.conditions) === stableJson(rule.conditions ?? [])
    && stableJson(t.actions) === stableJson(rule.actions ?? [])
    && (t.scopeMarketplace ?? null) === (rule.scopeMarketplace ?? null)
    && (t.maxExecutionsPerDay ?? 20) === rule.maxExecutionsPerDay
}

/**
 * The Settings list's "What it does" for a rule: null for an unchanged template (the page shows that template's words),
 * the rule's own settings in words when the builder can read them, else its stored description.
 */
export function listedWords(rule: StoredReviewRule & { description: string | null }): string | null {
  if (isUnchangedTemplate(rule)) return null
  const reading = readReviewRule(rule)
  if (reading.whenHeld || reading.thenHeld || reading.kept.length) return rule.description
  return reviewAutomationWords(reading.view)
}
