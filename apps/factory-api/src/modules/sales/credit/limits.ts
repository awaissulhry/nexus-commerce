import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { isCustomer, type PartyRole } from '@nexus/factory-domain/parties/rules'
import { availableOf, CREDIT_LIMITS, findingsOf, limitProblems, ORDER_STEPS, overLimitBy, usedOf, usedPercent, type CreditReading, type CreditStep } from '@nexus/factory-domain/sales/credit/credit'
import { SALES_CREDIT_LIMITS, SALES_CREDIT_VIEW } from '@nexus/factory-domain/sales/credit/permissions'
import { command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyTermsRow } from '../../parties/company-terms/in-force'
import { assertWritable, lockParty } from '../../parties/store'
import { mayOn, officeOf, seesPrices } from './access'
import { newestCheck } from './check'
import { recheckHeldOrders } from './override'
import { readAmounts, type Reader } from './reading'

/**
 * Finance › Receivables › Credit limits (B-W2b-304; SAL-237; design finance.receivables sec:credit "Limit, used (open
 * invoices + unbilled orders), available, orders on hold"; "Change limit (logged, ActionConfirm)"):
 *
 *   GET /sales/credit/limits?companyId&q&view=ALL|OVER|HELD&cursor&limit    (sales.credit.view; each row over its company
 *        and customer) every customer with a limit with a company (the live PartyCompanyTerms rows that carry one):
 *        limit, used, available, the share used, over by, overdue, a credit hold, what is held for credit now (orders
 *        waiting, releases and shipments held) with the first orders; tiles: customers with a limit, over it, with
 *        something held. Amounts only with the price grain.
 *   PUT /sales/credit/limits/:partyId/:companyId {version?, amount|null, currency|null, reason}    (sales.credit.limits
 *        over the customer and the company) the limit set (the company's terms row made when it has none: its other
 *        fields null, so the party's own apply), changed or cleared (null), with the reason in the audit row; then the
 *        customer's orders waiting for credit are checked again in the same command (those that pass go on).
 *
 * The limit lives on B-W2b-279's PartyCompanyTerms row (B-W2b-290's PUT never writes it; its END refuses a row with one).
 */

export const LIMIT_VIEWS = ['ALL', 'OVER', 'HELD'] as const
export type LimitView = (typeof LIMIT_VIEWS)[number]

export interface LimitsQuery {
  readonly companyId?: string | undefined
  readonly q?: string | undefined
  readonly view?: LimitView | undefined
  readonly cursor?: number | undefined
  readonly limit?: number | undefined
}

/** What is held for credit now of the customer with the company: waiting orders, releases and shipments held. */
async function heldOf(db: Reader, partyId: string, companyId: string) {
  const waiting = await db.salesOrder.findMany({ where: { partyId, companyId, status: 'PENDING_APPROVAL' }, select: { id: true, number: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50 })
  const orders: { id: string; number: string }[] = []
  for (const order of waiting) {
    const step = (await db.creditCheck.findFirst({ where: { recordType: 'SalesOrder', recordId: order.id, step: { in: [...ORDER_STEPS] } }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], select: { step: true } }))?.step
    if (!step) continue
    if ((await newestCheck(db, { step: step as CreditStep, recordType: 'SalesOrder', recordId: order.id }))?.held) orders.push(order)
  }
  // A release or a shipment is held while its newest check is a HOLD no yes let through (its step not done yet).
  const holds = await db.creditCheck.findMany({ where: { partyId, companyId, step: { in: ['RELEASE', 'SHIPMENT'] }, result: 'HOLD', overridesCheckId: null }, select: { id: true, step: true, recordType: true, recordId: true }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], take: 100 })
  let releases = 0
  let shipments = 0
  const seen = new Set<string>()
  for (const hold of holds) {
    const key = `${hold.recordType}|${hold.recordId}`
    if (seen.has(key)) continue
    seen.add(key)
    const last = await newestCheck(db, { step: hold.step as CreditStep, recordType: hold.recordType, recordId: hold.recordId, partyId })
    if (last?.id !== hold.id) continue
    const open =
      hold.recordType === 'WorkOrder'
        ? ['DRAFT', 'ON_HOLD'].includes((await db.workOrder.findUnique({ where: { id: hold.recordId }, select: { status: true } }))?.status ?? 'GONE')
        : ['DRAFT', 'PACKED'].includes((await db.shipment.findUnique({ where: { id: hold.recordId }, select: { status: true } }))?.status ?? 'GONE')
    if (!open) continue
    if (hold.step === 'RELEASE') releases++
    else shipments++
  }
  return { orders, releases, shipments }
}

