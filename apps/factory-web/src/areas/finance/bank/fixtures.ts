import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { ACCOUNTS, bankModel, CUSTOMERS, F1_ANSWER, F2_ANSWER, FIGURES, inShell, L_FEES, L_MATCHED, L_OUT, L_STALE, L_SURE, L_TWO, OPEN_ITEMS, PARTIES, PLAN, STATEMENT, TO_MATCH, uid, withoutPrice, type Role } from './demo/fixtures'
import { draftOf, EMPTY_ADDRESS, emptyFigures, mappingOf } from './model'
import { MATCH_IDLE } from './view/MatchPanel'
import { BankView, type BankModel } from './view/BankView'

/**
 * SCR-152 — Finance › Payables & bank › Bank (design finance.bank) and its pop-ups SCR-570 (Import a bank statement),
 * SCR-571 (Choose another / Split), SCR-572 (Accept all High), SCR-573 (Their figures vs ours: the comparison, record and
 * correct), SCR-574 (Take back an acceptance) — made-up data only (demo/fixtures.ts). Roles: Finance, Owner, Read-only (no price grain,
 * no action: held with why), Warehouse (no access).
 */

interface Case {
  role: Role
  page: BankModel
}

const at = (role: Role, over: Partial<BankModel> = {}): Case => ({ role, page: bankModel(role, over) })
const open = (line: typeof L_SURE, over: Partial<BankModel> = {}, role: Role = 'finance'): Case => at(role, { address: { ...EMPTY_ADDRESS, line: line.id }, current: { value: line, problem: null }, ...over })

