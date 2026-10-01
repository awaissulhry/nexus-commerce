/**
 * The content row a save moved (a pin's listing translation, a shared language's product translation) comes back in the
 * save's answer with the version it holds now (`contentVersions[]`, `content-bulk-write.ts`). Every cell of the saved row
 * that writes to that content row carries the version as its write token, so the NEXT edit there chains at once. Before,
 * only a later sheet read moved the token, and an edit made before that read landed was refused as "Bullet 2 changed.
 * Reload before saving it." (the P3 commit sweep, 2026-09-30).
 */
export interface ContentVersionAnswer { id: string; tier: 'pin' | 'language'; language: string; version: number }
/**
 * A qualified receipt (`contentVersionReceipts`, API `pim/content-version-receipts.ts`, 2026-10-01): one content row a
 * save actually wrote — its own edit, a formula's, the shared-text cascade's — named exactly (product + language, or
 * product + physical listing + language), with its owner/content pair before the save's first write to it and after
 * the whole operation. Only a cell whose own confirmed pair IS `before` may take `after`.
 */
export interface ContentVersionReceipt {
  tier: 'pin' | 'language'; productId: string; listingId?: string; language: string
  before: { ownerVersion: number; contentVersion: number }; after: { ownerVersion: number; contentVersion: number }
}

const snapshotKey = Symbol('sheet content confirmation')
type ContentSnapshot = { key: string; ownerVersion: number | undefined; version: number }
type TokenCell = { [snapshotKey]?: ContentSnapshot; contentAddress?: { tier?: string; language?: string } | null; contentVersion?: number } | null | undefined
type TokenRow = { id: string; version?: number; listing?: { id: string; version?: number } | null; values?: Record<string, TokenCell> }
const absentPinKey = (row: TokenRow, cell: TokenCell) => JSON.stringify(['absentPin', row.id, cell?.contentAddress])

/** Pins name an exact listing (including its account/alias); language text belongs to the product. */
function tokenKey(row: TokenRow, cell: TokenCell): string | null {
  const address = cell?.contentAddress
  if (!address?.language) return null
  if (address.tier === 'language') return JSON.stringify(['language', row.id, address.language])
  return address.tier === 'pin' ? row.listing?.id ? JSON.stringify(['pin', row.listing.id, address.language]) : absentPinKey(row, cell) : null
}

// A conflict may advance the row's owner version without confirming its content. Keep the
// pair on the cell object: quiet reads can retain a busy cell while replacing its siblings.
// An enumerable Symbol survives the column setters' object spreads, while JSON and the wire
// omit it. Object identity alone is insufficient: a local cell edit copies its metadata too.
const ownerVersionOf = (row: TokenRow, cell: NonNullable<TokenCell>) => cell.contentAddress?.tier === 'pin' ? row.listing ? row.listing.version : 0 : row.version
function snapshotOf(row: TokenRow, cell: TokenCell): ContentSnapshot | undefined {
  const key = tokenKey(row, cell)
  if (!key || cell?.contentVersion === undefined) return undefined
  const previous = cell[snapshotKey]
  if (previous?.key === key && previous.version === cell.contentVersion) return previous
  // Learning a listing ID from a conflict does not confirm its content. Keep the original absence proof stale.
  if (previous?.key === absentPinKey(row, cell) && previous.version === cell.contentVersion) {
    return cell[snapshotKey] = { ...previous, key }
  }
  const snapshot = { key, ownerVersion: ownerVersionOf(row, cell), version: cell.contentVersion }
  cell[snapshotKey] = snapshot
  return snapshot
}
const newer = (a: ContentSnapshot, b: ContentSnapshot) =>
  a.ownerVersion !== undefined && b.ownerVersion !== undefined && a.ownerVersion !== b.ownerVersion
    ? a.ownerVersion > b.ownerVersion : a.version > b.version
const samePair = (a: ContentSnapshot, b: ContentSnapshot) => a.key === b.key && a.ownerVersion === b.ownerVersion && a.version === b.version

