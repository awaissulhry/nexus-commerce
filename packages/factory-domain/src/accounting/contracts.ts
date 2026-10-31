import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../core/contracts'
import { money, notMoney } from '../money/marked'
import { CHECK_CODES, MAX_EXPLANATION } from './checks'
import { INTRASTAT_FLAG_CODES } from './intrastat'
import { MANIFEST_CHANGES } from './manifest'
import { ACCOUNTING_PACKAGES, EXPORT_STATUSES, LOCK_LEVELS, LOCK_STATUSES } from './packages'
import { MONTH, PERIOD_LOCK_OVERRIDE_REASON } from './periods'

/**
 * The contracts of the accounting exports, the Intrastat rows, the year-end stock pack and the period locks (B-W2a-39;
 * FIN-046, LOG-098, LOG-100; design finance.accounting, SCR-156: Exports, 1 Period, 2 Checks, 3 Contents, Intrastat
 * rows, 4 Review, 5 Export and lock, Export files). Amounts are marked with their grain (journals, payments and Intrastat
 * values: price; the purchases journal and the year-end stock pack: cost) and dropped for a caller without it. Words
 * are English (the screens translate by the codes). No worker is named; "made by" is an office person.
 */

const month = () => z.string().regex(MONTH, 'Expected a month written YYYY-MM.')
const packageList = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
  .pipe(z.array(z.enum(ACCOUNTING_PACKAGES)))
const text = (max: number) => z.string().trim().min(1).max(max)

// ---- queries and bodies --------------------------------------------------------------------------------------------------

export const exportsQuery = input({
  companyId: id().optional(),
  status: z.enum(EXPORT_STATUSES).optional(),
  /** The year of the periods. */
  year: z.coerce.number().int().min(2000).max(2999).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** The id of the last row of the page before. */
  cursor: id().optional(),
})
export type ExportsQuery = z.infer<typeof exportsQuery>

export const exportParams = input({ exportId: id() })
export const exportFileParams = input({ exportId: id(), fileId: id() })

export const periodsQuery = input({ companyId: id(), year: z.coerce.number().int().min(2000).max(2999) })
export const periodParams = input({ month: month() })
export const periodQuery = input({
  companyId: id(),
  /** The packages to review (comma-separated). Default: the sales journal, the purchases journal and the payments. */
  packages: packageList.optional(),
})
export type PeriodQuery = z.infer<typeof periodQuery>

export const intrastatQuery = input({ companyId: id(), month: month() })
export type IntrastatQuery = z.infer<typeof intrastatQuery>

export const explanationInput = input({ code: z.enum(CHECK_CODES), explanation: text(MAX_EXPLANATION) })

export const createExportBody = input({
  companyId: id(),
  month: month(),
  packages: z.array(z.enum(ACCOUNTING_PACKAGES)).min(1).max(ACCOUNTING_PACKAGES.length),
  /** Why each failing check may be passed over (design "2 · Checks"). */
  explanations: z.array(explanationInput).max(CHECK_CODES.length).default([]),
  /** A re-export: the period's latest exported batch it amends (only the changes go). */
  supersedesId: id().optional(),
  note: text(1000).optional(),
  /** The language of the files' headings and number format (default Italian). */
  language: z.enum(['it', 'en']).default('it'),
})
export type CreateExportBody = z.infer<typeof createExportBody>

export const cancelExportBody = input({ version: z.number().int().min(1), reason: text(1000) })
export type CancelExportBody = z.infer<typeof cancelExportBody>

export const locksQuery = input({ companyId: id().optional(), status: z.enum(LOCK_STATUSES).optional() })
export type LocksQuery = z.infer<typeof locksQuery>

export const lockBody = input({
  companyId: id(),
  month: month(),
  level: z.enum(LOCK_LEVELS),
  /** A HARD lock (the final close): `close October 2026` or `chiudi ottobre 2026`. */
  phrase: z.string().max(200).optional(),
  note: text(1000).optional(),
  /** The lock already there for the month (a soft lock made hard, a lifted lock locked again). */
  version: z.number().int().min(1).optional(),
})
export type LockBody = z.infer<typeof lockBody>

export const lockParams = input({ lockId: id() })

/**
 * B-W2a-F8: the one optional body field of every write route that dates money or stock into a month
 * (`periodLockOverride: { reason }`). Inside a SOFT-locked month the write goes in only with it, and its command writes
 * one audit row `accounting.softLockOverride` on the lock (the month, the reason, the record); without it the answer is a
 * 409 with the issue `period/SOFT_LOCKED`. A HARD lock refuses the write whatever the body says.
 */
export const periodLockOverride = input({ reason: z.string().trim().min(PERIOD_LOCK_OVERRIDE_REASON.min).max(PERIOD_LOCK_OVERRIDE_REASON.max) })
export type PeriodLockOverride = z.infer<typeof periodLockOverride>
export const liftBody = input({ version: z.number().int().min(1), reason: text(1000) })
export type LiftBody = z.infer<typeof liftBody>

