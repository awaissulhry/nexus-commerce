import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { AccountingPackage, PeriodAnswer } from '../api'
import type { Phrase } from '../model'
import type { IntegrityCheck, IntegrityResult } from './api'

/**
 * B-W2b-426 — the bridge's part of 2 · Checks and 3 · Contents (design finance.accounting sec:step-checks "work orders
 * closed (W2b)", sec:step-contents "cost of goods sold and variances (W2b) · VAT registers (W2b)"; B-W2b-408's checks
 * WORK_ORDERS_CLOSED, MAPPING_COMPLETE, ENTRIES_BALANCE and its nightly integrity checks), pure: where a failing check's
 * record opens (a key of the mapping on the mapping page, a work order on its page, an entry's document), the integrity
 * checks' states for the DS CheckList, what holds "Run the checks now", the journals' line on 3 · Contents, and the live
 * events that read the checks again.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** Where a record a check or an integrity failure names opens (company-free; the page adds `/w/<company>`). */
export const fixAddress = (fix: { readonly recordType: string; readonly recordId: string; readonly number?: string | null }): string => recordAddress({ type: fix.recordType, id: fix.recordId, label: fix.number ?? undefined }, OFFICE_PAGES)

/** The DS CheckList state of an integrity check: passed, failed, being run now; could not run or never run: unknown. */
export function integrityState(result: IntegrityResult | null, running: boolean): 'pass' | 'fail' | 'unknown' | 'checking' {
  if (running) return 'checking'
  if (result === 'PASSED') return 'pass'
  if (result === 'FAILED') return 'fail'
  return 'unknown'
}

/** An integrity check's sentence: passed, its failures counted, could not run, never run. */
export function integrityPhrase(check: Pick<IntegrityCheck, 'code' | 'result' | 'failureCount'>): Phrase {
  if (check.result === 'FAILED') return phrase(`integrity.check.${check.code}.fail`, { count: check.failureCount })
  if (check.result === 'PASSED') return phrase(`integrity.check.${check.code}.pass`)
  return phrase(check.result === 'ERROR' ? 'integrity.error' : 'integrity.never')
}

/** The runs before the last one, in words ("Earlier: 5 passed, 1 failed"), or null with none. */
export function historyPhrase(check: Pick<IntegrityCheck, 'history'>): Phrase | null {
  if (check.history.length === 0) return null
  const failed = check.history.filter((run) => run.result !== 'PASSED').length
  return failed === 0 ? phrase('integrity.historyAll', { count: check.history.length }) : phrase('integrity.history', { passed: check.history.length - failed, failed })
}

/** Why "Run the checks now" is held (null: it may run): accounting.export (who prepares the month), a run going. */
export function runHeld(can: { readonly run: boolean }, running: boolean): Phrase | null {
  if (!can.run) return phrase('integrity.held.noRun')
  if (running) return phrase('integrity.held.running')
  return null
}

/** The packages whose documents become journal entries with mapped accounts (factory-domain ENTRY_PACKAGES). */
const ENTRY_PACKAGES: readonly AccountingPackage[] = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES']

/**
 * The journals' line on 3 · Contents, when a chosen package becomes journal entries: on (each goes with its entries file,
 * the accounts mapped on each document's day) or off (waits for the accountant; switched on the account mapping).
 */
export function journalsLine(answer: Pick<PeriodAnswer, 'journals'>, chosen: readonly AccountingPackage[]): Phrase | null {
  if (!chosen.some((pkg) => ENTRY_PACKAGES.includes(pkg))) return null
  return phrase(answer.journals.on ? 'journals.contents.on' : 'journals.contents.off')
}

/** A run of the checks (nightly or by a person) changes what the panel shows. */
export const integrityTouches = (change: { type: string }): boolean => change.type === 'integrity_checks.ran'
