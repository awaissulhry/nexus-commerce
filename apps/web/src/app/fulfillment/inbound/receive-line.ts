/**
 * One receive line, built the same way by every receive screen: the desk drawer, the mobile receive page and the scan.
 *
 * `quantityReceived` is the line's new received total; `expectedReceived` is the total the screen showed when the
 * person set it. The server books the difference only while the line still stands at that total. When it has moved
 * (another receiver, another tab) it books nothing for the line and answers 409; the screen re-reads, so the person
 * sees the current total and enters it again. Two receivers on one line both count, and a screen holding an older
 * total never books a lower one over a newer one.
 */
export function receiveLine(itemId: string, shownReceived: number, total: number) {
  return { itemId, quantityReceived: total, expectedReceived: shownReceived }
}

/** The scan adds `qty` to the total its lookup returned, never past what the line expects. */
export function scanReceiveLine(cand: { itemId: string; quantityExpected: number; quantityReceived: number }, qty: number) {
  return receiveLine(cand.itemId, cand.quantityReceived, Math.min(cand.quantityExpected, cand.quantityReceived + qty))
}

/**
 * A desk drawer row: the typed total, or null when the row changes nothing (no new total, no QC change, no photo).
 * `seen` is the line's total when the person started editing the row. An empty box shows that total as its placeholder,
 * so it keeps it: a QC-only change or a photo is never sent as "0 received".
 */
export function deskReceiveLine(itemId: string, row: { qty: string; qc: string; photoUrl: string; seen: number }, currentQc: string | null) {
  const total = row.qty.trim() === '' ? row.seen : Number(row.qty)
  if (!Number.isFinite(total) || total < 0) return null
  const photoUrls = row.photoUrl?.trim() ? [row.photoUrl.trim()] : undefined
  if (total === row.seen && row.qc === (currentQc ?? '') && !photoUrls) return null
  return { ...receiveLine(itemId, row.seen, total), qcStatus: row.qc || undefined, photoUrls }
}