function rowOf(context: OfficeContext, base: { termsId: string; version: number; updatedAt: Date; party: { id: string; code: string; legalName: string }; company: { id: string; code: string } }, reading: CreditReading, held: Awaited<ReturnType<typeof heldOf>>) {
  return {
    termsId: base.termsId,
    version: base.version,
    party: { id: base.party.id, code: base.party.code, name: base.party.legalName },
    company: base.company,
    currency: reading.currency,
    limit: asMoney('price', reading.limit),
    used: asMoney('price', usedOf(reading)),
    openOrders: asMoney('price', reading.openOrders),
    openInvoices: asMoney('price', reading.openInvoices),
    overdue: asMoney('price', reading.overdue),
    available: asMoney('price', availableOf(reading)),
    overLimitBy: asMoney('price', overLimitBy(reading)),
    // A ratio of price-grain figures: only beside them.
    usedPct: seesPrices(context) ? usedPercent(reading) : null,
    onHold: reading.onHold,
    findings: findingsOf(reading),
    held: { orders: held.orders.length, releases: held.releases, shipments: held.shipments, firstOrders: held.orders.slice(0, 5) },
    changedAt: toUtcIso(base.updatedAt),
    mayChange: mayOn(context, SALES_CREDIT_LIMITS, { companyId: base.company.id, partyId: base.party.id }),
  }
}

export type LimitRow = ReturnType<typeof rowOf>

async function readRows(db: Reader, context: OfficeContext, filter: { companyId?: string | undefined; partyId?: string | undefined }) {
  const terms = await db.partyCompanyTerms.findMany({
    where: { endedAt: null, creditLimitAmount: { not: null }, ...(filter.companyId ? { companyId: filter.companyId } : {}), ...(filter.partyId ? { partyId: filter.partyId } : {}) },
    select: { id: true, partyId: true, companyId: true, creditLimitAmount: true, creditLimitCurrency: true, version: true, updatedAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const visible = terms.filter((row) => mayOn(context, SALES_CREDIT_VIEW, { companyId: row.companyId, partyId: row.partyId }))
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(visible.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((party) => [party.id, party]))
  const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(visible.map((row) => row.companyId))] } }, select: { id: true, code: true } })).map((company) => [company.id, company]))
  const now = serverClock.now()
  const rows: LimitRow[] = []
  for (const row of visible) {
    const party = parties.get(row.partyId)
    const company = companies.get(row.companyId)
    if (!party || !company) continue
    const reading = await readAmounts(db, { partyId: row.partyId, companyId: row.companyId, currency: row.creditLimitCurrency!, limit: row.creditLimitAmount, now })
    rows.push(rowOf(context, { termsId: row.id, version: row.version, updatedAt: row.updatedAt, party, company }, reading, await heldOf(db, row.partyId, row.companyId)))
  }
  return rows
}

const heldCount = (row: LimitRow): number => row.held.orders + row.held.releases + row.held.shipments

/** GET /sales/credit/limits (sales.credit.view). */
export async function listLimits(caller: CommandCaller, query: LimitsQuery) {
  const context = officeOf(caller)
  if (query.companyId !== undefined && !isUuid(query.companyId)) throw new ValidationError('Not a company.', [{ path: 'query/companyId', message: 'A company id.' }])
  const view = query.view ?? 'ALL'
  const size = Math.min(Math.max(query.limit ?? 100, 1), 200)
  const start = Math.max(query.cursor ?? 0, 0)
  return caller.withClient(async (db) => {
    const all = await readRows(db, context, { companyId: query.companyId })
    const needle = query.q?.trim().toLowerCase() ?? ''
    const matching = needle ? all.filter((row) => row.party.code.toLowerCase().includes(needle) || row.party.name.toLowerCase().includes(needle)) : all
    const over = (row: LimitRow) => row.findings.includes('OVER_LIMIT') || (row.available !== null && (row.available as number) < 0)
    const filtered = matching
      .filter((row) => (view === 'OVER' ? over(row) : view === 'HELD' ? heldCount(row) > 0 : true))
      .sort((a, b) => heldCount(b) - heldCount(a) || (b.usedPct ?? 0) - (a.usedPct ?? 0) || a.party.name.localeCompare(b.party.name) || a.termsId.localeCompare(b.termsId))
    return {
      readAt: toUtcIso(serverClock.now()),
      tiles: { customers: matching.length, over: matching.filter(over).length, held: matching.filter((row) => heldCount(row) > 0).length, heldOrders: matching.reduce((sum, row) => sum + row.held.orders, 0) },
      rows: filtered.slice(start, start + size),
      count: filtered.length,
      next: start + size < filtered.length ? start + size : null,
    }
  })
}

export interface LimitBody {
  /** The terms row's version when the company has terms with the customer (absent: they are made). */
  readonly version?: number | undefined
  /** Minor units of `currency`; null clears the limit (absent: refused, it is the price grain's field). */
  readonly amount?: number | null | undefined
  readonly currency: string | null
  /** Why the limit changes (the audit row's reason). */
  readonly reason: string
}

