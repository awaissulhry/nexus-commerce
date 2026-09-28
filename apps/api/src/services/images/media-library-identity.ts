import { normalizeAmazonImageUrl } from './normalize-amazon-image-url.js'
import { DHASH256_NEAR_DUP_THRESHOLD, DHASH256_SAME_PICTURE_THRESHOLD, hammingHex, NEAR_DUP_HAMMING_THRESHOLD } from './image-hash.service.js'

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
  /** The Owner marked this row the same picture as that row (W4a): one card, the kept row's. */
  sameAsImageId?: string | null
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
  // A merged row (W4a) joins the photo it was marked the same as — another address, other bytes, one picture.
  for (const row of rows) if (row.sameAsImageId && parent.has(row.sameAsImageId)) union(row.sameAsImageId, row.id)
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
  // A row merged into another (W4a) is never the card: the kept photo is.
  const rank = (row: T) => (row.sameAsImageId ? 8 : 0) + (referenced.has(row.id) ? 0 : 4) + (row.productId === rootId ? 0 : 2) + (row.isPrimary ? 0 : 1)
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

export interface LookalikeRow extends LibraryRow {
  mediaType?: string | null
  perceptualHash?: string | null
  dhash256?: string | null
  versionGroupId?: string | null
  distinctFromIds?: readonly string[] | null
}

/**
 * Images W4a/W4b — cards that look alike, by the calibrated rule of the upload gate (image-hash.service.ts, IE.13):
 * aHash ≤ 6 AND dHash-256 ≤ 16 is the same picture at two addresses (`same`, an Amazon copy and ours); 17–26 is the same
 * template with other text (`versions`, a size chart per language). Pairs that already are language versions of one
 * photo, or that the Owner answered "not the same" for, are left out. Per card, the other cards, closest first.
 */
export type LookalikeKind = 'same' | 'versions'
export function lookalikes(rows: readonly LookalikeRow[], entries: ReadonlyArray<{ id: string; copies: readonly string[] }>): Map<string, Array<{ id: string; distance: number; kind: LookalikeKind }>> {
  const byId = new Map(rows.map(r => [r.id, r]))
  const cards = entries.map(entry => {
    const group = [entry.id, ...entry.copies].map(id => byId.get(id)).filter((r): r is LookalikeRow => !!r)
    const hashed = group.find(r => (r.mediaType ?? 'IMAGE') === 'IMAGE' && r.perceptualHash && r.dhash256)
    return { id: entry.id, ids: new Set(group.map(r => r.id)), hashed, version: group.find(r => r.versionGroupId)?.versionGroupId ?? null,
      distinct: new Set(group.flatMap(r => r.distinctFromIds ?? [])) }
  }).filter(card => card.hashed)
  const out = new Map<string, Array<{ id: string; distance: number; kind: LookalikeKind }>>()
  const add = (from: string, to: string, distance: number, kind: LookalikeKind) => out.set(from, [...(out.get(from) ?? []), { id: to, distance, kind }])
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j]
    if (a.version && a.version === b.version) continue
    if ([...b.ids].some(id => a.distinct.has(id)) || [...a.ids].some(id => b.distinct.has(id))) continue
    const aHash = a.hashed!.perceptualHash!, bHash = b.hashed!.perceptualHash!, aD = a.hashed!.dhash256!, bD = b.hashed!.dhash256!
    if (aHash.length !== bHash.length || aD.length !== bD.length) continue
    const distance = hammingHex(aD, bD)
    if (hammingHex(aHash, bHash) > NEAR_DUP_HAMMING_THRESHOLD || distance > DHASH256_NEAR_DUP_THRESHOLD) continue
    // ≤ 16: the same picture (W4a). 17–26: the same template with other text — likely language versions (W4b).
    const kind: LookalikeKind = distance <= DHASH256_SAME_PICTURE_THRESHOLD ? 'same' : 'versions'
    add(a.id, b.id, distance, kind); add(b.id, a.id, distance, kind)
  }
  for (const list of out.values()) list.sort((x, y) => x.distance - y.distance)
  return out
}
