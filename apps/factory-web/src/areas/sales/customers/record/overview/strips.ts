import type { WarningCode } from '../../../../parties/_shared/api'
import { WARNING_ACTION, type NextAction } from '../../../../parties/_shared/model'
import type { Glance } from '../../depth/api'
import { overdueOf } from '../../money/model'
import { moneyDoor, quotesDoor, tabDoor, termsDoor } from './doors'
import { amountOf, dayOf, depth, glanceOf, joined, linkDoor, ov, readyOf, say, stepDoor, text, type LabelledDoor, type MoneyParam, type OverviewInput, type OverviewStrip, type OverviewStrips, type Say } from './model'

/**
 * F-CO-101 (customer page › Overview; 10-design §2.2; lead settles S8, S21–S23) — what stops the customer, the most blocking first:
 *
 *   1 Blocked                      the party's status; NO button (S23: the ⋯ menu's Unblock stays the one path) — the line that
 *                                  names it only for a reader with parties.block
 *   2 On hold (one per hold)       the glance's holds; a Credit hold says "Over the credit limit" as its own line (S8: ONE strip);
 *                                  door → Terms & requirements › Hold (the Hold card's own Release…)
 *   3 Over the credit limit        only when no Credit hold says it; door → Money at the credit
 *   4 Can't invoice yet            one line per warning that blocks an invoice, today's own step per kind (at most three)
 *   5 VIES not proven              the standing in words; Check VIES in place
 *   6 Overdue                      NEVER a count of invoices (S22): the amounts per currency when the read carries them, else the
 *                                  words "Invoices are late"; "Oldest N days late"; door → Money at what is to collect
 *   7 Accepted quotes wait         the page's count read; door → Quotes & incoming at "Accepted, order waits"
 *   8 Customer urgency             over its limit, or off with marks kept; door → Portal settings
 *
 * A door or a button the reader has no right for is NOT in the model (never held for a right); a button is held with words only by
 * state — an archived customer, a check that runs. A strip whose read is not in is absent; the glance's failure is said (never silent).
 */

/** The step that fixes a warning (today's own: the identity dialogs, the Edit dialog, People & addresses); null: none here. */
export function stepDoorOf(action: NextAction, prefix: string, partyId: string, held: Say | null): LabelledDoor | null {
  if (action === 'identity') return stepDoor('identity', say('step.action.identity'), { kind: 'act', act: 'identity' }, held)
  if (action === 'correctIdentity') return stepDoor('correctIdentity', say('step.action.correctIdentity'), { kind: 'act', act: 'correctIdentity' }, held)
  if (action === 'edit') return stepDoor('edit', say('step.action.edit'), { kind: 'act', act: 'edit' }, held)
  // A customer's addresses and contacts are added on People & addresses (as today's Next steps).
  if (action === 'address' || action === 'contact') return stepDoor(action, say(`step.action.${action}`), { kind: 'href', href: tabDoor(prefix, partyId, 'people') }, held)
  return null
}

/** How far over the limit, and the limit — only when the read carries the amounts (the price grain); else null. */
export function overAmountsOf(credit: NonNullable<Glance['credit']>): { readonly over: MoneyParam; readonly limit: MoneyParam } | null {
  if (credit.currency === null || typeof credit.limit !== 'number') return null
  const over = typeof credit.overLimitBy === 'number' && credit.overLimitBy > 0 ? credit.overLimitBy : typeof credit.available === 'number' ? -credit.available : null
  return over === null ? null : { over: amountOf(over, credit.currency), limit: amountOf(credit.limit, credit.currency) }
}

