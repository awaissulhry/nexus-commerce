import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { addCurrencyProblem, minorUnitsOf, OFFERED_CURRENCIES, switchOffProblem } from '@nexus/factory-domain/money/currency/currencies'
import { CURRENCIES_MANAGE, CURRENCIES_VIEW } from '@nexus/factory-domain/money/currency/permissions'
import { rateWords, type DayRate } from '@nexus/factory-domain/money/currency/rates'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { serverClock } from '../../core/time'
import { feedOf, type FeedView } from './feed'
import { CURRENCY_COLUMNS, dayRate, mayOnCompany, mayOnEveryCompany, noRateWords, officeOf, refused, refusingInWords, type Reader, type StoredCurrency } from './store'

/**
 * A company's currencies (B-W2b-389; PLT-132; design finance.settings "Currencies & rates": base currency): its base
 * currency (Company.currency: its books and totals; changed in Admin › Companies, never here) and the currencies its
 * documents may be in (Currency rows, switched on or off, never deleted), each with the rate a document of today takes and
 * where it comes from. Reads: currencies.view over the company. Writes: currencies.manage over the company, each ONE
 * command on the row (its version is the edit-conflict guard; the …_tax_currency_w2b_guards triggers hold the rules for
 * every login and answer 409 in words: store.ts currencyRefusal).
 *
 *   GET  /currencies?companyId                     the company's currencies, today's rates, the daily ECB switch
 *   POST /currencies {companyId, code}             a currency added (an old row switched on again instead)
 *   POST /currencies/:currencyId/switch {version, active}   switched off or on again (the base currency never off)
 */

export interface DayRateView extends DayRate {
  readonly words: string
}

export const dayRateView = (rate: DayRate): DayRateView => ({ ...rate, words: rateWords(rate) })

export interface CurrencyView {
  /** Null for a base currency the company has no row of (it is a document currency all the same). */
  readonly id: string | null
  readonly companyId: string
  readonly code: string
  readonly minorUnits: number
  readonly active: boolean
  readonly base: boolean
  readonly version: number | null
  /** The rate a document of today takes from the base currency to this one; null for the base, or when none is kept. */
  readonly rate: DayRateView | null
  /** Why a document in this currency waits (no rate near enough), or null. */
  readonly waits: string | null
  readonly updatedAt: string | null
}

export interface CurrenciesAnswer {
  readonly company: { readonly id: string; readonly code: string; readonly legalName: string; readonly base: string }
  readonly today: BusinessDate
  readonly currencies: CurrencyView[]
  /** The codes that may still be added (the euro and the ECB's list, less those on). */
  readonly offered: string[]
  readonly feed: FeedView
  readonly can: { readonly manage: boolean; readonly manageRates: boolean }
}

async function companyOf(db: Reader, companyId: string) {
  const company = isUuid(companyId) ? await db.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true, currency: true } }) : null
  if (!company) throw new NotFoundError('Company not found.')
  return company
}

async function viewOf(db: Reader, row: StoredCurrency | null, code: string, companyId: string, base: string, today: BusinessDate): Promise<CurrencyView> {
  const isBase = code === base
  const rate = !isBase && (row?.active ?? true) ? await dayRate(db, base, code, today) : null
  return {
    id: row?.id ?? null,
    companyId,
    code,
    minorUnits: row?.minorUnits ?? minorUnitsOf(code),
    active: row?.active ?? true,
    base: isBase,
    version: row?.version ?? null,
    rate: rate ? dayRateView(rate) : null,
    waits: !isBase && (row?.active ?? true) && !rate ? noRateWords(base, code, today) : null,
    updatedAt: row ? toUtcIso(row.updatedAt) : null,
  }
}

/** GET /currencies?companyId. */
export async function currenciesOf(caller: CommandCaller, query: { readonly companyId: string }): Promise<CurrenciesAnswer> {
  const context = officeOf(caller)
  if (!mayOnCompany(context, CURRENCIES_VIEW, query.companyId)) throw new ForbiddenError()
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const company = await companyOf(db, query.companyId)
    const rows = await db.currency.findMany({ where: { companyId: company.id }, select: CURRENCY_COLUMNS, orderBy: [{ active: 'desc' }, { code: 'asc' }, { createdAt: 'asc' }] })
    // One row per code: the active one, else the newest switched off.
    const byCode = new Map<string, StoredCurrency>()
    for (const row of rows) if (!byCode.has(row.code)) byCode.set(row.code, row)
    const codes = [company.currency, ...[...byCode.keys()].filter((code) => code !== company.currency)]
    const currencies = await Promise.all(codes.map((code) => viewOf(db, byCode.get(code) ?? null, code, company.id, company.currency, today)))
    const on = new Set(currencies.filter((entry) => entry.active).map((entry) => entry.code))
    return {
      company: { id: company.id, code: company.code, legalName: company.legalName, base: company.currency },
      today,
      currencies,
      offered: OFFERED_CURRENCIES.filter((code) => !on.has(code)),
      feed: await feedOf(db),
      can: { manage: mayOnCompany(context, CURRENCIES_MANAGE, company.id), manageRates: mayOnEveryCompany(context, CURRENCIES_MANAGE) },
    }
  })
}

