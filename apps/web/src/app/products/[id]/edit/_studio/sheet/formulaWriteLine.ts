/**
 * G4 (2026-10-13) — the product sheet has ONE write line per row, and formula writes take their turn in it.
 *
 * A formula save, replace or removal used to leave through `useCellFormulas`' own per-row queue, beside the sheet's
 * `SheetWriter`. A formula and a cell of the same row were then in the air together, and the formula's answer carried no
 * row version, so the next cell save of the row sent the version from before the formula: 409 "Another change landed
 * first", the other change being the page's own formula (Manufacturer `=upper("acme")`, then Cost 16). A paste of Brand
 * and Manufacturer over 8 rows, two of them formulas, refused Brand on both and took 13 s.
 *
 * Now each formula write runs as the row's `SheetWriter.exclusive` turn — after the row's earlier saves, before its later
 * ones — and the formula route answers the version it left the row at (`currentVersion`, `versionOf`, and the version it
 * was made over, `versionBefore`). The row adopts it only when nothing but this write moved the row; any other change is
 * not on screen yet, so the row keeps what it read, exactly as after a field-stamped save that went ahead over another
 * change (`writtenAt`, `sheetStamps.ts`) — and the read after the formula save brings both.
 */
import type { SheetWriter } from '@/design-system/grid'

import { FORMULA_WRITE_DROPPED, type FormulaVersionFacts, type FormulaWriteLine } from '../formulaWrites'

/** The listing a channel row was read with: its id and the version its channel writes send (`useChannelSheet.ts`). */
type HeldListing = { id: string; version?: number } | null | undefined

/**
 * The version a formula write lets the row adopt: the answer's `currentVersion` for the row it names (`versionOf`), only
 * when the write was made over the version the row holds (`versionBefore`). A product version goes to the sheet writer;
 * a listing version to the row's listing — never one for the other.
 */
export function formulaAdoptedVersion(facts: FormulaVersionFacts, held: { product?: number; listing?: HeldListing }): { product?: number; listing?: number } {
  const { currentVersion, versionBefore, versionOf } = facts
  if (typeof currentVersion !== 'number' || typeof versionBefore !== 'number' || currentVersion < versionBefore) return {}
  if (versionOf === 'product') return held.product === versionBefore ? { product: currentVersion } : {}
  if (versionOf !== 'channelListing') return {}
  const listing = held.listing
  return listing && listing.version === versionBefore && (!facts.listingId || facts.listingId === listing.id) ? { listing: currentVersion } : {}
}

/** The sheet's write line for its formula writes (`useCellFormulas({ writeLine })`). Without a writer yet: sent at once. */
export function sheetFormulaLine<Row>(writerOf: () => SheetWriter<Row> | null): FormulaWriteLine {
  return (rowId, send) => {
    const writer = writerOf()
    if (!writer) return send().then(({ result }) => result)
    return writer.exclusive(rowId, async ({ expectedVersion, row }) => {
      const { result, facts } = await send()
      const listing = (row as { listing?: HeldListing } | null)?.listing
      const adopted = formulaAdoptedVersion(facts, { product: expectedVersion, listing })
      // The row the writer sends from carries its listing's version (the channel commit reads it there).
      if (adopted.listing !== undefined && listing) listing.version = adopted.listing
      return { result, version: adopted.product }
    }).then((result) => result ?? FORMULA_WRITE_DROPPED)
  }
}
