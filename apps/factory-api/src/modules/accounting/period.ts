import { CHECK_TITLES, type CheckResult } from '@nexus/factory-domain/accounting/checks'
import type { IntrastatQuery, PeriodAnswer, PeriodQuery } from '@nexus/factory-domain/accounting/contracts'
import { INTRASTAT_WORDS, intrastatFileRows, intrastatSummary } from '@nexus/factory-domain/accounting/intrastat'
import { invoiceTotals, unplacedOf } from '@nexus/factory-domain/accounting/journals'
import { differenceOf } from '@nexus/factory-domain/accounting/manifest'
import { DEFAULT_LAYOUT, LAYOUT_WORDS, PACKAGE_RULES, packageProblems, sortPackages, type AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import { ACCOUNTING_VIEW } from '@nexus/factory-domain/accounting/permissions'
import { isYearEndPeriod, monthLabel, monthsOfYear, periodEnded, periodOfMonth, yearEndMonthNumber, type Period } from '@nexus/factory-domain/accounting/periods'
import { YEAR_END_WORDS } from '@nexus/factory-domain/accounting/year-end'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { formatNumber } from '@nexus/factory-domain/numbering/format'
import type { CommandCaller } from '../../core/command'
import { periodState, periodView } from './exports'
import { checksOf, documentsOf, readPeriodFacts, type PeriodFacts } from './facts'
import { planFiles } from './files'
import { lockViews } from './locks'
import { accountingClock, companyFor, companyRef, dateOf, dayOf, grainsOf, lockOfPeriod, officeOf, periodExports, type CompanyRow, type Reader } from './store'

/**
 * The months of the accounting export wizard (B-W2a-39; design finance.accounting "1 · Period", "2 · Checks", "3 ·
 * Contents", "Intrastat rows", "4 · Review", "5 · Export and lock"): reads only, as the caller, with accounting.view over
 * the company. Amounts are marked with their package's grain (dropped for a caller without it); counts, checks and
 * words are for every reader.
 */

const DEFAULT_PACKAGES: readonly AccountingPackage[] = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS']

const checkView = (check: CheckResult) => ({ code: check.code, title: CHECK_TITLES[check.code].en, passed: check.passed, count: check.count, words: check.words, fixes: [...check.fixes], explanation: null })

/** GET /accounting/periods: the twelve months of a year, each with its lock and batches. */
export async function yearOfPeriods(caller: CommandCaller, query: { readonly companyId: string; readonly year: number }) {
  const company = await companyFor(caller, query.companyId, ACCOUNTING_VIEW)
  const today = businessDate(accountingClock().now())
  return caller.withClient(async (db) => {
    const exports = await db.accountingExport.findMany({
      where: { companyId: company.id, periodStart: { gte: dateOf(`${query.year}-01-01`), lte: dateOf(`${query.year}-12-31`) } },
      select: { id: true, number: true, status: true, exportedAt: true, supersedesId: true, periodStart: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const locks = await db.periodLock.findMany({ where: { companyId: company.id, periodStart: { lte: dateOf(`${query.year}-12-31`) }, periodEnd: { gte: dateOf(`${query.year}-01-01`) } }, select: { id: true, level: true, status: true, version: true, periodStart: true, periodEnd: true } })
    const months = monthsOfYear(query.year).map((month) => {
      const period = periodOfMonth(month)
      const mine = exports.filter((row) => dayOf(row.periodStart) === period.start)
      const exported = mine.filter((row) => row.status === 'EXPORTED').sort((a, b) => a.exportedAt!.getTime() - b.exportedAt!.getTime())
      const lock = locks.find((row) => dayOf(row.periodStart) <= period.start && dayOf(row.periodEnd) >= period.end && row.status === 'LOCKED') ?? locks.find((row) => dayOf(row.periodStart) === period.start) ?? null
      const latest = exported.at(-1) ?? null
      const ended = periodEnded(period, today)
      const words = [
        latest ? `Exported as ${exported.map((row) => row.number).join(', ')}.` : ended ? 'Not exported yet.' : 'The month is not over.',
        lock ? (lock.status === 'LOCKED' ? (lock.level === 'HARD' ? 'Closed for good.' : 'Soft-locked.') : 'A lock was lifted.') : 'Open.',
      ].join(' ')
      return {
        period: periodView(period),
        ended,
        lock: lock ? { id: lock.id, level: lock.level, status: lock.status, version: lock.version } : null,
        exports: mine.map((row) => ({ id: row.id, number: row.number, status: row.status, exportedAt: row.exportedAt ? toUtcIso(row.exportedAt) : null, supersedesId: row.supersedesId })),
        latest: latest ? { id: latest.id, number: latest.number, status: latest.status } : null,
        words,
      }
    })
    const yearEnd = String(yearEndMonthNumber(company.fiscalYearStartMonth)).padStart(2, '0')
    return { company: companyRef(company), year: query.year, yearEndMonth: `${query.year}-${yearEnd}`, months }
  })
}

/** The number the next batch of the company gets (if nobody exports before), from its ACCOUNTING_EXPORT series. */
async function nextNumber(db: Reader, companyId: string, today: string): Promise<string | null> {
  const series = await db.numberSeries.findMany({ where: { companyId, kind: 'ACCOUNTING_EXPORT', status: 'ACTIVE' }, select: { code: true, scopeKey: true, reset: true, pattern: true, nextValue: true }, orderBy: { scopeKey: 'desc' } })
  if (series.length === 0 || new Set(series.map((row) => row.code)).size > 1) return null
  const year = Number(today.slice(0, 4))
  const newest = series[0]!
  if (newest.reset !== 'YEARLY') return formatNumber(newest.pattern, { value: newest.nextValue })
  const current = series.find((row) => row.scopeKey === String(year))
  return formatNumber(newest.pattern, { value: current ? current.nextValue : 1, year })
}

function totalsOf(pkg: AccountingPackage, facts: PeriodFacts) {
  const price = (key: string, currency: string | null, amount: number) => ({ key, currency, amount: asMoney('price', amount) })
  const cost = (key: string, currency: string | null, amount: number) => ({ key, currency, amount: asMoney('cost', amount) })
  switch (pkg) {
    case 'SALES_JOURNAL':
      return { priceTotals: invoiceTotals(facts.sales).flatMap((sum) => [price('TAXABLE', sum.currency, sum.taxable), price('VAT', sum.currency, sum.vat), price('GROSS', sum.currency, sum.gross)]), costTotals: [] }
    case 'PURCHASES_JOURNAL':
      return { priceTotals: [], costTotals: invoiceTotals(facts.purchases ?? []).flatMap((sum) => [cost('TAXABLE', sum.currency, sum.taxable), cost('VAT', sum.currency, sum.vat), cost('GROSS', sum.currency, sum.gross)]) }
    case 'PAYMENTS': {
      const currencies = [...new Set([...facts.payments.map((row) => row.currency), ...facts.refunds.map((row) => row.currency)])].sort()
      return {
        priceTotals: currencies.flatMap((currency) => [
          price('RECEIVED', currency, facts.payments.filter((row) => row.currency === currency).reduce((sum, row) => sum + row.amount, 0)),
          price('REFUNDED', currency, facts.refunds.filter((row) => row.currency === currency).reduce((sum, row) => sum + row.amount, 0)),
          price('NOT_PLACED', currency, facts.payments.filter((row) => row.currency === currency).reduce((sum, row) => sum + unplacedOf(row), 0)),
        ]),
        costTotals: [],
      }
    }
    case 'INTRASTAT':
      return { priceTotals: intrastatSummary(facts.intrastat ?? []).values.map((entry) => price('VALUE', entry.currency, entry.value)), costTotals: [] }
    case 'YEAR_END_STOCK': {
      const by = new Map<string | null, number>()
      for (const row of facts.yearEnd?.valuation ?? []) by.set(row.currency, (by.get(row.currency) ?? 0) + row.value)
      return { priceTotals: [], costTotals: [...by.entries()].map(([currency, value]) => cost('VALUE', currency, value)) }
    }
    default:
      return { priceTotals: [], costTotals: [] }
  }
}

const PACKAGE_WORDS: Partial<Record<AccountingPackage, string>> = {
  SALES_JOURNAL: 'The invoices issued in the month, one row per VAT rate (an invoice rejected by SDI counts as never issued).',
  PURCHASES_JOURNAL: 'The supplier invoices received in the month (by the day they arrived), one row per VAT rate.',
  PAYMENTS: 'The payments received in the month, what each pays and what is not placed; the refunds paid in the month.',
  INTRASTAT: INTRASTAT_WORDS,
  YEAR_END_STOCK: YEAR_END_WORDS,
}

/** GET /accounting/periods/:month: the wizard's month — lock, batches, checks, contents, Intrastat, review, next number. */
export async function periodWorkspace(caller: CommandCaller, month: string, query: PeriodQuery): Promise<PeriodAnswer> {
  const context = officeOf(caller)
  const company = await companyFor(caller, query.companyId, ACCOUNTING_VIEW)
  const period = periodOfMonth(month)
  const yearEnd = isYearEndPeriod(period, company.fiscalYearStartMonth)
  const asked = sortPackages(query.packages && query.packages.length > 0 ? query.packages : [...DEFAULT_PACKAGES, ...(yearEnd ? (['YEAR_END_STOCK'] as const) : [])])
  const grains = grainsOf(context)
  const today = businessDate(accountingClock().now())
  return caller.withClient(async (db) => {
    const state = periodState(await periodExports(db, company.id, period))
    const readable = asked.filter((pkg) => PACKAGE_RULES[pkg].wave === 'W2a' && (pkg !== 'YEAR_END_STOCK' || yearEnd))
    const facts = await readPeriodFacts(db, company, period, readable)
    const checks = checksOf(facts, asked, today)
    const documents = documentsOf(facts, company, readable)
    const difference = differenceOf(state.held, documents.documents, readable)
    const plan = planFiles({ company, period, packages: readable, facts, documents, reExport: state.latest ? { entries: difference.entries, packages: difference.packages, earlier: state.exported.map((row) => row.number!) } : null, language: 'en' })
    const lockRow = await lockOfPeriod(db, company.id, period)
    const contents = asked.map((pkg) => {
      const problem = packageProblems([pkg], { yearEndPeriod: yearEnd, grains })[0] ?? null
      const tally = difference.packages.find((entry) => entry.package === pkg) ?? { package: pkg, documents: 0, new: 0, changed: 0, removed: 0, same: 0 }
      const rows = plan.files.filter((file) => file.package === pkg).reduce((sum, file) => sum + file.rowCount, 0)
      return {
        package: pkg,
        title: PACKAGE_RULES[pkg].words.en,
        available: problem === null,
        heldReason: problem?.message ?? null,
        grain: PACKAGE_RULES[pkg].grain as 'price' | 'cost',
        scope: PACKAGE_RULES[pkg].scope,
        documents: tally,
        rows,
        ...totalsOf(pkg, facts),
        words: PACKAGE_WORDS[pkg] ?? `${PACKAGE_RULES[pkg].words.en} comes in a later wave (W2b).`,
      }
    })
    const intrastat = facts.intrastat ? intrastatSummary(facts.intrastat) : null
    const draft = state.rows.filter((row) => row.status === 'DRAFT').at(-1) ?? null
    const ref = (row: { id: string; number: string | null; status: string }) => ({ id: row.id, number: row.number, status: row.status as 'DRAFT' | 'EXPORTED' | 'CANCELLED' })
    return {
      company: companyRef(company),
      period: periodView(period),
      ended: periodEnded(period, today),
      yearEnd,
      lock: lockRow ? (await lockViews(db, [lockRow]))[0]! : null,
      exports: state.rows.map((row) => ({ ...ref(row), exportedAt: row.exportedAt ? toUtcIso(row.exportedAt) : null })),
      reExportOf: state.latest ? ref(state.latest) : null,
      draft: draft ? ref(draft) : null,
      nextNumber: await nextNumber(db, company.id, today),
      packages: asked,
      checks: checks.map(checkView),
      failing: checks.filter((check) => !check.passed).length,
      contents,
      intrastat: intrastat ? { rows: intrastat.rows, fileRows: intrastat.fileRows, blocking: intrastat.blocking, warnings: intrastat.warnings } : null,
      changes: difference.changes,
      layout: DEFAULT_LAYOUT,
      words: `${monthLabel(period.month)}. ${state.latest ? `Exported as ${state.exported.map((row) => row.number).join(', ')}: the next batch is a re-export of what changed (${difference.changes} document(s)).` : 'Not exported yet: the next batch is its first export.'} ${LAYOUT_WORDS}`,
    }
  })
}

/** GET /accounting/intrastat: the month's EU sale rows with their flags and fixes, and the file's rows. */
export async function intrastatRows(caller: CommandCaller, query: IntrastatQuery) {
  const company: CompanyRow = await companyFor(caller, query.companyId, ACCOUNTING_VIEW)
  const period: Period = periodOfMonth(query.month)
  return caller.withClient(async (db) => {
    const facts = await readPeriodFacts(db, company, period, ['INTRASTAT'])
    const rows = facts.intrastat ?? []
    const summary = intrastatSummary(rows)
    return {
      company: companyRef(company),
      period: periodView(period),
      rows: rows.map((row) => ({
        invoice: { id: row.invoiceId, number: row.invoiceNumber, docType: row.docType, issueDate: row.issueDate },
        line: { id: row.lineId, seq: row.lineSeq, description: row.description },
        style: row.style,
        partner: { id: row.partner.partyId, code: row.partner.code, name: row.partner.name },
        partnerVatId: row.partnerVatId,
        destinationCountry: row.destinationCountry,
        cnCode: row.cnCode,
        originCountry: row.originCountry,
        value: asMoney('price', row.value),
        currency: row.currency,
        netMassKg: row.netMassKg,
        supplementaryUnits: row.supplementaryUnits,
        nature: row.nature,
        suggestedNatureCode: row.suggestedNatureCode,
        deliveryTerms: row.deliveryTerms,
        transportMode: row.transportMode,
        flags: row.flags.map((flag) => ({ ...flag })),
      })),
      fileRows: intrastatFileRows(rows).map((row) => ({ ...row, value: asMoney('price', row.value), documents: [...row.documents] })),
      blocking: summary.blocking,
      warnings: summary.warnings,
      values: summary.values.map((entry) => ({ currency: entry.currency, value: asMoney('price', entry.value) })),
      words: INTRASTAT_WORDS,
    }
  })
}
