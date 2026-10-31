import type { DefectKind, ScanReason } from '@nexus/factory-domain/production/scans/reasons'
import type { Reader } from './store'

/** The other languages' words as the row keeps them ({ "ro": "…" }; the database's guard keeps the shape). */
const wordsOf = (value: unknown): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

/**
 * THE seam of the scrap and rework reasons (B-W1-42; W2b B-W2b-10, MES-125: with each tile's icon, colour, other
 * languages and "needs detail"): the only place the scan rules and the screens get them from. The
 * tenant's ScrapReason rows (seeded with factory-domain's W1 list; W2a's "Floor rules & codes" edits them), read in the
 * caller's scope (office, or a floor device: every device reads the tenant's list), scrap first, then in tile order.
 */
export async function readReasons(db: Reader, filter: { readonly kind?: DefectKind; readonly includeInactive?: boolean } = {}): Promise<ScanReason[]> {
  const rows = await db.scrapReason.findMany({
    where: { ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.includeInactive ? {} : { active: true }) },
    select: { kind: true, code: true, labelIt: true, labelEn: true, sortOrder: true, active: true, icon: true, colour: true, labelI18n: true, needsDetail: true },
    orderBy: [{ kind: 'desc' }, { sortOrder: 'asc' }, { code: 'asc' }],
  })
  // SCRAP before REWORK (the enum's own order is SCRAP, REWORK; sorted here so the order never depends on it).
  return rows
    .map((row) => ({ kind: row.kind, code: row.code, label: { it: row.labelIt, en: row.labelEn }, sortOrder: row.sortOrder, active: row.active, icon: row.icon, colour: row.colour, labelI18n: wordsOf(row.labelI18n), needsDetail: row.needsDetail }))
    .sort((a, b) => (a.kind === b.kind ? a.sortOrder - b.sortOrder || a.code.localeCompare(b.code) : a.kind === 'SCRAP' ? -1 : 1))
}
