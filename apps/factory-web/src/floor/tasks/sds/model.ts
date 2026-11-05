import { cabinetOfScan, CABINET_PATH, sheetFor } from '@nexus/factory-domain/safety/chemicals/rules'
import type { FloorChemical, KeptSheet, SdsPack } from './api'

/**
 * The cabinet reader's rules (B-W2b-143; design plant.chemicals "SDS at the cabinet by QR, readable offline on floor devices";
 * REACH art. 35), pure:
 *
 *   What the tablet keeps  ONE pack per site — the site's chemicals in use with their cabinet, pictograms, signal word, H and P
 *                          statements, place, the most kept, PPE words and current sheets (version, day, language, file id,
 *                          size, SHA-256), with the time it was read — and the PDF bytes of every current sheet, each under its
 *                          file id with its SHA-256. A sheet no longer current leaves the tablet at the next refresh; a file
 *                          whose bytes do not match its SHA-256 is never kept.
 *   How a QR finds it      the cabinet's QR holds `<web>/floor/sds?cabinet=<code>`: Scan anything (or Home's scan) reads it and
 *                          moves to `/floor/sds` with the cabinet handed over as a scanned code (`openWith`: no query string,
 *                          so the page the tablet holds is the one it moves to, floor/moves.ts FLOOR_PAGES), which opens the
 *                          cabinet from the kept pack; a tablet's own camera opening the address lands on it with `?cabinet=`
 *                          while online.
 *   When it refreshes      while online with someone signed in: when the page opens and on the app's prefetch beat (every 10
 *                          minutes), so a tablet that never opened the page still has the sheets when the network goes.
 */

export { cabinetOfScan, CABINET_PATH }


/** The current sheets the pack lists whose bytes the tablet does not keep with that SHA-256. */
export function sheetsToFetch(pack: SdsPack, kept: ReadonlyMap<string, string>): KeptSheet[] {
  const wanted = new Map<string, KeptSheet>()
  for (const chemical of pack.chemicals) for (const sheet of chemical.current) if (kept.get(sheet.fileId) !== sheet.sha256) wanted.set(sheet.fileId, sheet)
  return [...wanted.values()]
}

/** The kept files the pack no longer lists (a superseded or archived product's sheet): they leave the tablet. */
export function filesToDrop(pack: SdsPack, kept: Iterable<string>): string[] {
  const listed = new Set(pack.chemicals.flatMap((chemical) => chemical.current.map((sheet) => sheet.fileId)))
  return [...kept].filter((fileId) => !listed.has(fileId))
}

export interface CabinetGroup {
  readonly code: string | null
  readonly places: readonly string[]
  readonly chemicals: readonly FloorChemical[]
}

/** The pack by cabinet (a product in no cabinet: its own group, last), each in name order. */
export function cabinetsOf(pack: SdsPack): CabinetGroup[] {
  const groups = new Map<string | null, FloorChemical[]>()
  for (const chemical of pack.chemicals) groups.set(chemical.cabinetCode, [...(groups.get(chemical.cabinetCode) ?? []), chemical])
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([code, chemicals]) => ({ code, places: [...new Set(chemicals.map((chemical) => chemical.storagePlace))], chemicals: [...chemicals].sort((x, y) => x.name.localeCompare(y.name)) }))
}

/** One cabinet of the pack, or null when the pack names no such cabinet (an old label, another site's QR). */
export const cabinetIn = (pack: SdsPack, code: string): CabinetGroup | null => cabinetsOf(pack).find((group) => group.code === code.toUpperCase()) ?? null

/** The sheet the reader opens first: the reader's language, else the site's, else the newest current one. */
export const firstSheetOf = (chemical: FloorChemical, reader: string, site: string): KeptSheet | null => sheetFor(chemical.current.map((sheet) => ({ ...sheet, status: 'CURRENT' as const })), [reader, site]) ?? null

/** The sheets of a chemical the tablet can open now (kept bytes), the others said "not on this tablet yet". */
export const keptSheets = (chemical: FloorChemical, kept: ReadonlySet<string>): { sheet: KeptSheet; kept: boolean }[] => chemical.current.map((sheet) => ({ sheet, kept: kept.has(sheet.fileId) }))
