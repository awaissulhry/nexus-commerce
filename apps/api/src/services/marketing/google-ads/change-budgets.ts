/**
 * Google Ads changes (2026-10-15) — budgets: make a shared budget, change a budget's daily amount, and put campaigns on a
 * budget (a shared one, the new one, or a new budget of their own: "detach"). One atomic request.
 *
 * Money: a raise of a daily amount, and a campaign moved onto a bigger budget, can make the account spend more — each is
 * named in `spendsMoney` (the person's decision). A new budget spends nothing until a campaign that is ENABLED uses it.
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { microsOfCents, type LiveBudget, type LiveCampaign } from './live.js'
import type { GoogleMutateOperation } from './write-client.js'

export interface BudgetChangeRequest {
  /** A new SHARED budget. */
  create?: { name: string; amountCents: number }
  /** New daily amounts of existing budgets. */
  amounts?: Array<{ budgetId: string; amountCents: number }>
  /** Which budget each campaign uses: an existing one (`budgetId`), the new one (`budgetId: 'new'`), or a new budget of its own (`ownBudgetCents`). */
  campaigns?: Array<{ campaignId: string; budgetId?: string; ownBudgetCents?: number }>
}

export interface BudgetLiveState {
  budgets: LiveBudget[]
  campaigns: LiveCampaign[]
}

/** What the change replaced and wrote: amounts per budget, and the budget each campaign was on. */
export interface BudgetChangeRecord {
  amounts: Array<{ budgetId: string; amountCents: number | null }>
  campaigns: Array<{ campaignId: string; budgetId: string | null }>
  /** A budget the change made (its id is known after it ran; `new` before). */
  createdBudgetId?: string | null
}

export const NEW_BUDGET = 'new'
/** Before a run, a campaign's own new budget is named by the operation that makes it (`own:<index>`). */
const OWN_BUDGET = 'own:'
const NEW_BUDGET_TEMP_ID = -1

