/**
 * The rules builder's review automation (`/marketing/ads/rules-automation/builder/review-automation?ruleId=<id>`,
 * opened by Edit on Reviews › Settings › Automations): what the API answers, the form a person edits, what is wrong
 * with it in words, and the body a save sends. Pure; tested in reviewAutomationForm.vitest.test.ts. The server's own
 * rules are in apps/api/src/services/reviews/review-automation-builder.ts — the same limits, the same words.
 */

/** The builder type a review automation opens as (`/builder/<type>`). */
export const REVIEW_AUTOMATION_SLUG = 'review-automation'

export type ReviewAutomationDoes = 'notify' | 'bullets' | 'aplus'

/** What the builder edits, as the API answers it. */
export interface ReviewAutomationView {
  name: string
  themes: string[]
  minMultiplier: number | null
  families: string[]
  market: string | null
  does: ReviewAutomationDoes
  tellTeam: boolean
  message: string
  maxPerDay: number | null
}

export interface PickOption { value: string; label: string }
export interface ProductPick extends PickOption { sku: string | null; gone?: true }

/** GET /api/reviews/automation-rules/:id */
export interface ReviewAutomationRead {
  rule: { id: string; name: string; enabled: boolean; dryRun: boolean; lastEvaluatedAt: string | null; updatedAt: string }
  view: ReviewAutomationView
  /** Conditions with no control here, in words: kept as they are. */
  kept: string[]
  whenHeld: string | null
  thenHeld: string | null
  spikeCheck: { multiplier: number; minNegative: number; recentDays: number; baselineDays: number }
  options: { themes: PickOption[]; markets: PickOption[]; products: ProductPick[] }
}

/** PUT /api/reviews/automation-rules/:id */
export interface ReviewAutomationSaved {
  ok: true
  changed: string[]
  rule: { id: string; name: string; enabled: boolean; dryRun: boolean; updatedAt: string }
  words: string | null
}

export const EVERY_MARKET = 'all'
export const NAME_MAX = 120
export const MESSAGE_MAX = 500
export const MULTIPLIER_MIN = 1
export const MULTIPLIER_MAX = 50
export const PER_DAY_MAX = 500

export interface ReviewAutomationForm {
  name: string
  themes: string[]
  /** `any` = every alert the spike check raises; `atLeast` = only when complaints rise at least `multiplier` times. */
  speed: 'any' | 'atLeast'
  multiplier: string
  /** `every` product, or `only` the products picked. */
  products: 'every' | 'only'
  families: string[]
  /** A market code, or EVERY_MARKET. */
  market: string
  does: ReviewAutomationDoes
  tellTeam: boolean
  message: string
  maxPerDay: string
}

export type FormField = 'name' | 'multiplier' | 'families' | 'message' | 'maxPerDay'

/** "2.5" → 2.5; "2,5" (a decimal comma) too; anything else → NaN. */
export function readDecimal(text: string): number {
  const t = text.trim().replace(',', '.')
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN
}

export function formFromView(v: ReviewAutomationView): ReviewAutomationForm {
  return {
    name: v.name,
    themes: [...v.themes],
    speed: v.minMultiplier == null ? 'any' : 'atLeast',
    multiplier: v.minMultiplier == null ? '' : String(v.minMultiplier),
    products: v.families.length ? 'only' : 'every',
    families: [...v.families],
    market: v.market ?? EVERY_MARKET,
    does: v.does,
    tellTeam: v.does === 'notify' ? true : v.tellTeam,
    message: v.message,
    maxPerDay: v.maxPerDay == null ? '' : String(v.maxPerDay),
  }
}

/** What is wrong with the form, per field, in words (the server says the same). */
export function formProblems(f: ReviewAutomationForm): Partial<Record<FormField, string>> {
  const out: Partial<Record<FormField, string>> = {}
  const name = f.name.trim()
  if (!name) out.name = 'Give the automation a name.'
  else if (name.length > NAME_MAX) out.name = `Keep the name to ${NAME_MAX} characters (it has ${name.length}).`
  if (f.speed === 'atLeast') {
    const n = readDecimal(f.multiplier)
    if (!Number.isFinite(n) || n < MULTIPLIER_MIN || n > MULTIPLIER_MAX) out.multiplier = `A number from ${MULTIPLIER_MIN} to ${MULTIPLIER_MAX}: 2.5 means two and a half times faster than usual.`
  }
  if (f.products === 'only' && f.families.length === 0) out.families = 'Pick at least one product, or choose every product.'
  const tells = f.does === 'notify' || f.tellTeam
  if (tells && !f.message.trim()) out.message = 'Write what the team is told.'
  else if (f.message.trim().length > MESSAGE_MAX) out.message = `Keep it to ${MESSAGE_MAX} characters (it has ${f.message.trim().length}).`
  const perDay = f.maxPerDay.trim()
  if (!/^\d+$/.test(perDay) || Number(perDay) < 1 || Number(perDay) > PER_DAY_MAX) out.maxPerDay = `A whole number from 1 to ${PER_DAY_MAX}.`
  return out
}

/** The body a save sends (the form must have no problems). `updatedAt` = the version read, so a rule changed since is refused. */
export function formToBody(f: ReviewAutomationForm, updatedAt: string) {
  return {
    name: f.name.trim(),
    themes: f.themes,
    minMultiplier: f.speed === 'atLeast' ? readDecimal(f.multiplier) : null,
    families: f.products === 'only' ? f.families : [],
    market: f.market === EVERY_MARKET ? null : f.market,
    does: f.does,
    tellTeam: f.does === 'notify' ? true : f.tellTeam,
    message: f.message.trim(),
    maxPerDay: Number(f.maxPerDay.trim()),
    updatedAt,
  }
}

/** A form as the server would store it: two forms that save the same thing compare equal (the "unsaved changes" test). */
export function formKey(f: ReviewAutomationForm): string {
  const body = formToBody(f, '')
  return JSON.stringify({ ...body, themes: [...body.themes].sort(), families: [...body.families].sort(), message: body.tellTeam ? body.message : '' })
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const timesWord = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`

/** The spike check's own bar, in words: the "Every alert" choice says what it means. */
export function spikeCheckWords(c: ReviewAutomationRead['spikeCheck']): string {
  return `The check raises an alert when, for one product in one market, reviews about a theme in the last ${plural(c.recentDays, 'day')} are negative at least ${timesWord(c.multiplier)} as often as over the last ${plural(c.baselineDays, 'day')}, with at least ${plural(c.minNegative, 'negative one')}.`
}

/** On / off and trial run as they are: a save here changes neither (the switch is on Reviews › Settings › Automations). */
export function switchWords(rule: Pick<ReviewAutomationRead['rule'], 'enabled' | 'dryRun'>): string {
  const state = rule.enabled ? 'It is on' : 'It is off'
  const trial = rule.dryRun ? ', in trial run: it records what it would do and changes nothing' : ''
  return `${state}${trial}. Saving here keeps that as it is; the on / off switch is on Reviews › Settings › Automations.`
}

/** A product as the picker lists it: its name and SKU. */
export function productLabel(p: ProductPick): string {
  return p.sku ? `${p.label} · ${p.sku}` : p.label
}
