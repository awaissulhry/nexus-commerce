import { OPTION_HEADS, parsePastedSheet, PASTE_LIMITS } from '@nexus/factory-domain/sales/quote-bulk/rules'
import type { Words } from '../record/lines-depth/model'
import type { PasteAnswer, PastedRow } from './api'

/**
 * Paste lines (design pop:quotes.pasteLines, SAL-160), pure: the columns a paste names (read here with factory-domain's own
 * parser, so the person sees the mapping before anything is asked), and what could not land in this screen's words — the
 * API's `leftOut[].message` is English, so each kind is matched here (paste.ts of B-W2b-302) and said from the row's facts.
 */

export { PASTE_LIMITS }

export interface PasteColumns {
  /** The size columns, in the order pasted. */
  sizes: string[]
  price: boolean
  /** B-W2b-374: an Options column is read (a new line takes the values it names). */
  options: boolean
  rows: number
  /** Why the first row cannot be read, or null. */
  problem: Words | null
}

const HEAD_PRICE = new Set(['price', 'unit price', 'prezzo', 'prezzo unitario'])

/** The columns of a paste: Style, Colourway, an optional Price, the size codes; null while nothing is pasted. */
export function pasteColumns(text: string): PasteColumns | null {
  if (text.trim() === '') return null
  if (text.length > PASTE_LIMITS.text) return { sizes: [], price: false, options: false, rows: 0, problem: { key: 'paste.problem.long', params: { max: PASTE_LIMITS.text } } }
  const sheet = parsePastedSheet(text)
  if (sheet.problems.length > 0) {
    const words = sheet.problems.map((problem) => problem.message).join(' ')
    const key = /least one row/.test(words) ? 'paste.problem.rows' : /"Style"/.test(words) ? 'paste.problem.style' : /"Colourway"/.test(words) ? 'paste.problem.colourway' : /twice/.test(words) ? 'paste.problem.twice' : /size codes/.test(words) ? 'paste.problem.sizes' : 'paste.problem.shape'
    return { sizes: [], price: false, options: false, rows: 0, problem: { key } }
  }
  const head = text.replace(/\r\n?/g, '\n').split('\n').find((line) => line.trim().length > 0) ?? ''
  const separator = head.includes('\t') ? '\t' : ';'
  const price = head.split(separator).some((cell) => HEAD_PRICE.has(cell.trim().toLowerCase()))
  const options = head.split(separator).some((cell) => OPTION_HEADS.has(cell.trim().toLowerCase()))
  return { sizes: sheet.sizes, price, options, rows: sheet.rows.length, problem: null }
}

/** One thing a paste could not land, in this screen's words (row and size from the facts; the kind matched from the API's). */
export function leftOutWords(entry: { size: string | null; message: string }, row: number): Words {
  const message = entry.message
  const size = entry.size ?? ''
  if (/is not whole pieces/.test(message)) return { key: 'paste.left.cell', params: { row, size } }
  if (/is not a size of/.test(message)) return { key: 'paste.left.notSize', params: { row, size } }
  if (/is not offered in/.test(message)) return { key: 'paste.left.notOffered', params: { row, size } }
  if (/not a style this company sells|no style code/.test(message)) return { key: 'paste.left.style', params: { row } }
  if (/is archived/.test(message)) return { key: 'paste.left.archived', params: { row } }
  if (/active colourway|no colourway/.test(message)) return { key: 'paste.left.colourway', params: { row } }
  if (/is pasted already/.test(message)) return { key: 'paste.left.twice', params: { row } }
  if (/price is not written on a line already/.test(message)) return { key: 'paste.left.priceKept', params: { row } }
  if (/list price is taken instead/.test(message)) return { key: 'paste.left.priceBad', params: { row } }
  if (/no (cell|piece) can land/.test(message)) return { key: 'paste.left.nothing', params: { row } }
  if (/schedule|deliver/i.test(message)) return { key: 'paste.left.schedule', params: { row } }
  return { key: 'paste.left.other', params: { row } }
}

/** The rows that land (a new line or a change) and the ones left out whole. */
export function pasteParts(answer: Pick<PasteAnswer, 'rows'> | null): { landing: PastedRow[]; skipped: PastedRow[] } {
  const rows = answer?.rows ?? []
  return { landing: rows.filter((row) => row.action !== 'SKIP'), skipped: rows.filter((row) => row.action === 'SKIP') }
}

/** A sample to show the shape (made-up codes; tab separated as a sheet copies). */
export const PASTE_SAMPLE = 'Style\tColourway\t50\t52\t54\nDEMO-JKT-01\tBLK\t2\t6\t2'