export function budgetChangeDraft(
  customer: string,
  currency: string,
  request: BudgetChangeRequest,
  live: BudgetLiveState,
): GoogleChangeDraft | { refusal: string } {
  const amounts = request.amounts ?? []
  const moves = request.campaigns ?? []
  if (!request.create && amounts.length === 0 && moves.length === 0) return { refusal: 'Say what to change: create, amounts or campaigns.' }
  const budgetById = new Map(live.budgets.map((b) => [b.budgetId, b]))
  const campaignById = new Map(live.campaigns.map((c) => [c.campaignId, c]))
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: BudgetChangeRecord = { amounts: [], campaigns: [] }
  const after: BudgetChangeRecord = { amounts: [], campaigns: [] }
  const budgetRes = (id: string | number) => `${customer}/campaignBudgets/${id}`

  // 1. the new shared budget
  if (request.create) {
    const name = request.create.name.trim()
    if (live.budgets.some((b) => (b.name ?? '').trim().toLowerCase() === name.toLowerCase())) {
      return { refusal: `A budget named "${name}" already exists in this account: Google refuses a second one. Use its budgetId, or another name.` }
    }
    operations.push({
      campaignBudgetOperation: {
        create: { resourceName: budgetRes(NEW_BUDGET_TEMP_ID), name, amountMicros: microsOfCents(request.create.amountCents), explicitlyShared: true, deliveryMethod: 'STANDARD' },
      },
    })
    lines.push([`new shared budget "${name}"`, '(none)', `${money(request.create.amountCents, currency)} a day`])
    after.createdBudgetId = NEW_BUDGET
  }

  // 2. new daily amounts
  const amountAfter = new Map<string, number>()
  const seenAmounts = new Set<string>()
  for (const a of amounts) {
    if (seenAmounts.has(a.budgetId)) return { refusal: `Budget ${a.budgetId} is named twice in amounts.` }
    seenAmounts.add(a.budgetId)
    const b = budgetById.get(a.budgetId)
    if (!b) return { refusal: `Budget ${a.budgetId} is not in this account (or it is removed). google-ads-live view budgets lists them.` }
    if (b.amountCents === a.amountCents) { skipped.push(`"${b.name ?? b.budgetId}" is already ${money(a.amountCents, currency)} a day.`); continue }
    operations.push({
      campaignBudgetOperation: { update: { resourceName: budgetRes(b.budgetId), amountMicros: microsOfCents(a.amountCents) }, updateMask: 'amount_micros' },
    })
    amountAfter.set(b.budgetId, a.amountCents)
    lines.push([`budget "${b.name ?? b.budgetId}"`, `${money(b.amountCents, currency)} a day`, `${money(a.amountCents, currency)} a day`])
    before.amounts.push({ budgetId: b.budgetId, amountCents: b.amountCents })
    after.amounts.push({ budgetId: b.budgetId, amountCents: a.amountCents })
    if (b.amountCents === null || a.amountCents > b.amountCents) {
      const enabled = b.campaigns.filter((c) => c.status === 'ENABLED').length
      spends.push(`Raises "${b.name ?? b.budgetId}" from ${money(b.amountCents, currency)} to ${money(a.amountCents, currency)} a day${enabled === 0 ? ' (no campaign on it is enabled now: nothing spends until one is)' : ` (${plural(enabled, 'enabled campaign')} on it)`}.`)
    }
  }

  // 3. which budget each campaign uses
  let ownTempId = NEW_BUDGET_TEMP_ID - 1
  const seenCampaigns = new Set<string>()
  const amountOf = (budgetId: string): number | null => (budgetId === NEW_BUDGET ? request.create!.amountCents : amountAfter.get(budgetId) ?? budgetById.get(budgetId)?.amountCents ?? null)
  for (const m of moves) {
    if (seenCampaigns.has(m.campaignId)) return { refusal: `Campaign ${m.campaignId} is named twice in campaigns.` }
    seenCampaigns.add(m.campaignId)
    const c = campaignById.get(m.campaignId)
    if (!c) return { refusal: `Campaign ${m.campaignId} is not in this account (or it is removed). google-ads-live view campaigns lists them.` }
    const hasBudget = m.budgetId !== undefined && m.budgetId !== ''
    if (hasBudget === (m.ownBudgetCents !== undefined)) return { refusal: `Campaign "${c.name}": give budgetId (a budget, or "new") or ownBudgetCents (a budget of its own), not both.` }
    const fromId = c.budget?.budgetId ?? null
    const fromCents = fromId ? amountOf(fromId) : null
    const fromLabel = c.budget ? `${c.budget.shared ? `shared "${c.budget.name ?? fromId}"` : 'its own budget'} ${money(fromCents, currency)}` : '(none)'
    let toRes: string
    let toLabel: string
    let toCents: number | null
    let ownOp: number | null = null
    if (hasBudget) {
      if (m.budgetId === NEW_BUDGET) {
        if (!request.create) return { refusal: `Campaign "${c.name}": budgetId "new" needs create (the new shared budget).` }
        toRes = budgetRes(NEW_BUDGET_TEMP_ID)
        toCents = request.create.amountCents
        toLabel = `new shared "${request.create.name.trim()}" ${money(toCents, currency)}`
      } else {
        const b = budgetById.get(m.budgetId!)
        if (!b) return { refusal: `Budget ${m.budgetId} is not in this account (or it is removed).` }
        if (fromId === b.budgetId) { skipped.push(`"${c.name}" already uses "${b.name ?? b.budgetId}".`); continue }
        if (!b.shared && b.usedBy > 0) return { refusal: `Budget "${b.name ?? b.budgetId}" is the own budget of another campaign: Google lets only a shared budget serve several campaigns.` }
        toRes = budgetRes(b.budgetId)
        toCents = amountOf(b.budgetId)
        toLabel = `${b.shared ? `shared "${b.name ?? b.budgetId}"` : `budget "${b.name ?? b.budgetId}"`} ${money(toCents, currency)}`
      }
    } else {
      const tempId = ownTempId--
      ownOp = operations.length
      operations.push({ campaignBudgetOperation: { create: { resourceName: budgetRes(tempId), amountMicros: microsOfCents(m.ownBudgetCents!), explicitlyShared: false, deliveryMethod: 'STANDARD' } } })
      toRes = budgetRes(tempId)
      toCents = m.ownBudgetCents!
      toLabel = `its own budget ${money(toCents, currency)}`
    }
    operations.push({ campaignOperation: { update: { resourceName: `${customer}/campaigns/${c.campaignId}`, campaignBudget: toRes }, updateMask: 'campaign_budget' } })
    lines.push([`campaign "${c.name}" budget`, fromLabel, `${toLabel} a day`])
    before.campaigns.push({ campaignId: c.campaignId, budgetId: fromId })
    after.campaigns.push({ campaignId: c.campaignId, budgetId: ownOp !== null ? `${OWN_BUDGET}${ownOp}` : m.budgetId === NEW_BUDGET ? NEW_BUDGET : m.budgetId! })
    if (toCents !== null && (fromCents === null || toCents > fromCents)) {
      spends.push(`Gives "${c.name}" a bigger daily budget: ${money(fromCents, currency)} → ${money(toCents, currency)}${c.status === 'ENABLED' ? '' : ` (the campaign is ${String(c.status ?? 'not enabled').toLowerCase()}: nothing spends until it is enabled)`}.`)
    }
    if (c.budget?.shared) warnings.push(`"${c.name}" leaves the shared budget "${c.budget.name ?? fromId}"; the other campaigns on it keep it.`)
  }

  if (operations.length === 0) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes, more } = changeLines(lines)
  const parts: string[] = []
  if (request.create) parts.push(`make the shared budget "${request.create.name.trim()}" (${money(request.create.amountCents, currency)} a day)`)
  if (after.amounts.length) parts.push(`set the daily amount of ${plural(after.amounts.length, 'budget')}`)
  if (after.campaigns.length) parts.push(`put ${plural(after.campaigns.length, 'campaign')} on ${after.campaigns.every((c) => c.budgetId === after.campaigns[0].budgetId) && after.campaigns[0].budgetId ? 'the budget asked' : 'the budgets asked'}`)
  const touched = new Set([...amounts.map((a) => a.budgetId), ...moves.map((m) => m.budgetId).filter((id): id is string => !!id && id !== NEW_BUDGET)])
  return {
    summary: `Google Ads budgets: ${parts.join('; ')}.`,
    changes,
    totals: { operations: operations.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      budgets: live.budgets.filter((b) => touched.has(b.budgetId) || moves.some((m) => campaignById.get(m.campaignId)?.budget?.budgetId === b.budgetId))
        .map((b) => ({ budgetId: b.budgetId, amountCents: b.amountCents, shared: b.shared, usedBy: b.usedBy })).sort((x, y) => x.budgetId.localeCompare(y.budgetId)),
      campaigns: moves.map((m) => campaignById.get(m.campaignId)).filter(Boolean).map((c) => ({ campaignId: c!.campaignId, budgetId: c!.budget?.budgetId ?? null, status: c!.status })),
      names: request.create ? live.budgets.map((b) => (b.name ?? '').toLowerCase()).sort() : undefined,
    },
    before,
    after,
  }
}

/**
 * The record of a run, with the ids Google gave what it made: the new shared budget (the first operation's result) and
 * each campaign's own new budget (the result of the operation that made it).
 */
export function budgetRecordAfterRun(after: BudgetChangeRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): BudgetChangeRecord {
  const idAt = (index: number): string | null => {
    const name = responses[index]?.campaignBudgetResult?.resourceName
    return name ? name.slice(name.lastIndexOf('/') + 1) : null
  }
  const made = 'createdBudgetId' in after ? idAt(0) : undefined
  const resolve = (budgetId: string | null): string | null =>
    budgetId === NEW_BUDGET ? made ?? null : budgetId?.startsWith(OWN_BUDGET) ? idAt(Number(budgetId.slice(OWN_BUDGET.length))) : budgetId
  return {
    amounts: after.amounts.map((a) => ({ ...a })),
    campaigns: after.campaigns.map((c) => ({ campaignId: c.campaignId, budgetId: resolve(c.budgetId) })),
    ...(made !== undefined ? { createdBudgetId: made } : {}),
  }
}
