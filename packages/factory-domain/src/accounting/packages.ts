import type { Grain } from '../auth/grains/grains'

/**
 * What an accounting export carries (B-W2a-39; design finance.accounting "3 · Contents"; the AccountingPackage enum of
 * factory-db accounting.prisma). W2a builds the sales journal, the purchases journal, the payments, the Intrastat data
 * (LOG-098, LOG-100) and the year-end stock pack (FIN-046); the cost of goods sold with its variances and the VAT
 * registers are W2b (the design marks them so): asked for, they are refused in words.
 *
 * Every file is in Nexus's DEFAULT layout until the accountant names their software and its import layout (Q7,
 * GATE-ACCOUNTANT): `layout` on the export says so, and the words below say it in every answer. Nothing is sent to the
 * accountant or to any authority: the files are handed over by a person (no Intrastat filing, no SDI call).
 *
 * Scope of a re-export (a later batch of the same period that amends an exported one, "only the changes"):
 *   DOCUMENTS  a journal: only the documents that are new, changed or no longer in the period since the batches before
 *   WHOLE      Intrastat and the year-end stock pack: the period's whole file again, replacing the one before, when any
 *              document behind it changed (a declaration and a valued list are corrected whole, never row by row)
 */

export const ACCOUNTING_PACKAGES = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS', 'INTRASTAT', 'YEAR_END_STOCK'] as const
export type AccountingPackage = (typeof ACCOUNTING_PACKAGES)[number]

export const EXPORT_STATUSES = ['DRAFT', 'EXPORTED', 'CANCELLED'] as const
export type AccountingExportStatus = (typeof EXPORT_STATUSES)[number]

export const LOCK_LEVELS = ['SOFT', 'HARD'] as const
export type LockLevel = (typeof LOCK_LEVELS)[number]
export const LOCK_STATUSES = ['LOCKED', 'UNLOCKED'] as const
export type LockStatus = (typeof LOCK_STATUSES)[number]

/** The layout every file is written in until the accountant names theirs (Q7). */
export const DEFAULT_LAYOUT = 'DEFAULT'

export interface PackageRule {
  /** The wave that builds it: a W2b package is refused. */
  readonly wave: 'W2a' | 'W2b'
  /** The grain of its amounts: preparing, reviewing and downloading it needs it. */
  readonly grain: Grain
  readonly scope: 'DOCUMENTS' | 'WHOLE'
  /** In file names. */
  readonly slug: string
  readonly words: { readonly en: string; readonly it: string }
}

export const PACKAGE_RULES: Readonly<Record<AccountingPackage, PackageRule>> = Object.freeze({
  SALES_JOURNAL: { wave: 'W2a', grain: 'price', scope: 'DOCUMENTS', slug: 'sales-journal', words: { en: 'Sales journal', it: 'Registro vendite' } },
  PURCHASES_JOURNAL: { wave: 'W2a', grain: 'cost', scope: 'DOCUMENTS', slug: 'purchases-journal', words: { en: 'Purchases journal', it: 'Registro acquisti' } },
  PAYMENTS: { wave: 'W2a', grain: 'price', scope: 'DOCUMENTS', slug: 'payments', words: { en: 'Payments', it: 'Incassi e rimborsi' } },
  COST_OF_SALES: { wave: 'W2b', grain: 'cost', scope: 'WHOLE', slug: 'cost-of-sales', words: { en: 'Cost of goods sold and variances', it: 'Costo del venduto e scostamenti' } },
  VAT_REGISTERS: { wave: 'W2b', grain: 'price', scope: 'WHOLE', slug: 'vat-registers', words: { en: 'VAT registers', it: 'Registri IVA' } },
  INTRASTAT: { wave: 'W2a', grain: 'price', scope: 'WHOLE', slug: 'intrastat', words: { en: 'Intrastat (EU sales)', it: 'Intrastat (cessioni UE)' } },
  YEAR_END_STOCK: { wave: 'W2a', grain: 'cost', scope: 'WHOLE', slug: 'year-end-stock', words: { en: 'Year-end stock pack', it: 'Inventario di fine anno' } },
})

/** The words every answer and file note carries about the layout (Q7) and the hand-over. */
export const LAYOUT_WORDS =
  "Nexus's default layout: the accountant's software and its import layout are to confirm with the accountant (Q7). Nothing is sent to the accountant or to any authority; a person hands the files over."

export interface PackageProblem {
  readonly code: 'PACKAGE_W2B' | 'YEAR_END_NOT_THIS_PERIOD' | 'PACKAGE_GRAIN' | 'PACKAGE_TWICE'
  readonly package: AccountingPackage
  readonly message: string
}

/** Why the packages asked for cannot go in this export (empty: they can). */
export function packageProblems(packages: readonly AccountingPackage[], facts: { readonly yearEndPeriod: boolean; readonly grains: ReadonlySet<Grain> }): PackageProblem[] {
  const problems: PackageProblem[] = []
  const seen = new Set<AccountingPackage>()
  for (const pkg of packages) {
    const rule = PACKAGE_RULES[pkg]
    if (seen.has(pkg)) problems.push({ code: 'PACKAGE_TWICE', package: pkg, message: `${rule.words.en} is asked for twice.` })
    seen.add(pkg)
    if (rule.wave !== 'W2a') problems.push({ code: 'PACKAGE_W2B', package: pkg, message: `${rule.words.en} comes in a later wave (W2b); it cannot be exported yet.` })
    else if (pkg === 'YEAR_END_STOCK' && !facts.yearEndPeriod) problems.push({ code: 'YEAR_END_NOT_THIS_PERIOD', package: pkg, message: 'The year-end stock pack goes with the export of the month that ends on the year end (31 December).' })
    if (!facts.grains.has(rule.grain)) problems.push({ code: 'PACKAGE_GRAIN', package: pkg, message: `${rule.words.en} carries ${rule.grain === 'cost' ? 'costs' : 'prices'}: it needs the ${rule.grain} grain.` })
  }
  return problems
}

/** The packages in the enum's order (as files are numbered). */
export const sortPackages = (packages: readonly AccountingPackage[]): AccountingPackage[] => ACCOUNTING_PACKAGES.filter((pkg) => packages.includes(pkg))