async function oneInCommand(tools: CommandTools, id: string, base: string): Promise<CurrencyView> {
  const row = await tools.tx.currency.findUniqueOrThrow({ where: { id }, select: CURRENCY_COLUMNS })
  return viewOf(tools.tx, row, row.code, row.companyId, base, businessDate(tools.now))
}

/** POST /currencies {companyId, code}: 201 with the currency (a row switched off before is switched on again). */
export async function addCurrency(caller: CommandCaller, body: { readonly companyId: string; readonly code: string }, idempotencyKey?: string): Promise<{ currency: CurrencyView }> {
  const context = officeOf(caller)
  if (!mayOnCompany(context, CURRENCIES_MANAGE, body.companyId)) throw new ForbiddenError()
  const code = body.code.trim().toUpperCase()
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'currency.add', idempotencyKey, input: { companyId: body.companyId, code } }, async (tools) => {
      const { tx, now } = tools
      const company = await companyOf(tx, body.companyId)
      const rows = await tx.currency.findMany({ where: { companyId: company.id }, select: CURRENCY_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
      const problem = addCurrencyProblem(code, rows)
      if (problem) {
        if (rows.some((row) => row.code === code && row.active)) throw refused('CURRENCY_ON', problem)
        throw new ValidationError(problem, [{ path: 'body/code', message: problem }])
      }
      const old = rows.find((row) => row.code === code)
      let id: string
      if (old) {
        id = old.id
        await tx.currency.update({ where: { id }, data: { active: true, version: old.version + 1, updatedAt: now }, select: { id: true } })
      } else {
        id = newId()
        await tx.currency.create({ data: { id, companyId: company.id, code, minorUnits: minorUnitsOf(code), active: true, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
      }
      const action = old ? 'SWITCHED_ON' : 'ADDED'
      tools.audit({ recordType: 'Currency', recordId: id, companyId: company.id, before: old ? { code, active: false } : null, after: { code, active: true, minorUnits: old?.minorUnits ?? minorUnitsOf(code) } })
      tools.emit({ type: 'currency.changed', subject: id, companyId: company.id, payload: { currencyId: id, companyId: company.id, code, action } })
      return oneInCommand(tools, id, company.currency)
    }),
  )
  return { currency: result }
}

/** POST /currencies/:currencyId/switch {version, active}. */
export async function switchCurrency(caller: CommandCaller, currencyId: string, body: { readonly version: number; readonly active: boolean }, idempotencyKey?: string): Promise<{ currency: CurrencyView }> {
  const context = officeOf(caller)
  const row = isUuid(currencyId) ? await caller.withClient((db) => db.currency.findUnique({ where: { id: currencyId }, select: CURRENCY_COLUMNS })) : null
  if (!row || !mayOnCompany(context, CURRENCIES_VIEW, row.companyId)) throw new NotFoundError('Currency not found.')
  if (!mayOnCompany(context, CURRENCIES_MANAGE, row.companyId)) throw new ForbiddenError()
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'currency.switch', idempotencyKey, input: { currencyId, ...body }, record: { type: 'Currency', id: currencyId, expectedVersion: body.version } }, async (tools) => {
      const { tx, now } = tools
      const company = await companyOf(tx, row.companyId)
      if (!body.active) {
        const problem = switchOffProblem(row.code, company.currency)
        if (problem) throw refused('BASE_OFF', problem)
      } else if (await tx.currency.findFirst({ where: { companyId: row.companyId, code: row.code, active: true, id: { not: row.id } }, select: { id: true } })) {
        throw refused('CURRENCY_ON', `${row.code} is one of the company's currencies already.`)
      }
      if (row.active !== body.active) await tx.currency.update({ where: { id: currencyId }, data: { active: body.active, updatedAt: now }, select: { id: true } })
      tools.audit({ recordType: 'Currency', recordId: currencyId, companyId: row.companyId, before: { code: row.code, active: row.active }, after: { code: row.code, active: body.active } })
      if (row.active !== body.active) tools.emit({ type: 'currency.changed', subject: currencyId, companyId: row.companyId, payload: { currencyId, companyId: row.companyId, code: row.code, action: body.active ? 'SWITCHED_ON' : 'SWITCHED_OFF' } })
      return oneInCommand(tools, currencyId, company.currency)
    }),
  )
  return { currency: result }
}