export type ContentWriteProof = {
  expectedVersion: number | undefined
  versionOf: 'product' | 'channelListing'
  content: ReadonlyMap<string, ContentSnapshot>
  absentListing: boolean
  /** The actual second CAS after a version-zero listing conflict; content zero still means absent. */
  listingRetry?: { listingId: string; expectedVersion: number }
}
const reloadContent = 'Reload the sheet to review these fields before saving. Your edits are kept.'

/** A content counter is valid only with the owner that confirmed it, never a newer diagnostic row token. */
export function contentWriteProof(row: TokenRow, cells: Iterable<TokenCell>, versionOf: ContentWriteProof['versionOf'],
  fallback: number | undefined, siblings: readonly TokenRow[] = []): { ok: true; proof: ContentWriteProof } | { ok: false; reason: string } {
  // Capture all cells before the response can advance a generic owner. Unchanged content can then follow a proved own CAS.
  for (const target of new Set([row, ...siblings])) if (target.id === row.id) {
    for (const cell of Object.values(target.values ?? {})) snapshotOf(target, cell)
  }
  const content = new Map<string, ContentSnapshot>(), owners = new Set<number>()
  for (const cell of cells) {
    const snapshot = snapshotOf(row, cell)
    if (!snapshot) continue
    if (snapshot.ownerVersion === undefined || !Number.isSafeInteger(snapshot.ownerVersion) || snapshot.ownerVersion < 0 ||
        (cell?.contentAddress?.tier === 'pin' ? 'channelListing' : 'product') !== versionOf) return { ok: false, reason: reloadContent }
    const previous = content.get(snapshot.key)
    if (previous && !samePair(previous, snapshot)) return { ok: false, reason: reloadContent }
    content.set(snapshot.key, snapshot); owners.add(snapshot.ownerVersion)
  }
  if (owners.size > 1) return { ok: false, reason: reloadContent }
  return { ok: true, proof: { expectedVersion: owners.size ? [...owners][0] : fallback, versionOf, content,
    absentListing: versionOf === 'channelListing' && !row.listing && fallback === 0 } }
}