/**
 * B-W2b-22 (Z9:01): the month lock over a write, as a preview shows it before the write is sent (the invoice's "Check and
 * issue"): the same rule as the write's command (modules/accounting/period-guard.ts) — HARD refuses whatever the body says;
 * SOFT asks for `periodLockOverride.reason` (`needsReason`). null: no lock over the day.
 */
export const periodLockLineView = output({
  level: z.enum(['SOFT', 'HARD']),
  lockId: id(),
  periodStart: businessDate(),
  periodEnd: businessDate(),
  /** SOFT: the write goes in only with an override reason. HARD: false (nothing goes in). */
  needsReason: z.boolean(),
  /** In words: which month, since when, by whom, and the way out. */
  words: z.string(),
})
export type PeriodLockLine = z.infer<typeof periodLockLineView>

// ---- views ---------------------------------------------------------------------------------------------------------------

const companyRef = output({ id: id(), code: z.string(), name: z.string() })
const personRef = output({ id: id(), name: z.string().nullable() })
export const periodView = output({ month: z.string(), start: businessDate(), end: businessDate(), label: z.string(), labelIt: z.string() })
const exportRef = output({ id: id(), number: z.string().nullable(), status: z.enum(EXPORT_STATUSES) })

export const fixView = output({ recordType: z.string(), recordId: z.string(), number: z.string().nullable(), field: z.string().nullable() })

export const checkView = output({
  code: z.enum(CHECK_CODES),
  title: z.string(),
  passed: z.boolean(),
  count: z.number().int(),
  words: z.string(),
  fixes: z.array(fixView),
  /** As the export kept it (a failing check's explanation), or null. */
  explanation: z.string().nullable(),
})

export const exportFileView = output({
  id: id(),
  seq: z.number().int(),
  package: z.enum(ACCOUNTING_PACKAGES),
  format: z.string(),
  rowCount: z.number().int(),
  file: output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), sha256: z.string() }),
})

const differenceView = output({
  package: z.enum(ACCOUNTING_PACKAGES),
  documents: z.number().int(),
  new: z.number().int(),
  changed: z.number().int(),
  removed: z.number().int(),
  same: z.number().int(),
})

export const exportRowView = output({
  id: id(),
  number: z.string().nullable(),
  company: companyRef,
  period: periodView,
  packages: z.array(z.enum(ACCOUNTING_PACKAGES)),
  status: z.enum(EXPORT_STATUSES),
  layout: z.string(),
  supersedes: exportRef.nullable(),
  supersededBy: exportRef.nullable(),
  files: z.array(exportFileView),
  /** Per package: how many documents it carried and how they changed against the batches before. */
  contents: z.array(output({ package: z.enum(ACCOUNTING_PACKAGES), new: z.number().int(), changed: z.number().int(), removed: z.number().int() })),
  madeBy: personRef.nullable(),
  createdAt: instant(),
  exportedAt: instant().nullable(),
  exportedBy: personRef.nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  /** The latest exported batch of its period: documents changed since (null for a draft, a cancelled or an amended batch). */
  changedSince: output({ count: z.number().int(), packages: z.array(differenceView) }).nullable(),
  version: z.number().int(),
})
export type ExportRowView = z.infer<typeof exportRowView>

const held = output({ allowed: z.boolean(), reason: z.string().nullable() })

export const exportRecordView = exportRowView.extend({
  checks: z.array(checkView),
  manifest: z.array(
    output({
      package: z.enum(ACCOUNTING_PACKAGES),
      recordType: z.string(),
      recordId: z.string(),
      number: z.string().nullable(),
      version: z.number().int().nullable(),
      change: z.enum(MANIFEST_CHANGES),
    }),
  ),
  lock: output({ id: id(), level: z.enum(LOCK_LEVELS), status: z.enum(LOCK_STATUSES) }).nullable(),
  actions: output({ reExport: held, cancel: held, lock: held, download: held }),
  words: z.string(),
})
export type ExportRecordView = z.infer<typeof exportRecordView>

export const exportsAnswer = output({ rows: z.array(exportRowView), nextCursor: id().nullable() })
export const exportAnswer = output({ export: exportRecordView })

export const lockView = output({
  id: id(),
  companyId: id(),
  period: periodView,
  level: z.enum(LOCK_LEVELS),
  status: z.enum(LOCK_STATUSES),
  lockedAt: instant(),
  lockedBy: personRef,
  note: z.string().nullable(),
  export: exportRef.nullable(),
  unlockedAt: instant().nullable(),
  unlockedBy: personRef.nullable(),
  unlockReason: z.string().nullable(),
  version: z.number().int(),
  words: z.string(),
})
export type LockView = z.infer<typeof lockView>

export const locksAnswer = output({ locks: z.array(lockView) })
export const lockAnswer = output({ lock: lockView, warnings: z.array(output({ code: z.string(), message: z.string() })) })

