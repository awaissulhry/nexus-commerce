/**
 * Google Ads changes (2026-10-15) — budgets: make a shared budget, change a budget's daily amount, rename a shared budget,
 * and put campaigns on a budget (a shared one, the new one, or a new budget of their own: "detach"). One atomic request.
 *
 * Rename (programme 2 group G3, checked 2026-10-15 in the v25 reference rpc/v25/CampaignBudget): `name` is mutable; "every
 * explicitly shared campaign budget must have a non-null, non-empty name"; "Campaign budgets that are not explicitly
 * shared derive their name from the attached campaign's name" (so only a shared budget is renamed here); "between 1 and
 * 255, inclusive, in UTF-8 bytes, (trimmed)". Update mask `name`.
 *
 * Money: a raise of a daily amount, and a campaign moved onto a bigger budget, can make the account spend more — each is
 * named in `spendsMoney` (the person's decision). A new budget spends nothing until a campaign that is ENABLED uses it.
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { microsOfCents, type LiveBudget, type LiveCampaign } from './live.js'
import type { GoogleMutateOperation } from './write-client.js'

export interface BudgetChangeRequest {
  /** A new SHARED budget. */
  create?: { name: string; budgetCents: number }
  /** New daily amounts of existing budgets. */
  amounts?: Array<{ budgetId: string; budgetCents: number }>
  /** New names of shared budgets. */
  renames?: Array<{ budgetId: string; name: string }>
  /** Which budget each campaign uses: an existing one (`budgetId`), the new one (`budgetId: 'new'`), or a new budget of its own (`ownBudgetCents`). */
  campaigns?: Array<{ campaignId: string; budgetId?: string; ownBudgetCents?: number }>
}

export interface BudgetLiveState {
  budgets: LiveBudget[]
  campaigns: LiveCampaign[]
}

/** What the change replaced and wrote: amounts per budget, and the budget each campaign was on. */
export interface BudgetChangeRecord {
  amounts: Array<{ budgetId: string; budgetCents: number | null }>
  campaigns: Array<{ campaignId: string; budgetId: string | null }>
  /** Shared budgets renamed: before the old name, after the new one (only when the change renames). */
  names?: Array<{ budgetId: string; name: string | null }>
  /** A budget the change made (its id is known after it ran; `new` before). */
  createdBudgetId?: string | null
}

/**
 * What the budgets of the ENABLED campaigns add up to a day (each budget once, however many campaigns share it): the
 * account's daily spending cap. `budgetOf` gives a campaign's budget id; `amountOf` a budget's amount; `ownOf` the
 * amount of a budget of its own a campaign gets (counted per campaign).
 */
