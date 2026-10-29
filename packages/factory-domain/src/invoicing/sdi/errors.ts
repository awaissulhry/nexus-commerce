import type { SdiErrorEntry } from '../../ports/sdi'

/**
 * The errors of an NS (notifica di scarto) in plain words, with what to fix (FIN-087; A2 SCR-081 "Fix and resend": SDI's
 * refusal in our words + the code; the fields to fix, each with a link). SDI's own code and description are always kept
 * and shown; the codes below are the common ones of the "Elenco controlli" of the Specifiche tecniche SDI. An unknown
 * code shows SDI's description as it came. Pure.
 *
 * `fix` names where the correction is made (the screen links to it):
 *   party     the customer's tax identity or address (Parties), then "Fix and resend" takes the new data
 *   company   our company's data (Finance settings › Company & tax)
 *   lines     the invoice's lines, VAT or totals (the correction form)
 *   text      the invoice's text or references (the correction form)
 *   none      nothing to correct in the invoice (a duplicate, a file name): see the words
 */

export type SdiFix = 'party' | 'company' | 'lines' | 'text' | 'none'

interface KnownError {
  readonly words: string
  readonly fix: SdiFix
}

export const SDI_ERROR_CODES: Readonly<Record<string, KnownError>> = Object.freeze({
  '00001': { words: 'SDI did not accept the file name.', fix: 'none' },
  '00002': { words: 'SDI has already received a file with this name; the next send uses a new name.', fix: 'none' },
  '00102': { words: 'The file signature is not valid (the intermediary signs it).', fix: 'none' },
  '00200': { words: 'The file does not follow the FatturaPA format.', fix: 'lines' },
  '00301': { words: "Our company's VAT number is not valid at the tax agency.", fix: 'company' },
  '00305': { words: "The customer's VAT number is not valid at the tax agency.", fix: 'party' },
  '00306': { words: "The customer's tax code (codice fiscale) is not valid at the tax agency.", fix: 'party' },
  '00311': { words: "The customer's SDI code (codice destinatario) does not exist.", fix: 'party' },
  '00312': { words: "The customer's SDI code (codice destinatario) is not active.", fix: 'party' },
  '00400': { words: 'A line at 0% VAT has no Natura (the reason without VAT).', fix: 'lines' },
  '00401': { words: 'A line with VAT above 0% carries a Natura; only 0% lines carry one.', fix: 'lines' },
  '00403': { words: 'The invoice date is later than the day SDI received it.', fix: 'none' },
  '00404': { words: 'SDI already has an invoice with this number and date from this company (a duplicate).', fix: 'none' },
  '00409': { words: 'The same invoice appears twice in the file.', fix: 'none' },
  '00418': { words: 'The invoice is dated before the invoice it refers to.', fix: 'text' },
  '00421': { words: 'The VAT of a rate is not computed as SDI computes it (taxable × rate, rounded).', fix: 'lines' },
  '00422': { words: "The taxable amount of a rate is not the sum of its lines' totals.", fix: 'lines' },
  '00423': { words: "A line's total is not its quantity × unit price less the discount.", fix: 'lines' },
  '00424': { words: 'A VAT rate is not written as a percentage.', fix: 'lines' },
  '00425': { words: 'The invoice number has no digit.', fix: 'none' },
  '00427': { words: "The customer's SDI code has the wrong length for a business invoice (7 characters).", fix: 'party' },
  '00429': { words: 'A 0% VAT summary has no Natura.', fix: 'lines' },
  '00430': { words: 'A VAT summary above 0% carries a Natura.', fix: 'lines' },
  '00443': { words: "The lines' VAT rates and the VAT summary's rates do not match.", fix: 'lines' },
  '00444': { words: "The lines' Natura codes and the VAT summary's do not match.", fix: 'lines' },
})

export interface SdiErrorView extends SdiErrorEntry {
  /** Our words for a known code, else SDI's description. */
  readonly words: string
  readonly fix: SdiFix
  readonly known: boolean
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** One error entry from what a payload holds: our fields (code, description, hint) or SDI's (Codice, Descrizione, Suggerimento). */
function entryOf(value: unknown): SdiErrorEntry | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const code = textOf(row.code) ?? textOf(row.Codice)
  if (code === null) return null
  return { code, description: textOf(row.description) ?? textOf(row.Descrizione) ?? '', hint: textOf(row.hint) ?? textOf(row.Suggerimento) }
}

/**
 * The errors of a stored NS payload, parsed to fields where possible: the adapter's `errors`, else SDI's own
 * `ListaErrori.Errore` (one entry or a list). Empty when the payload names none.
 */
export function sdiErrorsOf(payload: unknown): SdiErrorView[] {
  if (payload === null || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const lista = record.ListaErrori as { Errore?: unknown } | undefined
  const raw: unknown[] = Array.isArray(record.errors) ? record.errors : lista && lista.Errore !== undefined ? (Array.isArray(lista.Errore) ? lista.Errore : [lista.Errore]) : []
  return raw.flatMap((value) => {
    const entry = entryOf(value)
    if (!entry) return []
    const known = Object.hasOwn(SDI_ERROR_CODES, entry.code) ? SDI_ERROR_CODES[entry.code]! : null
    return [{ ...entry, words: known?.words ?? (entry.description || `SDI error ${entry.code}.`), fix: known?.fix ?? 'lines', known: known !== null }]
  })
}

/** The gist of a rejection for SdiSubmission.failureReason: the first error's code and words (at most 500 characters). */
export function rejectionGist(errors: readonly SdiErrorView[]): string {
  const first = errors[0]
  const text = first ? `${first.code}: ${first.words}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}` : 'SDI rejected the file without an error list.'
  return text.slice(0, 500)
}
