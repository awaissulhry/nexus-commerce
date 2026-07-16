/**
 * A1 (XLSM hybrid) — single source of truth for which files the flat-file
 * import surfaces accept. Before this, the three Amazon surfaces disagreed
 * (picker allowed .xlsm but not .json, the drop regex allowed .xls but not
 * .xlsm, the wizard allowed .xls/.json but not .xlsm) — so whether an Amazon
 * template imported depended on WHERE you dropped it.
 *
 * .xlsm is a first-class citizen: Amazon's official Custom Listings Templates
 * download as .xlsm (macro content-type, usually no actual macros). .xlsb is
 * accepted at the picker so the server can reject it with a helpful message
 * instead of the browser silently filtering it.
 */

/** For <input accept> and FileDropzone accept props. */
export const SPREADSHEET_ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.xls,.xlsb,.json'

/** For drag-drop filename gates. */
export const SPREADSHEET_FILE_RE = /\.(csv|tsv|txt|xlsx|xlsm|xls|xlsb|json)$/i

/** Excel-family files that must travel as base64 bytes (never as text). */
export const EXCEL_BINARY_RE = /\.(xlsx|xlsm|xls|xlsb)$/i

/**
 * Extension says Excel — or the first bytes do (OOXML zip `PK…` / legacy BIFF
 * OLE header), covering renamed files. Mirrors the server-side
 * sniffExcelContainer so client and server never disagree.
 */
export async function isExcelBinaryFile(file: File): Promise<boolean> {
  if (EXCEL_BINARY_RE.test(file.name)) return true
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    if (head.length < 4) return false
    const isZip = head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)
    const isBiff = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0
    return isZip || isBiff
  } catch {
    return false
  }
}
