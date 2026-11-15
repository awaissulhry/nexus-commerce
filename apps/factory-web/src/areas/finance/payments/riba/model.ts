import { isApiError, issuePath } from '../../../../lib/api/errors'
import { writeProblem } from '../../_shared/model'
import { scoped, type Phrase } from './depth'
import { MAX_RIBA_WINDOW_DAYS, RIBA_REFUSALS, type RibaBatch, type RibaCandidate, type RibaItem, type RibaPick, type RibaRefusal, type SettleInput } from './api'

/**
 * The Ri.Ba. batch's rules without a screen (B-W2b-425): the due window, which instalments are picked, the SIA code and the
 * customers' banks the file needs, the bank's report (paid or came back with its fee), and a refusal in words — each a
 * key of this step's catalogue (`finance-payments-depth`). Pure: the tests hold it.
 */

const MS_DAY = 86_400_000
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`)
export const addDays = (day: string, days: number): string => new Date(dayMs(day) + days * MS_DAY).toISOString().slice(0, 10)
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The window a new batch starts with: the instalments due from today to the end of the next 30 days. */
export const defaultWindow = (today: string): { dueFrom: string; dueTo: string } => ({ dueFrom: today, dueTo: addDays(today, 30) })

/** Why the window is not asked yet (null: it may be): both days, in order, at most a year. */
export function windowProblem(dueFrom: string, dueTo: string): Phrase | null {
  if (!DAY.test(dueFrom) || !DAY.test(dueTo)) return { key: scoped('riba.window.missing') }
  if (dueTo < dueFrom) return { key: scoped('riba.window.order') }
  if ((dayMs(dueTo) - dayMs(dueFrom)) / MS_DAY > MAX_RIBA_WINDOW_DAYS) return { key: scoped('riba.window.long'), params: { days: MAX_RIBA_WINDOW_DAYS } }
  return null
}

export const pickKey = (row: { invoice: { id: string }; instalment: number }): string => `${row.invoice.id}:${row.instalment}`

/** Every instalment that may join a batch now (nothing holds it), picked by default. */
export const freeKeys = (candidates: readonly RibaCandidate[]): string[] => candidates.filter((row) => row.held === null).map(pickKey)

/** The picked instalments as the API takes them (only free ones; the order of the list). */
export function picksOf(candidates: readonly RibaCandidate[], picked: ReadonlySet<string>): RibaPick[] {
  return candidates.filter((row) => row.held === null && picked.has(pickKey(row))).map((row) => ({ invoiceId: row.invoice.id, instalment: row.instalment }))
}

/** The total of the picked instalments (minor units), null without the price grain. */
export function pickedTotal(candidates: readonly RibaCandidate[], picked: ReadonlySet<string>): number | null {
  let total = 0
  for (const row of candidates) {
    if (row.held !== null || !picked.has(pickKey(row))) continue
    if (row.amount === undefined) return null
    total += row.amount
  }
  return total
}

/** The SIA code the bank gave the company (5 letters or digits), upper case. */
export const siaOf = (value: string): string => value.trim().toUpperCase()
export const siaProblem = (value: string): Phrase | null => (/^[A-Z0-9]{5}$/.test(siaOf(value)) ? null : { key: scoped('riba.sia.invalid') })

/** ABI or CAB: five digits. */
export const bankCodeOk = (value: string): boolean => /^\d{5}$/.test(value.trim())

export interface BankAsk {
  partyId: string
  name: string
  /** What the factory knows already (null: nothing; it must be given). */
  known: { abi: string; cab: string; source: 'GIVEN' | 'INVOICE' | 'BANK_LINE' } | null
}

/** One line per customer of the batch: whose bank is known, whose must be given before the file is made. */
export function bankAsks(items: readonly RibaItem[]): BankAsk[] {
  const out = new Map<string, BankAsk>()
  for (const item of items) {
    const seen = out.get(item.customer.id)
    const known = item.debtorBank ? { abi: item.debtorBank.abi, cab: item.debtorBank.cab, source: item.debtorBank.source } : null
    if (!seen) out.set(item.customer.id, { partyId: item.customer.id, name: item.customer.name, known })
    else if (seen.known && !known) out.set(item.customer.id, { ...seen, known: null })
  }
  return [...out.values()]
}

export interface BankTyped {
  abi: string
  cab: string
}

/** Why "Create file (download)" waits (null: it may go): the SIA code, every customer's bank, a busy write. */
export function issueHeld(input: { sia: string; asks: readonly BankAsk[]; typed: Readonly<Record<string, BankTyped>>; busy: boolean }): Phrase | null {
  if (input.busy) return { key: 'common.working' }
  if (siaProblem(input.sia)) return { key: scoped('riba.sia.invalid') }
  for (const ask of input.asks) {
    const typed = input.typed[ask.partyId]
    const given = typed && (typed.abi.trim() !== '' || typed.cab.trim() !== '')
    if (given && (!bankCodeOk(typed.abi) || !bankCodeOk(typed.cab))) return { key: scoped('riba.bank.invalid'), params: { customer: ask.name } }
    if (!ask.known && !given) return { key: scoped('riba.bank.needed'), params: { customer: ask.name } }
  }
  return null
}

/** The banks sent with the file: every customer a person typed one for (a correction of a known one too). */
export function banksOf(asks: readonly BankAsk[], typed: Readonly<Record<string, BankTyped>>): { partyId: string; abi: string; cab: string }[] {
  return asks.flatMap((ask) => {
    const entry = typed[ask.partyId]
    return entry && bankCodeOk(entry.abi) && bankCodeOk(entry.cab) ? [{ partyId: ask.partyId, abi: entry.abi.trim(), cab: entry.cab.trim() }] : []
  })
}

// ---- the bank's report ------------------------------------------------------------------------------------------------------------

export interface SettleRow {
  /** Left alone: still waiting for the bank. */
  status: 'PAID' | 'UNPAID' | 'WAIT'
  settledOn: string
  /** UNPAID: the bank's fee as typed (major units). */
  fee: string
}

/** The items still with the bank (ISSUED in an issued batch). */
export const waitingItems = (batch: RibaBatch): RibaItem[] => (batch.status === 'ISSUED' ? batch.items.filter((item) => item.status === 'ISSUED') : [])

/** An amount typed in major units ("3,50" or "3.50") as minor units, null when it is not one. */
export function feeMinor(value: string): number | null {
  const text = value.trim().replace(/\s/g, '')
  if (!/^\d{1,7}([.,]\d{1,2})?$/.test(text)) return null
  const [whole, part = ''] = text.split(/[.,]/)
  return Number(whole) * 100 + Number(part.padEnd(2, '0'))
}

/** A row's problem (null: fine): a day on or after its due day and not after today; an unpaid return carries its fee. */
export function settleRowProblem(item: RibaItem, row: SettleRow, today: string): Phrase | null {
  if (row.status === 'WAIT') return null
  if (!DAY.test(row.settledOn)) return { key: scoped('riba.settle.day') }
  if (row.settledOn < item.dueDate) return { key: scoped('refusal.riba.BEFORE_DUE') }
  if (row.settledOn > today) return { key: scoped('refusal.riba.FUTURE_DAY') }
  if (row.status === 'UNPAID' && feeMinor(row.fee) === null) return { key: scoped('refusal.riba.FEE_NEEDED') }
  return null
}

/** The settlement the API takes (only the rows a person decided), or the first problem in words. */
export function settlementOf(items: readonly RibaItem[], rows: Readonly<Record<string, SettleRow>>, today: string): { items: SettleInput[]; problem: Phrase | null } {
  const out: SettleInput[] = []
  for (const item of items) {
    const row = rows[item.id]
    if (!row || row.status === 'WAIT') continue
    const problem = settleRowProblem(item, row, today)
    if (problem) return { items: [], problem }
    out.push({ itemId: item.id, status: row.status, settledOn: row.settledOn, ...(row.status === 'UNPAID' ? { unpaidFee: feeMinor(row.fee) } : {}) })
  }
  return { items: out, problem: out.length === 0 ? { key: scoped('riba.settle.nothing') } : null }
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export interface RibaProblem extends Phrase {
  /** The batch changed meanwhile: read it again. */
  reload: boolean
  /** The customers whose bank the file asked for (their ids), to ask ABI and CAB. */
  banksFor?: string[]
}

const isRefusal = (code: string): code is RibaRefusal => (RIBA_REFUSALS as readonly string[]).includes(code)

/**
 * A refused Ri.Ba. write in words, never the API's English: a refusal code of the batch, a receipt's or a settled item's
 * (`riba/<CODE>`, `items/<i>/<CODE>`, `body/items/<i>/<CODE>`, `riba/FILE_DATA/…`), else the finance words of the kind.
 * `items` names the receipts so a missing bank names its customer.
 */
export function ribaProblem(error: unknown, items: readonly RibaItem[] = []): RibaProblem {
  if (isApiError(error)) {
    const banksFor = new Set<string>()
    let first: RibaProblem | null = null
    for (const issue of error.issues) {
      const path = issuePath(issue)
      const item = /^(?:body\/)?items\/(\d+)\/([A-Z_]+)$/.exec(path)
      if (item) {
        const code = item[2]!
        const row = items[Number(item[1])]
        if (code === 'NO_DEBTOR_BANK' && row) banksFor.add(row.customer.id)
        if (!first && isRefusal(code)) first = row ? { key: scoped(`refusalItem.riba.${code}`), params: { invoice: row.invoice.number ?? '—', customer: row.customer.name }, reload: false } : { key: scoped(`refusal.riba.${code}`), reload: false }
        continue
      }
      if (/^riba\/FILE_DATA(\/|$)/.test(path)) {
        first ??= { key: scoped('refusal.riba.FILE_DATA'), reload: false }
        continue
      }
      const batch = /^riba\/([A-Z_]+)$/.exec(path)
      if (batch && isRefusal(batch[1]!)) first ??= { key: scoped(`refusal.riba.${batch[1]}`), reload: batch[1] === 'NOT_DRAFT' }
      if (path === 'riba/CHANGED') first ??= { key: scoped('riba.changed'), reload: true }
    }
    if (first) return banksFor.size > 0 ? { ...first, banksFor: [...banksFor] } : first
  }
  const plain = writeProblem(error)
  return plain.params ? { key: plain.key, params: plain.params, reload: plain.reload } : { key: plain.key, reload: plain.reload }
}

/** A bank account's IBAN as the screen shows it: its country and check digits, then the last four. */
export function maskIban(iban: string): string {
  const compact = iban.replace(/\s/g, '')
  return compact.length <= 8 ? compact : `${compact.slice(0, 4)} •••• ${compact.slice(-4)}`
}

/** The tone of an item's state (Pill). */
export const ITEM_TONE: Record<RibaItem['status'], 'neutral' | 'success' | 'danger'> = { ISSUED: 'neutral', PAID: 'success', UNPAID: 'danger' }
export const BATCH_TONE: Record<RibaBatch['status'], 'neutral' | 'info' | 'success'> = { DRAFT: 'neutral', ISSUED: 'info', CANCELLED: 'neutral' }

// ---- the SIA code remembered on this device (no column keeps it: B-W2b-402's schema need 1) ----------------------------------------

const SIA_KEY = (companyId: string) => `fw.finance.riba.sia.${companyId}`

/** The SIA code last typed on this device for the company (a per-viewer convenience; '' when none or storage is off). */
export function rememberedSia(companyId: string): string {
  try {
    return window.localStorage.getItem(SIA_KEY(companyId)) ?? ''
  } catch {
    return ''
  }
}

export function rememberSia(companyId: string, sia: string): void {
  try {
    window.localStorage.setItem(SIA_KEY(companyId), siaOf(sia))
  } catch {
    // Not kept on this device: typed again next time.
  }
}

// ---- the CBI file read back (the new tab) -------------------------------------------------------------------------------------------

export interface CbiRecord {
  /** The record's type (IB, 14, 20, 30, 40, 50, 51, 70, EF). */
  type: string
  text: string
}

/** The file's records (120 characters each, CR LF between): the type is the record's characters 2–3. */
export function cbiRecords(text: string): CbiRecord[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => ({ type: line.slice(1, 3).trim(), text: line }))
}

/** Receipts in the file: one 14 record each. */
export const cbiReceipts = (records: readonly CbiRecord[]): number => records.filter((record) => record.type === '14').length
