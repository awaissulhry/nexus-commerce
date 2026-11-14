import type { Issue } from '../../core/errors'
import type { MinorUnits } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'

/**
 * The Ri.Ba. presentation file in the CBI layout (B-W2b-402; FIN-126; plan W2b §12 "Ri.Ba. and payment terms": the file for
 * the MP12 instalments a person uploads to the bank's own site — nothing is sent by itself), pure. A flat text file of
 * 120-character records, each ended by CR LF, in this order:
 *
 *   IB   the header: the creditor's SIA code, the collecting bank's ABI, the day it was made (DDMMYY), the file's name
 *   per receipt, seven records sharing its number (1, 2 …):
 *     14   due day (DDMMYY), causale 30000, the amount in cents with the sign "-", the collecting bank (ABI, CAB, account),
 *          the debtor's bank (ABI, CAB), the creditor's SIA code, code type 4 and the customer's code
 *     20   the creditor: name, address, postcode and town, its VAT number (4 × 24)
 *     30   the debtor: name (60) and its VAT number or codice fiscale (16)
 *     40   the debtor's address (30), postcode (5), town (22) and province (2), the debtor's bank in words (50)
 *     50   what is collected: "PER LA FATTURA N. … DEL … IMP …" (80), the creditor's VAT number (16)
 *     51   the receipt's number (10) and the creditor's name (20)
 *     70   the end of the receipt
 *   EF   the footer: the header's keys, how many receipts, their total in cents, 15 zeros, how many records (7 × n + 2)
 *
 * Letters are written in capitals without accents; any other character outside the CBI set becomes a space. UNVERIFIED: the
 * layout follows the CBI Ri.Ba. standard as commonly published; the company's bank (and its accountant) confirm it before
 * the company's Ri.Ba. switch is turned on (GATE-ACCOUNTANT). Every code in tests is made up (SIA, ABI and CAB 00000).
 */

export const CBI_RECORD_LENGTH = 120
export const CBI_RECORDS_PER_RECEIPT = 7
/** The most receipts one file holds (a 7-digit count; far above a week's batch). */
export const MAX_CBI_RECEIPTS = 9_999
/** The largest amount a record holds: 13 digits of cents. */
export const MAX_CBI_AMOUNT = 9_999_999_999_999

export const CBI_RIBA_RULE =
  'UNVERIFIED: the Ri.Ba. file follows the CBI standard as commonly published (records IB, 14, 20, 30, 40, 50, 51, 70, EF of 120 characters). Your bank checks the file when you upload it; confirm the layout with the bank and the accountant before switching Ri.Ba. on.'

export interface CbiCreditor {
  /** The SIA code the bank gave the company for CBI files: 5 letters or digits. */
  readonly siaCode: string
  /** The collecting bank account (an Italian IBAN: its ABI, CAB and account number). */
  readonly abi: string
  readonly cab: string
  readonly account: string
  readonly name: string
  readonly street: string
  /** "20121 MILANO MI". */
  readonly postcodeTown: string
  /** The Partita IVA (11 digits) or the codice fiscale. */
  readonly vatNumber: string
}

export interface CbiDebtor {
  /** The customer's code in the factory. */
  readonly code: string
  readonly name: string
  /** Its Partita IVA or codice fiscale. */
  readonly taxId: string
  readonly street: string
  readonly postcode: string
  readonly town: string
  readonly province: string
}

export interface CbiReceipt {
  readonly dueDate: BusinessDate
  readonly amount: MinorUnits
  /** The bank the receipt is presented to for payment (the customer's): ABI, CAB and its name when known. */
  readonly debtorBank: { readonly abi: string; readonly cab: string; readonly name: string | null }
  readonly debtor: CbiDebtor
  readonly invoice: { readonly number: string; readonly issueDate: BusinessDate }
}

export interface CbiFlow {
  readonly creditor: CbiCreditor
  readonly receipts: readonly CbiReceipt[]
  /** The day the file is made. */
  readonly createdOn: BusinessDate
  /** The file's name inside the flow: 1 to 20 letters or digits, unique per company (supportNameOf). */
  readonly supportName: string
}