function BankDesign({ model }: { model: Case }) {
  return inShell(createElement(BankView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-152',
  title: 'Bank: saved filters, match bank lines with how sure and why, their figures vs ours',
  view: BankDesign,
  holdsPage: true,
  cases: [
    { id: 'finance', label: 'Finance · lines to match, the surest open: High, 0,40 short within the tolerance', model: at('finance'), note: '409,60 for FT-2026-00041 (open 410,00): accepting leaves 0,40 unpaid; the write-off may be ticked.' },
    { id: 'owner', label: 'Owner · the same page', model: at('owner') },
    { id: 'write-off', label: 'Write off the difference ticked (Bank charges)', model: open(L_SURE, { match: { ...MATCH_IDLE, writeOff: { on: true, reason: 'BANK_CHARGES', note: '' } } }) },
    { id: 'two-suggestions', label: 'A line with two suggestions: Medium and Low (the same amount), the Low one chosen', model: open(L_TWO, { match: { ...MATCH_IDLE, picked: L_TWO.suggestions[1]!.id } }) },
    { id: 'money-out', label: 'Money out: its supplier invoice by number; Choose another held (money out)', model: open(L_OUT) },
    { id: 'no-suggestion', label: 'Bank charges: no suggestion; Leave unmatched held with why', model: open(L_FEES) },
    { id: 'stale', label: 'Its only suggestion was paid meanwhile (stale)', model: open(L_STALE) },
    { id: 'matched', label: 'Matched view: a matched line open — its payment (⌘-click: the Payment record) and Take back', model: open(L_MATCHED, { address: { ...EMPTY_ADDRESS, view: 'MATCHED', line: L_MATCHED.id }, lines: { rows: [L_MATCHED], problem: null, slow: false, more: false } }) },
    { id: 'accepted', label: 'Just accepted: the payment recorded (open its record)', model: open(L_TWO, { match: { ...MATCH_IDLE, accepted: { lineId: L_TWO.id, paymentId: uid('5959', 77), recorded: true } } }) },
    { id: 'soft-lock', label: 'Refused: the month is closed softly — the reason asked, Accept held until typed', model: open(L_SURE, { match: { ...MATCH_IDLE, lockAsked: true, problems: [{ key: 'period.soft' }] } }) },
    { id: 'refused', label: 'Refused: this bank reference is recorded already', model: open(L_SURE, { match: { ...MATCH_IDLE, problems: [{ key: 'match.refusal.recorded' }] } }) },
    { id: 'tile-sure', label: 'A tile pressed: Sure matches to accept (the list filtered)', model: open(L_SURE, { address: { ...EMPTY_ADDRESS, view: 'SURE', line: L_SURE.id }, lines: { rows: [L_SURE], problem: null, slow: false, more: false } }) },
    { id: 'tile-old', label: 'A tile pressed: Unmatched over 7 days', model: at('finance', { address: { ...EMPTY_ADDRESS, view: 'OLD' }, current: { value: null, problem: null }, lines: { rows: [L_FEES, L_OUT, L_STALE], problem: null, slow: false, more: false } }) },
    { id: 'statement', label: 'One statement’s lines (from a payment’s Bank line card: Open the statement)', model: open(L_SURE, { address: { ...EMPTY_ADDRESS, statement: STATEMENT, line: L_SURE.id }, statement: { id: STATEMENT, companyId: uid('1111', 1), bankAccountId: ACCOUNTS[0]!.id, fileId: uid('6161', 9), fileName: 'camt053-2026-11-13.xml', format: 'CAMT053', periodStart: '2026-11-02', periodEnd: '2026-11-13', importedById: uid('3333', 1), importedBy: 'Alex Demo', importedAt: '2026-11-13T17:00:00.000Z' }, lines: { rows: [...TO_MATCH, L_MATCHED], problem: null, slow: false, more: false } }) },
    { id: 'selected', label: 'Three lines chosen · Accept 1 sure match, Export 3', model: at('finance', { selected: [L_SURE.id, L_TWO.id, L_FEES.id] }) },
    { id: 'updates', label: 'Live: 2 updates waiting behind Show', model: at('finance', { updates: 2 }) },
    { id: 'keys', label: 'The keys in the footer’s info icon', model: at('finance', { keysOpen: true }) },
    { id: 'help', label: 'Keyboard shortcuts (⋯)', model: at('finance', { help: true }) },
    { id: 'readonly', label: 'Read-only · no amounts (no price grain); every action held with the missing right', model: at('readonly') },
    { id: 'loading', label: 'Loading: tiles “—”, the list’s skeleton', model: at('finance', { counts: { value: null, problem: null }, lines: { rows: null, problem: null, slow: false, more: false }, current: { value: null, problem: null }, address: EMPTY_ADDRESS, readAt: null, live: 'connecting', figures: { ...bankModel('finance').figures, rows: null } }) },
    { id: 'slow', label: 'Still loading… after about a second', model: at('finance', { lines: { rows: null, problem: null, slow: true, more: false }, current: { value: null, problem: null }, address: EMPTY_ADDRESS }) },
    { id: 'error', label: 'Couldn’t load match bank lines (the reason, Try again); the tiles failed too', model: at('finance', { counts: { value: null, problem: 'problem.read.unavailable' }, lines: { rows: null, problem: 'problem.read.unavailable', slow: false, more: false }, current: { value: null, problem: null }, address: EMPTY_ADDRESS }) },
    { id: 'line-error', label: 'The open line could not be read alone', model: at('finance', { address: { ...EMPTY_ADDRESS, line: uid('5555', 99) }, current: { value: null, problem: 'problem.read.not_found' } }) },
    { id: 'empty', label: 'Every bank line is matched (tiles at 0)', model: at('finance', { counts: { value: { ...bankModel('finance').counts.value!, toMatch: 0, sureMatches: 0, unmatchedOverDays: 0 }, problem: null }, lines: { rows: [], problem: null, slow: false, more: false }, current: { value: null, problem: null }, address: EMPTY_ADDRESS }) },
    { id: 'none-in-view', label: 'Nothing in this view (Matched, none yet)', model: at('finance', { address: { ...EMPTY_ADDRESS, view: 'MATCHED' }, lines: { rows: [], problem: null, slow: false, more: false }, current: { value: null, problem: null } }) },
    { id: 'no-statement', label: 'No statement imported yet', model: at('finance', { counts: { value: { ...bankModel('finance').counts.value!, toMatch: 0, sureMatches: 0, unmatchedOverDays: 0, lastStatementOn: null }, problem: null }, lines: { rows: [], problem: null, slow: false, more: false }, current: { value: null, problem: null }, address: EMPTY_ADDRESS }) },
    { id: 'offline', label: 'Offline: reload to see changes', model: at('finance', { live: 'offline' }) },
    { id: 'no-permission', label: 'Warehouse · no payments.bank.view: the page says why', model: at('warehouse') },
  ],
})

export const importScreen = defineDesignScreen<Case>({
  screen: 'SCR-570',
  title: 'Import a bank statement: file → columns → check (new, duplicate refused) → import',
  view: BankDesign,
  holdsPage: true,
  cases: [
    { id: 'empty', label: 'The file not chosen yet (the accounts read)', model: at('finance', { importing: importModel() }) },
    { id: 'camt', label: 'A camt.053 file: its format and account from the file', model: at('finance', { importing: importModel({ fileName: 'camt053-2026-11-14.xml', format: 'CAMT053' }) }) },
    { id: 'sheet-account', label: 'A CSV: the account must be chosen (Check held with why)', model: at('finance', { importing: importModel({ fileName: 'movimenti-novembre.csv', format: 'CSV' }) }) },
    { id: 'reading', label: 'Uploading and checking', model: at('finance', { importing: importModel({ fileName: 'movimenti-novembre.csv', format: 'CSV', accountId: ACCOUNTS[0]!.id, step: 'reading', busy: true }) }) },
    { id: 'mapping', label: 'Columns: each heading → a statement column (the amount not mapped: held)', model: at('finance', { importing: importModel({ fileName: 'movimenti-novembre.csv', format: 'CSV', accountId: ACCOUNTS[0]!.id, step: 'mapping', plan: { ...PLAN, ready: false }, mapping: { ...mappingOf(PLAN), Importo: null } }) }) },
    { id: 'review', label: 'Check: 2 new, 1 imported before (never twice), 1 cannot be read — Import held until it is left out', model: at('finance', { importing: importModel({ fileName: 'movimenti-novembre.csv', format: 'CSV', accountId: ACCOUNTS[0]!.id, step: 'review', plan: PLAN, mapping: mappingOf(PLAN) }) }) },
    { id: 'review-skip', label: 'Check: the unreadable line left out — Import 2 lines', model: at('finance', { importing: importModel({ fileName: 'movimenti-novembre.csv', format: 'CSV', accountId: ACCOUNTS[0]!.id, step: 'review', plan: PLAN, mapping: mappingOf(PLAN), skipErrors: true }) }) },
    { id: 'importing', label: 'Importing', model: at('finance', { importing: importModel({ fileName: 'movimenti-novembre.csv', format: 'CSV', accountId: ACCOUNTS[0]!.id, step: 'importing', plan: PLAN, mapping: mappingOf(PLAN), skipErrors: true, busy: true }) }) },
    { id: 'done', label: 'Imported: 2 lines, 1 suggestion found', model: at('finance', { importing: importModel({ fileName: 'movimenti-novembre.csv', format: 'CSV', step: 'done', plan: PLAN, imported: { ...PLAN, lineIds: [uid('5555', 11), uid('5555', 12)], suggested: 1 } }) }) },
    { id: 'nothing-new', label: 'Refused: every line is imported already', model: at('finance', { importing: importModel({ fileName: 'camt053-2026-11-13.xml', format: 'CAMT053', step: 'review', plan: { ...PLAN, format: 'CAMT053', mapping: null, counts: { new: 0, duplicate: 4, error: 0 }, lines: PLAN.lines.map((entry) => ({ ...entry, verdict: 'DUPLICATE' as const, problems: [] })) }, problems: [{ key: 'import.refusal.NOTHING_NEW' }] }) }) },
    { id: 'unreadable', label: 'Refused: the file cannot be read (several accounts)', model: at('finance', { importing: importModel({ fileName: 'export.ofx', format: 'OFX', problems: [{ key: 'import.file.SEVERAL_ACCOUNTS' }] }) }) },
    { id: 'readonly', label: 'Read-only: Import statement held (payments.bank.import)', model: at('readonly') },
  ],
})

export const chooseScreen = defineDesignScreen<Case>({
  screen: 'SCR-571',
  title: 'Choose another or split a bank line over a customer’s open items',
  view: BankDesign,
  holdsPage: true,
  cases: [
    { id: 'search', label: 'The customer searched (the payer’s name)', model: open(L_TWO, { choose: chooseModel({ customer: null, customers: CUSTOMERS }) }) },
    { id: 'items', label: 'Racing Team Prova: its open invoices, nothing ticked (held)', model: open(L_TWO, { choose: chooseModel() }) },
    { id: 'split', label: 'Split over two invoices: 800,00 + 420,00', model: open(L_TWO, { choose: chooseModel({ typed: { [OPEN_ITEMS[0]!.id]: '800,00', [OPEN_ITEMS[1]!.id]: '420,00' } }) }) },
    { id: 'too-much', label: 'The amounts pass the line: held until fixed', model: open(L_TWO, { choose: chooseModel({ typed: { [OPEN_ITEMS[0]!.id]: '800,00', [OPEN_ITEMS[1]!.id]: '500,00' } }) }) },
    { id: 'rest-write-off', label: 'Less than the line: the rest stays on account, or written off within the tolerance', model: open(L_TWO, { choose: chooseModel({ typed: { [OPEN_ITEMS[0]!.id]: '800,00' }, writeOff: { on: true, reason: 'OTHER', note: '' } }) }) },
    { id: 'refused', label: 'Refused: one item is no longer open (read again)', model: open(L_TWO, { choose: chooseModel({ typed: { [OPEN_ITEMS[0]!.id]: '800,00' }, problems: [{ key: 'match.refusal.items' }] }) }) },
    { id: 'soft-lock', label: 'Refused: the month is closed softly — the reason asked', model: open(L_TWO, { choose: chooseModel({ typed: { [OPEN_ITEMS[0]!.id]: '800,00' }, lockAsked: true, problems: [{ key: 'period.soft' }] }) }) },
    { id: 'items-error', label: 'The open items could not be read', model: open(L_TWO, { choose: chooseModel({ items: null, itemsProblem: 'problem.read.unavailable' }) }) },
  ],
})

export const reviewScreen = defineDesignScreen<Case>({
  screen: 'SCR-572',
  title: 'Accept all High: one review, all or none',
  view: BankDesign,
  holdsPage: true,
  cases: [
    { id: 'ready', label: 'Two sure matches to accept (one records its payment)', model: at('finance', { review: { entries: [{ line: L_SURE, match: L_SURE.suggestions[0]! }, { line: L_TWO, match: { ...L_TWO.suggestions[0]!, confidence: 'HIGH' } }], more: false, phase: 'ready', problems: null } }) },
    { id: 'more', label: 'More than 50 wait: the first 50 (said in the summary)', model: at('finance', { review: { entries: [{ line: L_SURE, match: L_SURE.suggestions[0]! }], more: true, phase: 'ready', problems: null } }) },
    { id: 'saving', label: 'Accepting', model: at('finance', { review: { entries: [{ line: L_SURE, match: L_SURE.suggestions[0]! }], more: false, phase: 'saving', problems: null } }) },
    { id: 'done', label: 'Done: accepted', model: at('finance', { review: { entries: [{ line: L_SURE, match: L_SURE.suggestions[0]! }], more: false, phase: 'done', problems: null } }) },
    { id: 'refused', label: 'Refused: one changed meanwhile — none accepted', model: at('finance', { review: { entries: [{ line: L_SURE, match: L_SURE.suggestions[0]! }], more: false, phase: 'done', problems: [{ key: 'match.refusal.together' }] } }) },
  ],
})

const figuresOf = (over: Partial<BankModel['figures']>, role: Role = 'finance'): Case => {
  const base = bankModel(role)
  return at(role, { address: { ...EMPTY_ADDRESS }, current: { value: null, problem: null }, figures: { ...base.figures, ...over } })
}
const editor = (over: Partial<NonNullable<BankModel['figures']['editor']>> = {}): NonNullable<BankModel['figures']['editor']> => ({
  mode: 'new',
  figuresId: null,
  version: null,
  draft: emptyFigures('2026-11-15'),
  q: '',
  customers: CUSTOMERS,
  customersProblem: null,
  busy: false,
  tried: false,
  problems: null,
  ...over,
})

export const figuresScreen = defineDesignScreen<Case>({
  screen: 'SCR-573',
  title: 'Their figures vs ours: a B2B customer’s stated figures compared with ours, every difference',
  view: BankDesign,
  holdsPage: true,
  cases: [
    { id: 'list', label: 'The figures recorded: one differs (3), one agrees', model: figuresOf({}) },
    { id: 'differs', label: 'Moto Club Demo as of 10/11: an invoice paid with us they still list, a payment we never received', model: figuresOf({ open: { id: FIGURES[0]!.id, answer: F1_ANSWER, problem: null } }) },
    { id: 'agrees', label: 'Racing Team Prova as of 31/10: agrees (they listed no payment)', model: figuresOf({ open: { id: FIGURES[1]!.id, answer: F2_ANSWER, problem: null } }) },
    { id: 'readonly', label: 'Read-only: the states without amounts; Correct… and Record held', model: figuresOf({ open: { id: FIGURES[0]!.id, answer: withoutPrice({ ...F1_ANSWER, figures: { ...F1_ANSWER.figures, can: { correct: false } } }), problem: null } }, 'readonly') },
    { id: 'new', label: 'Record their figures: the customer searched', model: figuresOf({ editor: editor() }) },
    {
      id: 'new-filled',
      label: 'Filled: two orders, one payment pasted, the statement kept',
      model: figuresOf({ editor: editor({ draft: { ...emptyFigures('2026-11-15'), partyId: PARTIES.MCD.id, partyLabel: `${PARTIES.MCD.legalName} (${PARTIES.MCD.code})`, asOf: '2026-11-10', balance: '210,00', orders: [{ reference: 'PO 5521', amount: '410,00' }, { reference: 'FT-2026-00029', amount: '200,00' }], payments: [{ reference: 'CRO 0000 5555', date: '2026-11-02', amount: '400,00' }], note: '', fileName: 'estratto-moto-club-demo-10-11.pdf' } }) }),
    },
    { id: 'new-problems', label: 'Sent with problems: each field says what is wrong', model: figuresOf({ editor: editor({ tried: true, draft: { ...emptyFigures('2026-11-15'), asOf: '2026-11-20', balance: 'abc', orders: [{ reference: '', amount: '12,5x' }], payments: [{ reference: 'Bonifico', date: '', amount: '100' }] } }) }) },
    { id: 'refused', label: 'Refused: the party is not a customer', model: figuresOf({ editor: editor({ draft: { ...emptyFigures('2026-11-15'), partyId: PARTIES.CONC.id, partyLabel: `${PARTIES.CONC.legalName} (${PARTIES.CONC.code})`, balance: '0' }, problems: [{ key: 'figures.refusal.NOT_A_CUSTOMER' }] }) }) },
    { id: 'correct', label: 'Correct their figures (a typing mistake): the customer fixed', model: figuresOf({ open: { id: FIGURES[0]!.id, answer: F1_ANSWER, problem: null }, editor: editor({ mode: 'correct', figuresId: FIGURES[0]!.id, version: 1, draft: draftOf(F1_ANSWER, 'it') }) }) },
    { id: 'reading', label: 'Comparing with our books…', model: figuresOf({ open: { id: FIGURES[0]!.id, answer: null, problem: null } }) },
    { id: 'open-error', label: 'Couldn’t load these figures', model: figuresOf({ open: { id: FIGURES[0]!.id, answer: null, problem: 'problem.read.not_found' } }) },
    { id: 'empty', label: 'No customer figures recorded', model: figuresOf({ rows: [] }) },
    { id: 'error', label: 'Couldn’t load their figures vs ours', model: figuresOf({ rows: null, problem: 'problem.read.unavailable' }) },
    { id: 'slow', label: 'Still loading…', model: figuresOf({ rows: null, slow: true }) },
  ],
})

export const reverseScreen = defineDesignScreen<Case>({
  screen: 'SCR-574',
  title: 'Take back an acceptance: the payment voided, the line to match again',
  view: BankDesign,
  holdsPage: true,
  cases: [
    { id: 'ask', label: 'Take back: why (held until said)', model: open(L_MATCHED, { reverse: { line: L_MATCHED, reason: '', busy: false, problems: null, lockAsked: false, lockReason: '' } }) },
    { id: 'typed', label: 'The reason typed', model: open(L_MATCHED, { reverse: { line: L_MATCHED, reason: 'Wrong customer: the transfer was Racing Team Prova’s.', busy: false, problems: null, lockAsked: false, lockReason: '' } }) },
    { id: 'refused', label: 'Refused: the month is closed for good', model: open(L_MATCHED, { reverse: { line: L_MATCHED, reason: 'Wrong customer.', busy: false, problems: [{ key: 'period.hard' }], lockAsked: false, lockReason: '' } }) },
    { id: 'readonly', label: 'Read-only: Take back held (payments.bank.match)', model: open(withoutPrice(L_MATCHED), {}, 'readonly') },
    { id: 'done', label: 'Taken back: the line is to match again', model: open(L_SURE, { notice: { tone: 'success', phrases: [{ key: 'reverse.done' }] } }) },
  ],
})

function importModel(over: Partial<NonNullable<BankModel['importing']>> = {}): NonNullable<BankModel['importing']> {
  return { step: 'file', fileName: null, format: null, accounts: ACCOUNTS, accountsProblem: null, accountId: null, plan: null, mapping: {}, numberFormat: 'it', sheetName: null, skipErrors: false, busy: false, problems: null, imported: null, ...over }
}

function chooseModel(over: Partial<NonNullable<BankModel['choose']>> = {}): NonNullable<BankModel['choose']> {
  return {
    line: L_TWO,
    customer: { id: PARTIES.RTP.id, name: PARTIES.RTP.legalName },
    q: 'RACING TEAM PROVA SNC',
    customers: null,
    customersProblem: null,
    items: OPEN_ITEMS,
    itemsProblem: null,
    typed: {},
    writeOff: { on: false, reason: 'ROUNDING', note: '' },
    busy: false,
    problems: null,
    lockAsked: false,
    lockReason: '',
    ...over,
  }
}
