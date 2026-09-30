/**
 * The content row a save moved (a pin's listing translation, a shared language's product translation) comes back in the
 * save's answer with the version it holds now (`contentVersions[]`, `content-bulk-write.ts`). Every cell of the saved row
 * that writes to that content row carries the version as its write token, so the NEXT edit there chains at once. Before,
 * only a later sheet read moved the token, and an edit made before that read landed was refused as "Bullet 2 changed.
 * Reload before saving it." (the P3 commit sweep, 2026-09-30).
 */
export interface ContentVersionAnswer { id: string; tier: 'pin' | 'language'; language: string; version: number }

type TokenCell = { contentAddress?: { tier?: string; language?: string } | null; contentVersion?: number } | null | undefined
type TokenRow = { id: string; version?: number; listing?: { id: string; version?: number } | null; values?: Record<string, TokenCell> }

/** Pins name an exact listing (including its account/alias); language text belongs to the product. */
function tokenKey(row: TokenRow, cell: TokenCell): string | null {
  const address = cell?.contentAddress
  if (!address?.language) return null
  if (address.tier === 'language') return JSON.stringify(['language', row.id, address.language])
  return address.tier === 'pin' && row.listing?.id ? JSON.stringify(['pin', row.listing.id, address.language]) : null
}

/** Keep confirmed write tokens, without replacing incoming values or provenance. */
export function preserveContentVersions<T extends TokenRow>(previous: TokenRow | undefined, incoming: T, knownVersion?: number): T {
  if (!previous || previous === incoming || previous.id !== incoming.id) return incoming
  const productVersion = Math.max(previous.version ?? -1, knownVersion ?? -1)
  // A newer owner snapshot may contain a deleted/recreated translation with a lower counter.
  const newerProduct = incoming.version !== undefined && incoming.version > productVersion
  const newerListing = previous.listing?.version !== undefined && incoming.listing?.id === previous.listing.id && incoming.listing.version !== undefined && incoming.listing.version > previous.listing.version
  if (productVersion >= 0 && (incoming.version === undefined || productVersion > incoming.version)) incoming.version = productVersion
  if (previous.listing?.version !== undefined && incoming.listing?.id === previous.listing.id && (incoming.listing.version === undefined || previous.listing.version > incoming.listing.version)) {
    incoming.listing.version = previous.listing.version
  }
  const known = new Map<string, number>()
  for (const cell of Object.values(previous.values ?? {})) {
    const key = tokenKey(previous, cell)
    if (key && cell?.contentVersion !== undefined) known.set(key, Math.max(known.get(key) ?? cell.contentVersion, cell.contentVersion))
  }
  for (const cell of Object.values(incoming.values ?? {})) {
    if (cell?.contentAddress?.tier === 'language' ? newerProduct : newerListing) continue
    const key = tokenKey(incoming, cell), version = key ? known.get(key) : undefined
    if (cell?.contentVersion !== undefined && version !== undefined && version > cell.contentVersion) cell.contentVersion = version
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
        if (!cell || cell.contentVersion === undefined || cell.contentVersion >= entry.version) continue
        if (cell.contentAddress?.tier !== entry.tier || cell.contentAddress.language !== entry.language) continue
        cell.contentVersion = entry.version
        moved.add(colId)
      }
    }
  }
  return [...moved]
}