/** PUT /sales/credit/limits/:partyId/:companyId (sales.credit.limits). */
export async function setLimit(caller: CommandCaller, partyId: string, companyId: string, body: LimitBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (!isUuid(partyId) || !isUuid(companyId)) throw new NotFoundError('Customer or company not found.')
  const reason = body.reason?.trim() ?? ''
  if (body.amount === undefined) throw new ValidationError('Send the new limit, or null to clear it.', [{ path: 'body/amount', message: 'The limit (minor units) or null.' }])
  const amount: number | null = body.amount
  const problems = limitProblems({ amount, currency: amount === null ? null : body.currency }).map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
  if (reason === '' || reason.length > CREDIT_LIMITS.words || /[\r\n]/.test(reason)) problems.push({ path: 'body/reason', message: 'Say why the limit changes, in one line of at most 500 characters.' })
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The credit limit is not valid.', problems)
  const target = await caller.withClient(async (db) => {
    const party = await db.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, legalName: true, roles: true, status: true, companyId: true } })
    const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, code: true } })
    return party && company ? { party, company } : null
  })
  if (!target || !mayOn(context, SALES_CREDIT_VIEW, { companyId, partyId })) throw new NotFoundError('Customer or company not found.')
  if (!mayOn(context, SALES_CREDIT_LIMITS, { companyId, partyId })) throw new ForbiddenError(`You may not change ${target.party.code}'s credit limit with ${target.company.code}.`)
  if (!isCustomer(target.party.roles as PartyRole[])) throw new InvalidStateError(`${target.party.code} is not a customer: a credit limit is a customer's.`)
  if (target.party.companyId !== null && target.party.companyId !== companyId) throw new ValidationError(`${target.party.code} is a customer of another company only.`, [{ path: 'params/companyId', message: "The customer's own company." }])
  assertWritable(target.party.status as 'ACTIVE')
  const live = await caller.withClient((db) => companyTermsRow(db, partyId, companyId))
  // A limit already set changes only at the version read (two people changing it at once); a first limit may be set on
  // terms the company has with the customer for its other fields (B-W2b-290's) without their version: only the limit moves.
  if (live?.creditLimitAmount !== null && live !== null && body.version === undefined) throw new DomainError('conflict', `${target.party.code} has a credit limit with ${target.company.code}: send the version you read to change it.`, [{ path: 'body/version', message: `The terms are at version ${live.version}.` }])
  if ((!live || live.creditLimitAmount === null) && amount === null) throw new InvalidStateError(`${target.party.code} has no credit limit with ${target.company.code}: nothing to clear.`)
  const spec = live && body.version !== undefined
    ? { name: 'credit.setLimit' as const, idempotencyKey, input: { partyId, companyId, ...body }, record: { type: 'PartyCompanyTerms' as const, id: live.id, expectedVersion: body.version! } }
    : { name: 'credit.setLimit' as const, idempotencyKey, input: { partyId, companyId, ...body } }
  const { result } = await command(caller, spec, async (tools) => {
    const { tx, now } = tools
    assertWritable((await lockParty(tx, partyId)).status)
    const current = await companyTermsRow(tx, partyId, companyId)
    if ((current?.id ?? null) !== (live?.id ?? null)) throw new DomainError('conflict', `${target.party.code}'s terms with ${target.company.code} changed meanwhile: reload them.`, [{ path: 'body/version', message: 'Changed meanwhile.' }])
    const before = current ? { amount: current.creditLimitAmount, currency: current.creditLimitCurrency } : { amount: null, currency: null }
    const next = { amount, currency: amount === null ? null : body.currency }
    const id = current?.id ?? newId()
    if (current) {
      await tx.partyCompanyTerms.update({ where: { id }, data: { creditLimitAmount: next.amount, creditLimitCurrency: next.currency, updatedById: context.actorId, updatedAt: now }, select: { id: true } })
    } else {
      await tx.partyCompanyTerms.create({ data: { id, partyId, companyId, creditLimitAmount: next.amount, creditLimitCurrency: next.currency, updatedById: context.actorId, createdById: context.actorId, createdAt: now, updatedAt: now }, select: { id: true } })
    }
    tools.audit({
      action: 'credit.setLimit',
      recordType: 'PartyCompanyTerms',
      recordId: id,
      companyId,
      before: { partyId, creditLimit: markMoney('price', before.amount), currency: before.currency },
      after: { partyId, creditLimit: markMoney('price', next.amount), currency: next.currency },
      reason,
    })
    // The customer's orders waiting for credit are checked again: a raised (or cleared) limit lets those within it go on.
    const rechecked = await recheckHeldOrders(tools, partyId, companyId, true)
    tools.emit({ type: 'credit_limit.changed', subject: partyId, companyId, payload: { partyId, termsId: id, change: next.amount === null ? 'CLEARED' : 'SET', rechecked } })
    return { termsId: id, rechecked }
  })
  const rows = await caller.withClient((db) => readRows(db, context, { companyId, partyId }))
  return { row: rows[0] ?? null, rechecked: result.rechecked }
}