/** Keep confirmed token/owner pairs, without replacing incoming values or provenance. */
export function preserveContentVersions<T extends TokenRow>(previous: TokenRow | undefined, incoming: T, knownVersion?: number): T {
  if (previous === incoming) return incoming
  const byColumn = new Map<string, ContentSnapshot>(), uniform = new Map<string, ContentSnapshot | null>()
  if (previous?.id === incoming.id) for (const [column, cell] of Object.entries(previous.values ?? {})) {
    const snapshot = snapshotOf(previous, cell)
    if (!snapshot) continue
    byColumn.set(column, snapshot)
    if (!uniform.has(snapshot.key)) uniform.set(snapshot.key, snapshot)
    else if (!uniform.get(snapshot.key) || !samePair(uniform.get(snapshot.key)!, snapshot)) uniform.set(snapshot.key, null)
  }
  // Capture read ownership BEFORE monotonic owner tokens below can advance it.
  for (const [column, cell] of Object.entries(incoming.values ?? {})) {
    const snapshot = snapshotOf(incoming, cell), own = byColumn.get(column)
    // A quiet read may retain a refused Name while reading a fresh Description on the same content row.
    // Keep each cell's proof. A renamed column can inherit only a pair that was consistent across that identity.
    const confirmed = snapshot && (own?.key === snapshot.key ? own : uniform.get(snapshot.key))
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

const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const pairOf = (value: unknown): value is ContentVersionReceipt['before'] =>
  !!value && typeof value === 'object' && counter((value as { ownerVersion?: unknown }).ownerVersion) && counter((value as { contentVersion?: unknown }).contentVersion)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * The answer's receipts, checked whole: `untrusted` when the field is present but any entry is malformed (a save that
 * wrote content always moves its owner), so nothing of the answer may move a content token. Two different receipts for
 * one content row are kept out (`conflicting`), and that row is still answered: a legacy entry may not move it instead.
 */
export function contentVersionReceiptsOf(body: unknown): { receipts: Map<string, ContentVersionReceipt>; conflicting: Set<string>; untrusted: boolean } {
  const receipts = new Map<string, ContentVersionReceipt>(), conflicting = new Set<string>()
  const list = (body as { contentVersionReceipts?: unknown } | null)?.contentVersionReceipts
  if (list === undefined) return { receipts, conflicting, untrusted: false }
  if (!Array.isArray(list)) return { receipts, conflicting, untrusted: true }
  for (const entry of list as Array<Record<string, unknown> | null>) {
    const valid = !!entry && typeof entry === 'object' && (entry.tier === 'language' || entry.tier === 'pin') && text(entry.productId) && text(entry.language) &&
      (entry.tier === 'language' ? entry.listingId === undefined : text(entry.listingId)) && pairOf(entry.before) && pairOf(entry.after) &&
      (entry.after as ContentVersionReceipt['after']).ownerVersion > (entry.before as ContentVersionReceipt['before']).ownerVersion
    if (!valid) return { receipts: new Map(), conflicting: new Set(), untrusted: true }
    const receipt = entry as unknown as ContentVersionReceipt
    const key = receiptKey(receipt), known = receipts.get(key)
    if (known && JSON.stringify([known.before, known.after]) !== JSON.stringify([receipt.before, receipt.after])) conflicting.add(key)
    receipts.set(key, receipt)
  }
  for (const key of conflicting) receipts.delete(key)
  return { receipts, conflicting, untrusted: false }
}
/** The same key `tokenKey` gives the receipt's cells: a pin by its physical listing, language text by its product. */
const receiptKey = (receipt: ContentVersionReceipt) => receipt.tier === 'language'
  ? JSON.stringify(['language', receipt.productId, receipt.language]) : JSON.stringify(['pin', receipt.listingId, receipt.language])

/**
 * Adopt each receipt on every row of its product (and, for a pin, of its exact listing): a cell whose confirmed pair is
 * the receipt's `before` takes its `after`; any other cell keeps what it has (it saw another state, or a newer one). The
 * row's own owner token moves with it only where a cell proved that start.
 */
function adoptReceipts(rows: readonly TokenRow[], receipts: Map<string, ContentVersionReceipt>, moved: Set<string>): void {
  for (const [key, receipt] of receipts) {
    for (const target of rows) {
      if (target.id !== receipt.productId || (receipt.tier === 'pin' && target.listing?.id !== receipt.listingId)) continue
      // Capture every cell's pair first: the owner token below must never re-pair a cell that had none.
      for (const cell of Object.values(target.values ?? {})) snapshotOf(target, cell)
      const before = { key, ownerVersion: receipt.before.ownerVersion, version: receipt.before.contentVersion }
      let proved = false
      for (const [colId, cell] of Object.entries(target.values ?? {})) {
        if (!cell || cell.contentVersion === undefined || tokenKey(target, cell) !== key) continue
        const current = snapshotOf(target, cell)
        if (!current || !samePair(current, before)) continue
        proved = true
        if (cell.contentVersion !== receipt.after.contentVersion) moved.add(colId)
        cell.contentVersion = receipt.after.contentVersion
        cell[snapshotKey] = { key, ownerVersion: receipt.after.ownerVersion, version: receipt.after.contentVersion }
      }
      if (!proved) continue
      if (receipt.tier === 'language' && target.version === receipt.before.ownerVersion) target.version = receipt.after.ownerVersion
      if (receipt.tier === 'pin' && target.listing && target.listing.version === receipt.before.ownerVersion) target.listing.version = receipt.after.ownerVersion
    }
  }
}

export function contentVersionsOf(body: unknown): ContentVersionAnswer[] {
  const list = (body as { contentVersions?: unknown } | null)?.contentVersions
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is ContentVersionAnswer => !!entry && typeof entry.id === 'string' &&
    (entry.tier === 'pin' || entry.tier === 'language') && typeof entry.language === 'string' && Number.isSafeInteger(entry.version))
}

