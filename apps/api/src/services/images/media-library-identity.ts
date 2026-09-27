import { normalizeAmazonImageUrl } from './normalize-amazon-image-url.js'

/**
 * One picture, one library card (Owner, 2026-09-28: "multiple duplicates of the same image. I do not want that to
 * happen ever").
 *
 * A family's photos are `ProductImage` rows on the root and on every variant. Older imports stored the same picture
 * once per SKU (the Amazon image backfill writes each ASIN image on every child: measured on GALE-JACKET, 197 rows,
 * 41 addresses). Rows are the same picture when they have the same address (Amazon size variants of one image count
 * as one address) or the same bytes (`contentHash`). This groups them; nothing is deleted — other screens still read
 * a variant's own rows, and a plan that points at any copy keeps resolving.
 */

export interface LibraryRow {
  id: string
  productId: string
  url: string
  contentHash?: string | null
  isPrimary?: boolean | null
}

/** Picture key per row: rows that share an address or bytes get the same key (the first row's id). */
export function pictureKeys(rows: readonly LibraryRow[]): Map<string, string> {
  const parent = new Map(rows.map(r => [r.id, r.id]))
  const find = (id: string): string => { let at = id; while (parent.get(at) !== at) at = parent.get(at)!; parent.set(id, at); return at }
  const union = (a: string, b: string) => { const [x, y] = [find(a), find(b)]; if (x !== y) parent.set(y, x) }
  const byAddress = new Map<string, string>(), byBytes = new Map<string, string>()
  for (const row of rows) {
    const address = normalizeAmazonImageUrl(row.url.trim())
    const seen = byAddress.get(address)
    if (seen) union(seen, row.id); else byAddress.set(address, row.id)
    if (row.contentHash) { const same = byBytes.get(row.contentHash); if (same) union(same, row.id); else byBytes.set(row.contentHash, row.id) }
  }
  return new Map(rows.map(r => [r.id, find(r.id)]))
}

/**
 * The library the Media page shows: one entry per picture, the other rows of that picture as `copies`. The entry is
 * the row a photo plan points at (so the plan and the card agree), else the family root's own row, else the first in
 * library order. Entries keep library order, the root's own photos first.
 */
export function libraryEntries<T extends LibraryRow>(rows: readonly T[], rootId: string, referenced: ReadonlySet<string>): Array<T & { copies: string[] }> {
  const keys = pictureKeys(rows)
  const groups = new Map<string, T[]>()
  for (const row of rows) groups.set(keys.get(row.id)!, [...(groups.get(keys.get(row.id)!) ?? []), row])
  const rank = (row: T) => (referenced.has(row.id) ? 0 : 4) + (row.productId === rootId ? 0 : 2) + (row.isPrimary ? 0 : 1)
  const entries = [...groups.values()].map(group => {
    const chosen = group.reduce((best, row) => rank(row) < rank(best) ? row : best, group[0])
    return { ...chosen, copies: group.filter(r => r.id !== chosen.id).map(r => r.id), first: rows.indexOf(group[0]), own: group.some(r => r.productId === rootId) }
  })
  return entries.sort((a, b) => Number(b.own) - Number(a.own) || a.first - b.first).map(({ first: _first, own: _own, ...entry }) => entry as T & { copies: string[] })
}

/** "The same photo" for the plan's no-repeat rule: one picture (any copy), or language versions of one photo. */
export function samePhoto(rows: ReadonlyArray<LibraryRow & { versionGroupId?: string | null }>) {
  const keys = pictureKeys(rows)
  // A picture's version group, from whichever copy carries it.
  const versions = new Map<string, string>()
  for (const row of rows) if (row.versionGroupId) versions.set(keys.get(row.id)!, row.versionGroupId)
  const key = (id: string) => keys.get(id) ?? id
  return (a: string, b: string) => a === b || key(a) === key(b) || (!!versions.get(key(a)) && versions.get(key(a)) === versions.get(key(b)))
}
