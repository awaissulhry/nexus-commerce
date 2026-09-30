/**
 * The content row a save moved (a pin's listing translation, a shared language's product translation) comes back in the
 * save's answer with the version it holds now (`contentVersions[]`, `content-bulk-write.ts`). Every cell of the saved row
 * that writes to that content row carries the version as its write token, so the NEXT edit there chains at once. Before,
 * only a later sheet read moved the token, and an edit made before that read landed was refused as "Bullet 2 changed.
 * Reload before saving it." (the P3 commit sweep, 2026-09-30).
 */
export interface ContentVersionAnswer { id: string; tier: 'pin' | 'language'; language: string; version: number }

type TokenCell = { contentAddress?: { tier?: string; language?: string } | null; contentVersion?: number } | null | undefined
type TokenRow = { id: string; values?: Record<string, TokenCell> }

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