/** Language content belongs to the product across aliases; pin content belongs to this listing alone. */
export function adoptContentVersions(row: TokenRow | null | undefined, body: unknown, siblings: readonly TokenRow[] = [], proof?: ContentWriteProof): string[] {
  if (!row) return []
  const moved = new Set<string>()
  const answered = new Set<string>()
  const reply = (body ?? {}) as { currentVersion?: number; versionOf?: string; updated?: number; createdListings?: unknown }
  // Qualified receipts first. A receipt list that cannot be trusted moves nothing at all — not even the legacy entries or
  // the owner-only advance below, which both assume the answer says which content moved.
  const qualified = contentVersionReceiptsOf(body)
  if (qualified.untrusted) return []
  adoptReceipts([...new Set([row, ...siblings])], qualified.receipts, moved)
  // A receipt answers its content row whether or not its before pair matched: nothing weaker may move it instead.
  for (const key of [...qualified.receipts.keys(), ...qualified.conflicting]) answered.add(key)
  for (const entry of contentVersionsOf(body)) {
    if (entry.id !== row.id) continue
    for (const target of entry.tier === 'language' ? new Set([row, ...siblings]) : [row]) {
      if (target.id !== entry.id) continue
      for (const [colId, cell] of Object.entries(target.values ?? {})) {
        if (!cell || cell.contentVersion === undefined) continue
        if (cell.contentAddress?.tier !== entry.tier || cell.contentAddress.language !== entry.language) continue
        const current = snapshotOf(target, cell)
        const key = tokenKey(target, cell) ?? ''
        // A content row a receipt answered is never moved by the weaker legacy entry, matched or not.
        if (qualified.receipts.has(key) || qualified.conflicting.has(key)) continue
        answered.add(key)
        const before = proof?.content.get(key)
        const absent = proof?.content.get(absentPinKey(target, cell))
        // A successful retry with contentVersion 0 proves a NEW pin row even if the listing already existed.
        // An existing pin has version >=1 and the canonical writer refuses that same absence precondition.
        const retry = proof?.listingRetry
        const createdPin = retry && retry.listingId === target.listing?.id && retry.expectedVersion > 0 &&
          (reply.updated ?? 0) > 0 && Number.isSafeInteger(reply.currentVersion) && reply.currentVersion! > retry.expectedVersion && entry.version >= 1
        const created = proof?.absentListing && proof.expectedVersion === 0 && absent?.ownerVersion === 0 && absent.version === 0 &&
          current?.ownerVersion === 0 && current.version === 0 && entry.tier === 'pin' && !!target.listing?.id &&
          (createdPin || Array.isArray(reply.createdListings) &&
            reply.createdListings.some(item => item && typeof item === 'object' && item.productId === target.id && item.listingId === target.listing?.id))
        if (proof && (reply.versionOf !== proof.versionOf ||
            (proof.absentListing ? !created : !before || !current || !samePair(current, before)))) continue
        const ownerVersion = reply.versionOf === (entry.tier === 'pin' ? 'channelListing' : 'product') && typeof reply.currentVersion === 'number' ? reply.currentVersion : undefined
        const confirmed = { key, ownerVersion, version: entry.version }
        if (current && newer(current, confirmed)) continue
        if (cell.contentVersion !== entry.version) moved.add(colId)
        cell.contentVersion = entry.version
        cell[snapshotKey] = confirmed
      }
    }
  }
  // A successful own fact write can move the owner without moving this content. A 409 or no-op cannot.
  // Keep the real content counter: a formula may have changed it, in which case the next CAS still refuses until read.
  const guardedOwner = proof?.listingRetry?.expectedVersion ?? proof?.expectedVersion
  if (proof && guardedOwner !== undefined && (reply.updated ?? 0) > 0 && reply.versionOf === proof.versionOf &&
      Number.isSafeInteger(reply.currentVersion) && reply.currentVersion! >= guardedOwner) {
    for (const target of new Set([row, ...siblings])) {
      if (target.id !== row.id) continue
      for (const cell of Object.values(target.values ?? {})) {
        const current = snapshotOf(target, cell)
        if (!cell || !current || answered.has(current.key) || current.ownerVersion !== guardedOwner) continue
        if (proof.versionOf === 'product' ? cell.contentAddress?.tier !== 'language'
          : cell.contentAddress?.tier !== 'pin' || target.listing?.id !== row.listing?.id) continue
        cell[snapshotKey] = { ...current, ownerVersion: reply.currentVersion }
      }
    }
  }
  return [...moved]
}