export interface CbiFile {
  readonly text: string
  readonly receipts: number
  readonly records: number
  readonly total: MinorUnits
}

const ABI_CAB = /^\d{5}$/
const SIA = /^[A-Z0-9]{5}$/
const SUPPORT = /^[A-Z0-9]{1,20}$/

/** The ABI, CAB and account number of an Italian IBAN (IT, 2 check digits, CIN, ABI 5, CAB 5, account 12); null otherwise. */
export function abiCabOfIban(iban: string | null | undefined): { readonly abi: string; readonly cab: string; readonly account: string } | null {
  const compact = (iban ?? '').replace(/\s+/g, '').toUpperCase()
  if (!/^IT\d{2}[A-Z]\d{10}[A-Z0-9]{12}$/.test(compact)) return null
  return { abi: compact.slice(5, 10), cab: compact.slice(10, 15), account: compact.slice(15, 27) }
}

/** Capitals without accents; anything outside the CBI set becomes a space; spaces folded. */
export function cbiText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .,'/&()+:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A day as the records write it: DDMMYY. */
export const cbiDay = (day: BusinessDate): string => `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`

/** The file's name in the flow: "RIBA" + YYMMDD + the first 10 characters of the batch id, in capitals (20). */
export const supportNameOf = (batchId: string, createdOn: BusinessDate): string => `RIBA${createdOn.slice(2, 4)}${createdOn.slice(5, 7)}${createdOn.slice(8, 10)}${batchId.replace(/-/g, '').slice(0, 10).toUpperCase()}`

const left = (value: string, width: number): string => cbiText(value).slice(0, width).padEnd(width, ' ')
const digits = (value: number | string, width: number): string => String(value).padStart(width, '0').slice(-width)
const blank = (width: number): string => ' '.repeat(width)

/** What keeps the flow from being written (empty when it can be), each problem at its path. */
export function cbiProblems(flow: CbiFlow): Issue[] {
  const problems: Issue[] = []
  const { creditor } = flow
  if (!SIA.test(creditor.siaCode)) problems.push({ path: 'creditor/siaCode', message: 'The SIA code the bank gave the company: 5 letters or digits.' })
  if (!ABI_CAB.test(creditor.abi) || !ABI_CAB.test(creditor.cab) || !/^[A-Z0-9]{1,12}$/.test(creditor.account)) problems.push({ path: 'creditor/account', message: 'The collecting account is an Italian IBAN (its ABI, CAB and account number).' })
  if (cbiText(creditor.name) === '') problems.push({ path: 'creditor/name', message: "The company's name is needed." })
  if (cbiText(creditor.vatNumber) === '') problems.push({ path: 'creditor/vatNumber', message: "The company's Partita IVA is needed." })
  if (!SUPPORT.test(flow.supportName)) problems.push({ path: 'supportName', message: "The file's name: 1 to 20 letters or digits." })
  if (!isBusinessDate(flow.createdOn)) problems.push({ path: 'createdOn', message: 'The day the file is made, YYYY-MM-DD.' })
  if (flow.receipts.length === 0) problems.push({ path: 'receipts', message: 'A Ri.Ba. file holds at least one receipt.' })
  if (flow.receipts.length > MAX_CBI_RECEIPTS) problems.push({ path: 'receipts', message: `A Ri.Ba. file holds at most ${MAX_CBI_RECEIPTS} receipts.` })
  flow.receipts.forEach((receipt, index) => {
    const at = `receipts/${index}`
    if (!isBusinessDate(receipt.dueDate)) problems.push({ path: `${at}/dueDate`, message: 'The due day, YYYY-MM-DD.' })
    if (!Number.isSafeInteger(receipt.amount) || receipt.amount <= 0 || receipt.amount > MAX_CBI_AMOUNT) problems.push({ path: `${at}/amount`, message: 'An amount above 0, in cents.' })
    if (!ABI_CAB.test(receipt.debtorBank.abi) || !ABI_CAB.test(receipt.debtorBank.cab)) problems.push({ path: `${at}/debtorBank`, message: "The customer's bank (its ABI and CAB, 5 digits each) is needed." })
    if (cbiText(receipt.debtor.name) === '') problems.push({ path: `${at}/debtor/name`, message: "The customer's name is needed." })
    if (cbiText(receipt.debtor.taxId) === '') problems.push({ path: `${at}/debtor/taxId`, message: "The customer's Partita IVA or codice fiscale is needed." })
    if (cbiText(receipt.debtor.street) === '' || cbiText(receipt.debtor.town) === '') problems.push({ path: `${at}/debtor/address`, message: "The customer's address (street and town) is needed." })
    if (!/^\d{5}$/.test(receipt.debtor.postcode)) problems.push({ path: `${at}/debtor/postcode`, message: "The customer's Italian postcode (5 digits) is needed." })
    if (!/^[A-Z]{2}$/.test(receipt.debtor.province.toUpperCase())) problems.push({ path: `${at}/debtor/province`, message: "The customer's province (2 letters) is needed." })
  })
  return problems
}