function enabledDailyTotal(
  campaigns: LiveCampaign[],
  budgetOf: (c: LiveCampaign) => string | null,
  amountOf: (budgetId: string) => number | null,
  ownOf: (c: LiveCampaign) => number | null = () => null,
): number {
  const counted = new Set<string>()
  let total = 0
  for (const c of campaigns) {
    if (c.status !== 'ENABLED') continue
    const own = ownOf(c)
    if (own !== null) { total += own; continue }
    const id = budgetOf(c)
    if (!id || counted.has(id)) continue
    counted.add(id)
    total += amountOf(id) ?? 0
  }
  return total
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
  const renames = request.renames ?? []
  if (!request.create && amounts.length === 0 && moves.length === 0 && renames.length === 0) return { refusal: 'Say what to change: create, amounts, renames or campaigns.' }
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

  // 0. new names of shared budgets: Google refuses a name another budget has (after this change), and an empty one
  const renameTo = new Map<string, string>()
  const renameSeen = new Set<string>()
  for (const r of renames) {
    if (renameSeen.has(r.budgetId)) return { refusal: `Budget ${r.budgetId} is named twice in renames.` }
    renameSeen.add(r.budgetId)
    const b = budgetById.get(r.budgetId)
    if (!b) return { refusal: `Budget ${r.budgetId} is not in this account (or it is removed). google-ads-live view budgets lists them.` }
    if (!b.shared) return { refusal: `Budget ${r.budgetId} is a campaign's own budget: Google names it after its campaign (rename the campaign: set-google-campaign).` }
    const name = r.name.trim()
    const bytes = new TextEncoder().encode(name).length
    if (bytes < 1 || bytes > 255) return { refusal: `The budget name "${name.slice(0, 40)}" is ${bytes} bytes long: Google takes 1 to 255 (UTF-8).` }
    if (name === (b.name ?? '').trim()) { skipped.push(`Shared budget "${name}" (${b.budgetId}) already has that name.`); continue }
    renameTo.set(b.budgetId, name)
  }
  const nameKeyAfter = (b: LiveBudget) => (renameTo.get(b.budgetId) ?? b.name ?? '').trim().toLowerCase()
  for (const [budgetId, name] of renameTo) {
    if (live.budgets.some((b) => b.budgetId !== budgetId && nameKeyAfter(b) === name.toLowerCase())) {
      return { refusal: `A budget named "${name}" would then exist twice in this account: Google refuses that. Choose another name.` }
    }
  }

  // 1. the new shared budget
  if (request.create) {
    const name = request.create.name.trim()
    if (live.budgets.some((b) => nameKeyAfter(b) === name.toLowerCase())) {
      return { refusal: `A budget named "${name}" already exists in this account: Google refuses a second one. Use its budgetId, or another name.` }
    }
    operations.push({
      campaignBudgetOperation: {
        create: { resourceName: budgetRes(NEW_BUDGET_TEMP_ID), name, amountMicros: microsOfCents(request.create.budgetCents), explicitlyShared: true, deliveryMethod: 'STANDARD' },
      },
    })
    lines.push([`new shared budget "${name}"`, '(none)', `${money(request.create.budgetCents, currency)} a day`])
    after.createdBudgetId = NEW_BUDGET
  }

  // 2. new daily amounts
  const renamedWithAmount = new Set<string>()
  const amountAfter = new Map<string, number>()
  const seenAmounts = new Set<string>()
  for (const a of amounts) {
    if (seenAmounts.has(a.budgetId)) return { refusal: `Budget ${a.budgetId} is named twice in amounts.` }
    seenAmounts.add(a.budgetId)
    const b = budgetById.get(a.budgetId)
    if (!b) return { refusal: `Budget ${a.budgetId} is not in this account (or it is removed). google-ads-live view budgets lists them.` }
    if (b.amountCents === a.budgetCents) { skipped.push(`"${b.name ?? b.budgetId}" is already ${money(a.budgetCents, currency)} a day.`); continue }
    // A budget renamed too is ONE update (amount and name), never two operations on one budget.
    const newName = renameTo.get(b.budgetId)
    if (newName) renamedWithAmount.add(b.budgetId)
    operations.push({
      campaignBudgetOperation: { update: { resourceName: budgetRes(b.budgetId), amountMicros: microsOfCents(a.budgetCents), ...(newName ? { name: newName } : {}) }, updateMask: newName ? 'amount_micros,name' : 'amount_micros' },
    })
    amountAfter.set(b.budgetId, a.budgetCents)
    lines.push([`budget "${b.name ?? b.budgetId}"`, `${money(b.amountCents, currency)} a day`, `${money(a.budgetCents, currency)} a day`])
    before.amounts.push({ budgetId: b.budgetId, budgetCents: b.amountCents })
    after.amounts.push({ budgetId: b.budgetId, budgetCents: a.budgetCents })
    if (b.amountCents === null || a.budgetCents > b.amountCents) {
      const enabled = b.campaigns.filter((c) => c.status === 'ENABLED').length
      spends.push(`Raises "${b.name ?? b.budgetId}" from ${money(b.amountCents, currency)} to ${money(a.budgetCents, currency)} a day${enabled === 0 ? ' (no campaign on it is enabled now: nothing spends until one is)' : ` (${plural(enabled, 'enabled campaign')} on it)`}.`)
    }
  }

  // 2b. the names
  if (renameTo.size) { before.names = []; after.names = [] }
  for (const [budgetId, name] of renameTo) {
    const b = budgetById.get(budgetId)!
    if (!renamedWithAmount.has(budgetId)) operations.push({ campaignBudgetOperation: { update: { resourceName: budgetRes(budgetId), name }, updateMask: 'name' } })
    lines.push([`shared budget "${b.name ?? budgetId}" name`, b.name ?? '(none)', name])
    before.names!.push({ budgetId, name: b.name })
    after.names!.push({ budgetId, name })
  }

  // 3. which budget each campaign uses
  let ownTempId = NEW_BUDGET_TEMP_ID - 1
  const seenCampaigns = new Set<string>()
  const amountOf = (budgetId: string): number | null => (budgetId === NEW_BUDGET ? request.create!.budgetCents : amountAfter.get(budgetId) ?? budgetById.get(budgetId)?.amountCents ?? null)
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
        toCents = request.create.budgetCents
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

  // The whole account: what the budgets of ENABLED campaigns add up to a day, before and after. A campaign leaving a
  // shared budget for one of its own, or moving to a budget no enabled campaign used, raises it without any one budget
  // going up.
  const capBefore = enabledDailyTotal(live.campaigns, (c) => c.budget?.budgetId ?? null, (id) => budgetById.get(id)?.amountCents ?? null)
  const movedTo = new Map(after.campaigns.map((c) => [c.campaignId, c.budgetId]))
  const ownCents = new Map(moves.filter((m) => m.ownBudgetCents !== undefined).map((m) => [m.campaignId, m.ownBudgetCents!]))
  const capAfter = enabledDailyTotal(
    live.campaigns,
    (c) => movedTo.get(c.campaignId) ?? c.budget?.budgetId ?? null,
    (id) => (id.startsWith(OWN_BUDGET) ? null : amountOf(id)),
    (c) => ownCents.get(c.campaignId) ?? null,
  )
  if (capAfter > capBefore) {
    spends.push(`In all, the daily budgets of the enabled campaigns rise from ${money(capBefore, currency)} to ${money(capAfter, currency)}.`)
  }

  if (operations.length === 0) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes, more } = changeLines(lines)
  const parts: string[] = []
  if (request.create) parts.push(`make the shared budget "${request.create.name.trim()}" (${money(request.create.budgetCents, currency)} a day)`)
  if (after.amounts.length) parts.push(`set the daily amount of ${plural(after.amounts.length, 'budget')}`)
  if (renameTo.size) parts.push(`rename ${plural(renameTo.size, 'shared budget')}`)
  if (after.campaigns.length) parts.push(`put ${plural(after.campaigns.length, 'campaign')} on ${after.campaigns.every((c) => c.budgetId === after.campaigns[0].budgetId) && after.campaigns[0].budgetId ? 'the budget asked' : 'the budgets asked'}`)
  const touched = new Set([...amounts.map((a) => a.budgetId), ...renameTo.keys(), ...moves.map((m) => m.budgetId).filter((id): id is string => !!id && id !== NEW_BUDGET)])
  return {
    summary: `Google Ads budgets: ${parts.join('; ')}.`,
    changes,
    totals: { operations: operations.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      // Each budget the change reads or writes, with the campaigns on it and whether they are enabled (the preview's
      // "nothing spends until one is" stands on it). A create stands on nothing more: a taken name is refused anyway.
      budgets: live.budgets.filter((b) => touched.has(b.budgetId) || moves.some((m) => campaignById.get(m.campaignId)?.budget?.budgetId === b.budgetId))
        .map((b) => ({ budgetId: b.budgetId, amountCents: b.amountCents, shared: b.shared, usedBy: b.usedBy, campaigns: b.campaigns.map((c) => `${c.campaignId}:${c.status}`).sort() }))
        .sort((x, y) => x.budgetId.localeCompare(y.budgetId)),
      campaigns: moves.map((m) => campaignById.get(m.campaignId)).filter(Boolean).map((c) => ({ campaignId: c!.campaignId, budgetId: c!.budget?.budgetId ?? null, status: c!.status })),
      // A rename stands on every budget's name (the duplicate check), and on the old name of each it renames.
      ...(renames.length ? { names: live.budgets.map((b) => `${b.budgetId}:${b.name ?? ''}`).sort() } : {}),
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
    ...(after.names ? { names: after.names.map((n) => ({ ...n })) } : {}),
    ...(made !== undefined ? { createdBudgetId: made } : {}),
  }
}