export function stripsOf(input: OverviewInput): OverviewStrips {
  const { party, can, prefix } = input
  const id = party.id
  const archived = party.status === 'ARCHIVED'
  const glance = glanceOf(input.glance)
  const rows: OverviewStrip[] = []

  // 1 — Blocked (no button: S23).
  if (party.status === 'BLOCKED') {
    const lines: Say[] = []
    if (party.blocked?.reason) lines.push(say('record.blockedReason', { reason: party.blocked.reason }))
    if (can.block) lines.push(ov('strip.unblock'))
    rows.push({ key: 'blocked', kind: 'blocked', tone: 'danger', title: say('status.BLOCKED'), since: party.blocked?.at ?? null, lines, doors: [] })
  }

  // 2 — On hold, one strip per hold in force (the screen's company and every-company holds: the glance).
  const holds = glance?.hold.onHold ? glance.hold.holds : []
  const credit = glance?.credit ?? null
  const company = glance?.company.name ?? ''
  let creditSaid = false
  for (const hold of holds) {
    const lines: Say[] = []
    if (hold.words.trim() !== '') lines.push(text(hold.words))
    if (hold.reason === 'CREDIT') {
      creditSaid = true
      if (credit?.state === 'OVER') {
        const amounts = overAmountsOf(credit)
        lines.push(amounts ? ov('strip.overLimit', { amount: amounts.over, limit: amounts.limit }) : depth('credit.over'))
      }
    }
    lines.push(hold.placedBy ? depth('status.since', { date: dayOf(hold.placedAt), by: hold.placedBy }) : depth('status.sinceSystem', { date: dayOf(hold.placedAt) }))
    rows.push({
      key: `hold-${hold.id}`,
      kind: 'hold',
      tone: 'danger',
      title: ov('strip.hold', { reason: depth(`reason.${hold.reason}`), company: hold.everyCompany ? depth('hold.everyCompany') : text(company) }),
      since: hold.placedAt,
      lines,
      doors: [linkDoor('hold', depth('status.openHold'), termsDoor(prefix, id, 'hold'))],
    })
  }

  // 3 — Over the credit limit, when no Credit hold says it (the API sends no credit part without sales.credit.view).
  if (credit?.state === 'OVER' && !creditSaid) {
    const amounts = overAmountsOf(credit)
    rows.push({
      key: 'credit',
      kind: 'credit',
      tone: 'warning',
      title: depth('credit.over'),
      since: null,
      lines: amounts ? [joined([depth('credit.overBy', { amount: amounts.over }), depth('credit.ofLimit', { limit: amounts.limit })], ' ')] : [],
      doors: can.moneyTab ? [linkDoor('money', say('customers.tab.money'), moneyDoor(prefix, id, 'credit'))] : [],
    })
  }

  // 4 — Can't invoice yet: one line per warning that blocks an invoice, one button per kind of step.
  if (party.invoiceBlocked) {
    const blocking: WarningCode[] = []
    for (const warning of party.warnings) if (warning.blocksInvoice) blocking.push(warning.code)
    const doors: LabelledDoor[] = []
    if (can.manage) {
      const held = archived ? say('held.archived') : null
      const seen = new Set<NextAction>()
      for (const code of blocking) {
        const action = WARNING_ACTION[code]
        if (seen.has(action)) continue
        seen.add(action)
        const door = stepDoorOf(action, prefix, id, held)
        if (door) doors.push(door)
      }
    }
    rows.push({ key: 'invoice', kind: 'invoice', tone: 'danger', title: say('list.cannotInvoice'), since: null, lines: blocking.map((code) => say(`warning.${code}`)), doors: doors.slice(0, 3) })
  }

  // 5 — VIES not proven: the button tests parties.vies ITSELF (hidden without it); held with words only while archived or checking.
  if (party.warnings.some((warning) => warning.code === 'VIES_NOT_PROVEN')) {
    const vies = party.vies
    const standing = vies.checkedAt && vies.state !== 'UNCHECKED' && vies.state !== 'NOT_APPLICABLE' ? say(`vies.stateOn.${vies.state}`, { date: dayOf(vies.checkedAt) }) : say(`vies.state.${vies.state}`)
    const held = archived ? say('held.archived') : input.viesRunning ? say('vies.checking') : null
    rows.push({
      key: 'vies',
      kind: 'vies',
      tone: 'warning',
      title: say('warning.VIES_NOT_PROVEN'),
      since: null,
      lines: [standing],
      doors: can.vies ? [stepDoor('vies', say('vies.checkNow'), { kind: 'act', act: 'checkVies' }, held)] : [],
    })
  }

  // 6 — Overdue (receivables.view). S22: never a count of late invoices; an amount only when every late group carries one.
  if (can.receivables && input.money.ageing.items) {
    const overdue = overdueOf(input.money.ageing.items, id)
    if (overdue) {
      const amounts: MoneyParam[] = []
      let priced = overdue.amounts.length > 0
      for (const entry of overdue.amounts) {
        if (entry.amount === null) priced = false
        else amounts.push(amountOf(entry.amount, entry.currency))
      }
      rows.push({
        key: 'overdue',
        kind: 'overdue',
        tone: 'warning',
        title: priced ? ov('strip.overdue', { amount: joined(amounts) }) : ov('strip.invoicesLate'),
        since: null,
        lines: overdue.daysLate ? [ov('strip.oldest', { count: overdue.daysLate })] : [],
        doors: can.moneyTab ? [linkDoor('money', say('customers.tab.money'), moneyDoor(prefix, id, 'collect'))] : [],
      })
    }
  }

  // 7 — Accepted quotes wait for their order (the count is null without quotes.view: no strip).
  const waits = input.counts.counts?.groups.ORDER_WAITS ?? null
  if (waits !== null && waits > 0) {
    rows.push({
      key: 'orderWaits',
      kind: 'orderWaits',
      tone: 'warning',
      title: depth('hold.waiting', { count: waits }),
      since: null,
      lines: holds.length > 0 ? [depth('hold.waitingHint')] : [],
      doors: can.quotesTab ? [linkDoor('quotes', say('customers.tab.quotes'), quotesDoor(prefix, id, 'ORDER_WAITS'))] : [],
    })
  }

  // 8 — The customer's own urgency: over its limit, or off with marks kept (partners.view: `off` without it, so absent).
  const urgency = readyOf(input.urgency)
  if (urgency && (urgency.overQuota !== null || urgency.dormant !== null)) {
    rows.push({
      key: 'urgency',
      kind: 'urgency',
      tone: 'info',
      title: urgency.overQuota !== null ? ov('strip.urgencyOver') : say('production:customerCard.urgency.off'),
      since: null,
      lines: [say('portal-access:limits.urgency.maxHint', { max: urgency.max, now: urgency.now })],
      doors: can.partners ? [linkDoor('portal', say('customers.tab.portal'), tabDoor(prefix, id, 'portal'))] : [],
    })
  }

  return { rows, reading: input.glance.status === 'loading', failed: input.glance.status === 'error' ? ov('strip.failed') : null }
}
