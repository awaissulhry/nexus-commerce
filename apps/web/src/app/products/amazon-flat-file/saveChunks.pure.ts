/**
 * FFT.1 — Amazon Save previously POSTed every dirty row in ONE request: bodies
 * over 1 MB were rejected with HTTP 413 (prod-confirmed) and any network blip
 * lost the entire save. Saves now go in chunks of 25, PARENTS FIRST so a new
 * child's parent_sku resolves to a parent created in an earlier chunk
 * (parity with the eBay #28b chunked save). Pure module for tests.
 */

export const AMAZON_SAVE_CHUNK_SIZE = 25

export function chunkRowsParentsFirst<T>(
  rows: T[],
  size: number = AMAZON_SAVE_CHUNK_SIZE,
): T[][] {
  if (rows.length === 0) return []
  const isParent = (r: T) =>
    String((r as { parentage_level?: unknown }).parentage_level ?? '').trim().toLowerCase() === 'parent'
  const ordered = [...rows.filter(isParent), ...rows.filter((r) => !isParent(r))]
  const chunks: T[][] = []
  for (let i = 0; i < ordered.length; i += size) chunks.push(ordered.slice(i, i + size))
  return chunks
}
