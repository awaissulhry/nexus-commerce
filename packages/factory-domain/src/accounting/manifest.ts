import { createHash } from 'node:crypto'
import { ACCOUNTING_PACKAGES, type AccountingPackage } from './packages'

/**
 * What an accounting export carried, document by document (B-W2a-39; the AccountingExport.manifest of accounting.prisma;
 * design finance.accounting "Exports": "documents changed since", "Re-export (only the changes are marked)").
 *
 * Every package names the documents it rests on (an invoice, a supplier invoice, a payment, a refund, a signed-off
 * year-end inventory, the stock valuation at the year end) with a fingerprint of exactly the data the file writes of it:
 * an SDI status that moves (SENT → DELIVERED) changes no fingerprint; a corrected amount, a voided payment or an invoice
 * placed again does. The manifest keeps, per document, the fingerprint handed over and how it changed against the
 * batches before (NEW, CHANGED, REMOVED: it left the period, e.g. a payment voided, an invoice rejected by SDI). Folding
 * the manifests of a period's exported batches in order gives what the accountant holds; a re-export carries only the
 * difference, so a document is never handed over twice by mistake.
 */

export const MANIFEST_CHANGES = ['NEW', 'CHANGED', 'REMOVED'] as const
export type ManifestChange = (typeof MANIFEST_CHANGES)[number]

/** A document a package rests on, as the period holds it now. */
export interface ExportDocument {
  readonly package: AccountingPackage
  readonly recordType: string
  readonly recordId: string
  readonly number: string | null
  /** The record's version (the screens' "documents changed since" names it). */
  readonly version: number | null
  /** The fingerprint of what the file writes of it. */
  readonly hash: string
}

export interface ManifestEntry extends ExportDocument {
  readonly change: ManifestChange
}

/** Canonical JSON: object keys sorted, so the same data always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/** A document's fingerprint: SHA-256 of its canonical JSON, the first 16 hex digits. */
export const fingerprint = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16)

const keyOf = (entry: Pick<ExportDocument, 'package' | 'recordType' | 'recordId'>): string => `${entry.package}|${entry.recordType}|${entry.recordId}`

/** A stored manifest (JSON) read back; anything that is not an entry is left out (the seeds' older shape included). */
export function parseManifest(value: unknown, defaultPackage: AccountingPackage | null = null): ManifestEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): ManifestEntry[] => {
    if (raw === null || typeof raw !== 'object') return []
    const entry = raw as Record<string, unknown>
    const pkg = typeof entry.package === 'string' && (ACCOUNTING_PACKAGES as readonly string[]).includes(entry.package) ? (entry.package as AccountingPackage) : defaultPackage
    if (!pkg || typeof entry.recordType !== 'string' || typeof entry.recordId !== 'string') return []
    const change = typeof entry.change === 'string' && (MANIFEST_CHANGES as readonly string[]).includes(entry.change) ? (entry.change as ManifestChange) : 'NEW'
    return [
      {
        package: pkg,
        recordType: entry.recordType,
        recordId: entry.recordId,
        number: typeof entry.number === 'string' ? entry.number : null,
        version: typeof entry.version === 'number' ? entry.version : null,
        hash: typeof entry.hash === 'string' ? entry.hash : '',
        change,
      },
    ]
  })
}

/** What the accountant holds of a period: the exported batches' manifests folded in export order (REMOVED drops it). */
export function heldDocuments(manifests: readonly (readonly ManifestEntry[])[]): Map<string, ManifestEntry> {
  const held = new Map<string, ManifestEntry>()
  for (const manifest of manifests) {
    for (const entry of manifest) {
      if (entry.change === 'REMOVED') held.delete(keyOf(entry))
      else held.set(keyOf(entry), entry)
    }
  }
  return held
}

export interface PackageDifference {
  readonly package: AccountingPackage
  readonly documents: number
  readonly new: number
  readonly changed: number
  readonly removed: number
  readonly same: number
}

export interface Difference {
  /** NEW, CHANGED and REMOVED documents of the packages asked for (the manifest of the next batch). */
  readonly entries: readonly ManifestEntry[]
  readonly packages: readonly PackageDifference[]
  readonly changes: number
}

/** The period's documents now against what the accountant holds, for the packages asked for. */
export function differenceOf(held: ReadonlyMap<string, ManifestEntry>, current: readonly ExportDocument[], packages: readonly AccountingPackage[]): Difference {
  const wanted = new Set(packages)
  const entries: ManifestEntry[] = []
  const counts = new Map<AccountingPackage, { documents: number; new: number; changed: number; removed: number; same: number }>()
  const count = (pkg: AccountingPackage) => {
    const found = counts.get(pkg) ?? { documents: 0, new: 0, changed: 0, removed: 0, same: 0 }
    counts.set(pkg, found)
    return found
  }
  for (const pkg of packages) count(pkg)
  const seen = new Set<string>()
  for (const document of current) {
    if (!wanted.has(document.package)) continue
    const key = keyOf(document)
    seen.add(key)
    const tally = count(document.package)
    tally.documents += 1
    const before = held.get(key)
    if (!before) {
      tally.new += 1
      entries.push({ ...document, change: 'NEW' })
    } else if (before.hash !== document.hash) {
      tally.changed += 1
      entries.push({ ...document, change: 'CHANGED' })
    } else {
      tally.same += 1
    }
  }
  for (const [key, before] of held) {
    if (!wanted.has(before.package) || seen.has(key)) continue
    count(before.package).removed += 1
    entries.push({ ...before, change: 'REMOVED' })
  }
  const order = new Map(ACCOUNTING_PACKAGES.map((pkg, index) => [pkg, index]))
  entries.sort((a, b) => order.get(a.package)! - order.get(b.package)! || (a.number ?? '').localeCompare(b.number ?? '') || a.recordId.localeCompare(b.recordId))
  const summary = [...counts.entries()].sort(([a], [b]) => order.get(a)! - order.get(b)!).map(([pkg, tally]) => ({ package: pkg, ...tally }))
  return { entries, packages: summary, changes: entries.length }
}