export const monthView = output({
  period: periodView,
  ended: z.boolean(),
  lock: output({ id: id(), level: z.enum(LOCK_LEVELS), status: z.enum(LOCK_STATUSES), version: z.number().int() }).nullable(),
  exports: z.array(output({ id: id(), number: z.string().nullable(), status: z.enum(EXPORT_STATUSES), exportedAt: instant().nullable(), supersedesId: id().nullable() })),
  /** The latest exported batch (a re-export amends it), or null. */
  latest: exportRef.nullable(),
  words: z.string(),
})
export const periodsAnswer = output({ company: companyRef, year: z.number().int(), yearEndMonth: z.string(), months: z.array(monthView) })

/** One sum of a package (its amount marked with the package's grain): TAXABLE, VAT, GROSS (journals), RECEIVED,
 * REFUNDED, NOT_PLACED (payments), VALUE (Intrastat, the stock pack). */
const priceSum = output({ key: z.string(), currency: z.string().nullable(), amount: money.price(z.number().int()) })
const costSum = output({ key: z.string(), currency: z.string().nullable(), amount: money.cost(z.number().int()) })

export const packageView = output({
  package: z.enum(ACCOUNTING_PACKAGES),
  title: z.string(),
  /** It can go in this export (W2a, the right month, the caller's grain). */
  available: z.boolean(),
  heldReason: z.string().nullable(),
  grain: z.enum(['price', 'cost']),
  scope: z.enum(['DOCUMENTS', 'WHOLE']),
  documents: differenceView,
  /** The file rows this export would write of it. */
  rows: z.number().int(),
  // The lists hold no money of their own: each sum's amount is marked (dropped without the grain).
  priceTotals: notMoney(z.array(priceSum)),
  costTotals: notMoney(z.array(costSum)),
  words: z.string(),
})

export const periodAnswer = output({
  company: companyRef,
  period: periodView,
  ended: z.boolean(),
  yearEnd: z.boolean(),
  lock: lockView.nullable(),
  exports: z.array(exportRef.extend({ exportedAt: instant().nullable() })),
  /** A re-export amends it (the period's latest exported batch), or null for a first export. */
  reExportOf: exportRef.nullable(),
  /** The open draft of the period (an export that did not finish), replaced by the next export. */
  draft: exportRef.nullable(),
  /** The number the next batch gets, if nobody exports before (null: no series). */
  nextNumber: z.string().nullable(),
  packages: z.array(z.enum(ACCOUNTING_PACKAGES)),
  checks: z.array(checkView),
  failing: z.number().int(),
  contents: z.array(packageView),
  intrastat: output({ rows: z.number().int(), fileRows: z.number().int(), blocking: z.number().int(), warnings: z.number().int() }).nullable(),
  changes: z.number().int(),
  layout: z.string(),
  words: z.string(),
})
export type PeriodAnswer = z.infer<typeof periodAnswer>

export const intrastatFlagView = output({ code: z.enum(INTRASTAT_FLAG_CODES), severity: z.enum(['BLOCKING', 'WARNING']), message: z.string(), fix: output({ recordType: z.string(), recordId: z.string(), field: z.string().nullable() }).nullable() })

export const intrastatRowView = output({
  invoice: output({ id: id(), number: z.string(), docType: z.string(), issueDate: businessDate() }),
  line: output({ id: id(), seq: z.number().int(), description: z.string() }),
  style: output({ id: id(), code: z.string() }).nullable(),
  partner: output({ id: id(), code: z.string(), name: z.string() }),
  partnerVatId: z.string().nullable(),
  destinationCountry: z.string().nullable(),
  cnCode: z.string().nullable(),
  originCountry: z.string().nullable(),
  value: money.price(z.number().int()),
  currency: z.string(),
  netMassKg: z.string().nullable(),
  supplementaryUnits: z.string(),
  nature: z.enum(['SALE', 'RETURN']),
  suggestedNatureCode: z.string(),
  deliveryTerms: z.string().nullable(),
  /** B-W2b-22: the DDT's mode of transport (frozen at its issue), else its shipment's (SEA, RAIL, ROAD, AIR, POST, …); null: not recorded. */
  transportMode: z.string().nullable(),
  flags: z.array(intrastatFlagView),
})

export const intrastatFileRowView = output({
  partnerVatId: z.string().nullable(),
  destinationCountry: z.string().nullable(),
  cnCode: z.string().nullable(),
  nature: z.enum(['SALE', 'RETURN']),
  suggestedNatureCode: z.string(),
  deliveryTerms: z.string().nullable(),
  /** B-W2b-22: the rows' mode of transport (the file writes its Intrastat code); null: not recorded. */
  transportMode: z.string().nullable(),
  originCountry: z.string().nullable(),
  value: money.price(z.number().int()),
  currency: z.string(),
  netMassKg: z.string().nullable(),
  supplementaryUnits: z.string(),
  documents: z.array(z.string()),
})

export const intrastatAnswer = output({
  company: companyRef,
  period: periodView,
  rows: z.array(intrastatRowView),
  fileRows: z.array(intrastatFileRowView),
  blocking: z.number().int(),
  warnings: z.number().int(),
  values: z.array(output({ currency: z.string(), value: money.price(z.number().int()) })),
  words: z.string(),
})

