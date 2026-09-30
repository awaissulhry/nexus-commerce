/**
 * The content row a save moved (a pin's listing translation, a shared language's product translation) comes back in the
 * save's answer with the version it holds now (`contentVersions[]`, `content-bulk-write.ts`). Every cell of the saved row
 * that writes to that content row carries the version as its write token, so the NEXT edit there chains at once. Before,
 * only a later sheet read moved the token, and an edit made before that read landed was refused as "Bullet 2 changed.
 * Reload before saving it." (the P3 commit sweep, 2026-09-30).
 */
export interface ContentVersionAnswer { id: string; tier: 'pin' | 'language'; language: string; version: number }

const snapshotKey = Symbol('sheet content confirmation')
type ContentSnapshot = { key: string; ownerVersion: number | undefined; version: number }
type TokenCell = { [snapshotKey]?: ContentSnapshot; contentAddress?: { tier?: string; language?: string } | null; contentVersion?: number } | null | undefined
type TokenRow = { id: string; version?: number; listing?: { id: string; version?: number } | null; values?: Record<string, TokenCell> }

/** Pins name an exact listing (including its account/alias); language text belongs to the product. */
function tokenKey(row: TokenRow, cell: TokenCell): string | null {
  const address = cell?.contentAddress
  if (!address?.language) return null
  if (address.tier === 'language') return JSON.stringify(['language', row.id, address.language])
  return address.tier === 'pin' && row.listing?.id ? JSON.stringify(['pin', row.listing.id, address.language]) : null
}

// A conflict may advance the row's owner version without confirming its content. Keep the
// pair on the cell object: quiet reads can retain a busy cell while replacing its siblings.
// An enumerable Symbol survives the column setters' object spreads, while JSON and the wire
// omit it. Object identity alone is insufficient: a local cell edit copies its metadata too.
const ownerVersionOf = (row: TokenRow, cell: NonNullable<TokenCell>) => cell.contentAddress?.tier === 'pin' ? row.listing?.version : row.version
function snapshotOf(row: TokenRow, cell: TokenCell): ContentSnapshot | undefined {
  const key = tokenKey(row, cell)
  if (!key || cell?.contentVersion === undefined) return undefined
  const previous = cell[snapshotKey]
  if (previous?.key === key && previous.version === cell.contentVersion) return previous
  const snapshot = { key, ownerVersion: ownerVersionOf(row, cell), version: cell.contentVersion }
  cell[snapshotKey] = snapshot
  return snapshot
}
const newer = (a: ContentSnapshot, b: ContentSnapshot) =>
  a.ownerVersion !== undefined && b.ownerVersion !== undefined && a.ownerVersion !== b.ownerVersion
    ? a.ownerVersion > b.ownerVersion : a.version > b.version

/** Keep confirmed token/owner pairs, without replacing incoming values or provenance. */
export function preserveContentVersions<T extends TokenRow>(previous: TokenRow | undefined, incoming: T, knownVersion?: number): T {
  if (previous === incoming) return incoming
  const known = new Map<string, ContentSnapshot>()
  if (previous?.id === incoming.id) for (const cell of Object.values(previous.values ?? {})) {
    const snapshot = snapshotOf(previous, cell)
    if (snapshot && (!known.has(snapshot.key) || newer(snapshot, known.get(snapshot.key)!))) known.set(snapshot.key, snapshot)
  }
  // Capture read ownership BEFORE monotonic owner tokens below can advance it.
  for (const cell of Object.values(incoming.values ?? {})) {
    const snapshot = snapshotOf(incoming, cell), confirmed = snapshot && known.get(snapshot.key)
    if (cell && confirmed && newer(confirmed, snapshot!)) {
      cell.contentVersion = confirmed.version
      cell[snapshotKey] = confirmed
    }
  }
  if (!previous || previous.id !== incoming.id) return incoming
  const productVersion = Math.max(previous.version ?? -1, knownVersion ?? -1)
  if (productVersion >= 0 && (incoming.version === undefined || productVersion > incoming.version)) incoming.version = productVersion
  if (previous.listing?.version !== undefined && incoming.listing?.id === previous.listing.id && (incoming.listing.version === undefined || previous.listing.version > incoming.listing.version)) {
    incoming.listing.version = previous.listing.version
  }
  return incoming
}

export function contentVersionsOf(body: unknown): ContentVersionAnswer[] {
  const list = (body as { contentVersions?: unknown } | null)?.contentVersions
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is ContentVersionAnswer => !!entry && typeof entry.id === 'string' &&
    (entry.tier === 'pin' || entry.tier === 'language') && typeof entry.language === 'string' && Number.isSafeInteger(entry.version))
}

/** Language content belongs to the product across aliases; pin content belongs to this listing alone. */
export function adoptContentVersions(row: TokenRow | null | undefined, body: unknown, siblings: readonly TokenRow[] = []): string[] {
  if (!row) return []
  const moved = new Set<string>()
  for (const entry of contentVersionsOf(body)) {
    if (entry.id !== row.id) continue
    for (const target of entry.tier === 'language' ? new Set([row, ...siblings]) : [row]) {
      if (target.id !== entry.id) continue
      for (const [colId, cell] of Object.entries(target.values ?? {})) {
        if (!cell || cell.contentVersion === undefined) continue
        if (cell.contentAddress?.tier !== entry.tier || cell.contentAddress.language !== entry.language) continue
        const current = snapshotOf(target, cell)
        const reply = body as { currentVersion?: number; versionOf?: string }
        const ownerVersion = reply.versionOf === (entry.tier === 'pin' ? 'channelListing' : 'product') && typeof reply.currentVersion === 'number' ? reply.currentVersion : undefined
        const confirmed = { key: tokenKey(target, cell) ?? '', ownerVersion, version: entry.version }
        if (current && newer(current, confirmed)) continue
        if (cell.contentVersion !== entry.version) moved.add(colId)
        cell.contentVersion = entry.version
        cell[snapshotKey] = confirmed
      }
    }
  }
  return [...moved]
}