/** An amount in euro as the record 50 words it ("1234,56"). */
const euroWords = (amount: MinorUnits): string => `${Math.trunc(amount / 100)},${digits(amount % 100, 2)}`

/** The flow written (call cbiProblems first: this throws on a flow that has problems). */
export function cbiRibaFile(flow: CbiFlow): CbiFile {
  const problems = cbiProblems(flow)
  if (problems.length > 0) throw new Error(`cbiRibaFile: ${problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ')}`)
  const { creditor } = flow
  const day = cbiDay(flow.createdOn)
  const keys = `${creditor.siaCode}${creditor.abi}${day}${flow.supportName.padEnd(20, ' ')}`
  const records: string[] = [` IB${keys}${blank(74)}E${blank(6)}`]
  let total = 0
  flow.receipts.forEach((receipt, index) => {
    const n = digits(index + 1, 7)
    total += receipt.amount
    records.push(
      ` 14${n}${blank(12)}${cbiDay(receipt.dueDate)}30000${digits(receipt.amount, 13)}-${creditor.abi}${creditor.cab}${creditor.account.padStart(12, '0')}${receipt.debtorBank.abi}${receipt.debtorBank.cab}${blank(12)}${creditor.siaCode}4${left(receipt.debtor.code, 16)}${blank(6)}E`,
      ` 20${n}${left(creditor.name, 24)}${left(creditor.street, 24)}${left(creditor.postcodeTown, 24)}${left(creditor.vatNumber, 24)}${blank(14)}`,
      ` 30${n}${left(receipt.debtor.name, 60)}${left(receipt.debtor.taxId, 16)}${blank(34)}`,
      ` 40${n}${left(receipt.debtor.street, 30)}${receipt.debtor.postcode}${left(receipt.debtor.town, 22)} ${left(receipt.debtor.province, 2)}${left(receipt.debtorBank.name ?? '', 50)}`,
      ` 50${n}${left(`PER LA FATTURA N. ${receipt.invoice.number} DEL ${receipt.invoice.issueDate.slice(8, 10)}/${receipt.invoice.issueDate.slice(5, 7)}/${receipt.invoice.issueDate.slice(0, 4)} IMP ${euroWords(receipt.amount)}`, 80)}${blank(10)}${left(creditor.vatNumber, 16)}${blank(4)}`,
      ` 51${n}${digits(index + 1, 10)}${left(creditor.name, 20)}${blank(80)}`,
      ` 70${n}${blank(110)}`,
    )
  })
  const count = flow.receipts.length
  records.push(` EF${keys}${blank(6)}${digits(count, 7)}${digits(total, 15)}${'0'.repeat(15)}${digits(count * CBI_RECORDS_PER_RECEIPT + 2, 7)}${blank(24)}E${blank(6)}`)
  for (const record of records) if (record.length !== CBI_RECORD_LENGTH) throw new Error(`cbiRibaFile: a record of ${record.length} characters (${record.slice(1, 3)})`)
  return { text: `${records.join('\r\n')}\r\n`, receipts: count, records: records.length, total }
}
