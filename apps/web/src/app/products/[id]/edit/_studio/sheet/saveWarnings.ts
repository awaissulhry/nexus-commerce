/**
 * P1 of fix/product-sheet-editing — a save's `warnings[]`: values the server STORED and named a problem with (over the
 * channel's limit, off its list, a check that could not run), each `{ id, field, warning }` in the server's own words.
 * The one reader for the channel and the master saves, so both put the same sentence on the same cell.
 */
export function saveWarningFor(body: unknown, productId: string, fields: ReadonlyArray<string | undefined>): string | undefined {
  const list = (body as { warnings?: unknown } | null)?.warnings
  if (!Array.isArray(list)) return undefined
  const mine = list.flatMap((entry) => {
    const w = entry as { id?: unknown; field?: unknown; warning?: unknown } | null
    return w && typeof w.warning === 'string' && typeof w.field === 'string' && (w.id === undefined || w.id === productId) && fields.includes(w.field) ? [w.warning] : []
  })
  return mine.length ? [...new Set(mine)].join(' ') : undefined
}
