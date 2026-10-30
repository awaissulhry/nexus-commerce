import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canOf, inShell, PREFIX, TIME_ZONE, uid, type Role } from '../../../_shared/buying/fixtures'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import { blankDiscrepancy, claimDraft, draftOf, reportDraft, requestDraft, requestText, say, wantedDocuments, withCheck, dailyCan } from '../daily-model'
import { CHECK, CONTACTS, DISCREPANCIES, dailyModel, HIDE_LIST_ID, hideListSheet, hideListSummary, permissionsOf, REPORT_PDF } from '../demo/daily/fixtures'
import { COUNTS, EXPECTED, LOTS, receipt, ROWS } from '../demo/fixtures'
import type { ReceiptRecordModel, ReceiptsListModel } from '../model'
import { ReceiptDesign, receiptCase } from '../record/fixtures'
import { ReceiptsListView } from './view/ReceiptsListView'

/**
 * SCR-063 — Receipts (design warehouse.receipts) with made-up data only: the tiles, the expected order lines (Receive,
 * a selection of one order's lines), the receipts (posted, posted today, with a lot in quarantine, reversed), a search,
 * Export, and the receipt record: its lines against the order (short, exact, within the tolerance), the notes after
 * posting, Reverse (what it does; held with what used the stock, in words), reversed, and the states. Roles:
 * Warehouse, Buyer (values, no receiving), Planner, Read-only, Sales (none).
 */

type Case = { kind: 'list'; role: Role; list: ReceiptsListModel } | { kind: 'record'; role: Role; record: ReceiptRecordModel }

// B-W2a-63: the rows' discrepancies and the tile's count (made up: GR-2026-0022 has three not closed, two not reported).
const DAILY_ROWS = ROWS.map((row, index) => ({ ...row, discrepancies: index === 0 ? { count: 4, open: 3, unsent: 2 } : index === 2 ? { count: 1, open: 0, unsent: 0 } : { count: 0, open: 0, unsent: 0 } }))
const DAILY_COUNTS = { ...COUNTS, discrepanciesOpen: 3 }
const COMPANY = { id: DEMO_COMPANIES[0].id, name: DEMO_COMPANIES[0].name }

function listCase(role: Role, over: Partial<ReceiptsListModel> = {}): Case {
  const can = canOf(role)
  const rows = can.cost ? DAILY_ROWS : DAILY_ROWS.map(({ value: _value, ...row }) => row)
  const daily = dailyCan(permissionsOf(role))
  return {
    kind: 'list',
    role,
    list: {
      prefix: PREFIX,
      can,
      view: can.receive ? 'expected' : 'all',
      q: '',
      rows: { items: rows, more: false, problem: null },
      expected: { items: can.receive ? EXPECTED : null, problem: null },
      counts: DAILY_COUNTS,
      asOf: '2026-10-29T10:00:00.000Z',
      live: 'live',
      updates: 0,
      notice: null,
      timeZone: TIME_ZONE,
      hideList: { held: !daily.receive ? say('held.noReceive') : !daily.importRun ? say('held.noImport') : null, sheet: null, summary: null },
      ...over,
    },
  }
}

const recordCase = (role: Role, ...args: Parameters<typeof receiptCase> extends [Role, ...infer R] ? R : never): Case => ({ kind: 'record', ...receiptCase(role, ...args) })

function ReceiptsDesign({ model }: { model: Case }) {
  if (model.kind === 'record') return createElement(ReceiptDesign, { model: { role: model.role, record: model.record } })
  return inShell('/warehouse/receipts', createElement(ReceiptsListView, { model: model.list }), model.role)
}

const daily = (role: Role, over: Parameters<typeof dailyModel>[1] = {}) => dailyModel(role, over)
const discCase = (role: Role, over: Parameters<typeof dailyModel>[1] = {}, value = receipt()) => recordCase(role, value, { tab: 'discrepancies', daily: daily(role, over) })
const docsCase = (role: Role, over: Parameters<typeof dailyModel>[1] = {}, value = receipt()) => recordCase(role, value, { tab: 'documents', daily: daily(role, over) })
const R = receipt()
const WANTED = wantedDocuments({ supplierDdtNumber: null, ddtPhotos: [] }, LOTS)
const filledDraft = { ...blankDiscrepancy(R.lines[0]!.id), reasonCode: 'DAMAGED', quantity: '2', uom: 'HIDE' as const, note: 'Two hides with holes near the belly', photos: [{ key: 'p-1', blob: new Blob([]), name: 'GR-2026-0022-1.jpg' }] }
const checked = withCheck(reportDraft([DISCREPANCIES[0]!.id, DISCREPANCIES[1]!.id]), CHECK)
const requestFilled = (() => {
  const draft = requestDraft(WANTED)
  const text = requestText('it', { number: R.number, supplierDdtNumber: null, ddtDay: null }, WANTED)
  return { ...draft, contacts: { value: CONTACTS, problem: null }, to: [CONTACTS[0]!.id], subject: text.subject, body: text.body }
})()
const noDdt = receipt({ supplierDdtNumber: null, supplierDdtDate: null })

const issued = receipt({ reversal: { possible: false, location: 'N-RCV', blockers: [{ code: 'ISSUED', where: 'WO-00041', items: [{ kind: 'HIDE', code: 'HD-DEMO-001041-1' }, { kind: 'HIDE', code: 'HD-DEMO-001042-2' }] }, { code: 'MOVED', where: 'N-STORE', items: [{ kind: 'HIDE', code: 'HD-DEMO-001047-7' }] }] } })

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-063',
  title: 'Receipts (the list, expected order lines, a receipt, reverse)',
  view: ReceiptsDesign,
  cases: [
    { id: 'expected', label: 'Expected order lines: open quantity, tolerance, ≈ hides, Cr VI, Receive (warehouse)', model: listCase('warehouse'), note: 'Receive opens the receiving page with that order (SCR-061).' },
    { id: 'expected-selection', label: 'Two lines of one order selected: Receive 2 lines', model: listCase('warehouse', { selected: [EXPECTED[0]!.purchaseOrderLineId, EXPECTED[1]!.purchaseOrderLineId] }) },
    { id: 'expected-two-orders', label: 'Lines of two orders selected: held (one receipt is against one order)', model: listCase('warehouse', { selected: [EXPECTED[0]!.purchaseOrderLineId, EXPECTED[2]!.purchaseOrderLineId] }) },
    { id: 'posted', label: 'Rows ▾ Posted: lots released of all, hides and quantities, a missing DDT', model: listCase('warehouse', { view: 'posted', rows: { items: ROWS.filter((row) => row.status === 'POSTED').map(({ value: _v, ...row }) => row), more: false, problem: null } }) },
    { id: 'today', label: 'Tile: posted today', model: listCase('warehouse', { view: 'today', rows: { items: ROWS.slice(0, 1).map(({ value: _v, ...row }) => row), more: false, problem: null } }) },
    { id: 'waiting', label: 'Tile: with a lot in quarantine', model: listCase('warehouse', { view: 'waiting', rows: { items: ROWS.slice(0, 1).map(({ value: _v, ...row }) => row), more: false, problem: null } }) },
    { id: 'all-buyer', label: 'All receipts with their values (buyer: cost grain, no receiving)', model: listCase('buyer') },
    { id: 'selection', label: 'Receipts selected: Export N (CSV)', model: listCase('buyer', { selected: ROWS.slice(0, 2).map((row) => row.id) }) },
    { id: 'search-empty', label: 'A search that matches nothing', model: listCase('buyer', { q: 'zzz', rows: { items: [], more: false, problem: null } }) },
    { id: 'empty', label: 'First day: no receipt yet', model: listCase('warehouse', { view: 'all', rows: { items: [], more: false, problem: null }, counts: { posted: 0, reversed: 0, waiting: 0, postedSince: 0 } }) },
    { id: 'nothing-expected', label: 'Nothing is expected', model: listCase('warehouse', { expected: { items: [], problem: null } }) },
    { id: 'loading', label: 'Loading', model: listCase('warehouse', { view: 'all', rows: { items: null, more: false, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The receipts couldn't be read", model: listCase('warehouse', { view: 'all', rows: { items: null, more: false, problem: 'problem.offline' }, counts: null, asOf: null, live: 'offline' }) },
    { id: 'planner', label: 'Planner: reads the receipts, no values', model: listCase('planner') },
    { id: 'read-only', label: 'Read-only', model: listCase('readOnly') },
    { id: 'sales', label: 'Sales: no inventory.stock.view — the page says so', model: listCase('sales') },
    { id: 'record', label: 'A receipt: its lines against the order (short with the tolerance, exact), the summary', model: recordCase('warehouse') },
    { id: 'record-buyer', label: 'A receipt with its values (buyer)', model: recordCase('buyer') },
    { id: 'record-notes', label: 'Just posted: what differs from the order', model: recordCase('warehouse', receipt(), { notes: [{ code: 'SHORT', seq: 10 }, { code: 'QUARANTINE', seq: 10 }, { code: 'ONE_DYE_BATCH', seq: 10 }] }) },
    { id: 'reverse', label: 'Reverse: what it does (moves, lots rejected, the order), the reason', model: recordCase('warehouse', receipt(), { dialog: { kind: 'reverse', reason: 'Booked against the wrong order' } }) },
    { id: 'reverse-held', label: 'Reverse held: hides issued to a work order and moved, in words', model: recordCase('warehouse', issued, { dialog: { kind: 'reverse', reason: '' } }) },
    { id: 'reverse-refused', label: 'Reverse refused meanwhile (read again)', model: recordCase('warehouse', receipt(), { dialog: { kind: 'reverse', reason: 'Wrong supplier' }, dialogProblem: { key: 'rc.reverse.changed' } }) },
    { id: 'reversed', label: 'Reversed, with its reason', model: recordCase('warehouse', receipt({ status: 'REVERSED', reversedAt: '2026-10-29T10:05:00.000Z', reversalReason: 'Booked against the wrong order', reversal: null }), { notice: { tone: 'success', words: { key: 'rc.notice.reversed', params: { number: 'GR-2026-0022' } } } }) },
    { id: 'record-activity', label: 'Activity: the thread, files and history', model: recordCase('warehouse', receipt(), { tab: 'activity' }) },
    { id: 'record-dock', label: 'The thread beside a tab (⌘J)', model: recordCase('warehouse', receipt(), { dockOpen: true }) },
    { id: 'record-read-only', label: 'Read-only: Reverse held with its reason', model: recordCase('readOnly') },
    { id: 'record-loading', label: 'A receipt loading', model: recordCase('warehouse', receipt(), { receipt: { status: 'loading' } }) },
    { id: 'record-not-found', label: 'Not found (or another company)', model: recordCase('warehouse', receipt(), { receipt: { status: 'not_found' } }) },
    { id: 'record-no-permission', label: 'Sales: no inventory.stock.view', model: recordCase('sales', receipt({ id: uid('6301', 99) }), { receipt: { status: 'forbidden' } }) },
    // ---- B-W2a-63: the receipt every day (design: tiles/grid W2a parts, rec Discrepancies + Documents check, pop rc-disc-new / rc-disc-send, tab rc-tab-disc, rc-hides import) ----
    { id: 'w2a-disc-tile', label: 'W2a · Tile "Discrepancies open": the receipts with one not closed, and the Discrepancies column', model: listCase('warehouse', { view: 'discrepancies', rows: { items: DAILY_ROWS.slice(0, 1).map(({ value: _v, ...row }) => row), more: false, problem: null } }) },
    { id: 'w2a-hide-list-import', label: 'W2a · Import hide list: the one import wizard on the tannery importer (upload step)', model: listCase('warehouse', { view: 'all', hideList: { held: null, sheet: hideListSheet(COMPANY), summary: null, inline: true } }), note: 'One list = one order = ONE receipt (B-W2a-31): upload → dry run (nothing written) → apply → the receipt. The tannery-specific layout waits for a sample file (Q29).' },
    { id: 'w2a-hide-list-checked', label: 'W2a · Hide list checked, nothing received yet: totals against the order line and its tolerance', model: listCase('warehouse', { view: 'all', hideList: { held: null, sheet: null, summary: { importId: HIDE_LIST_ID, part: { value: hideListSummary(), problem: null } } } }) },
    { id: 'w2a-hide-list-received', label: 'W2a · Hide list received as GR-2026-0023 (link to its lots)', model: listCase('warehouse', { view: 'all', hideList: { held: null, sheet: null, summary: { importId: HIDE_LIST_ID, part: { value: hideListSummary({ status: 'APPLIED', counts: { rows: 12, toReceive: 0, receivedBefore: 11, errors: 1 }, receipt: { id: uid('6301', 23), number: 'GR-2026-0023', status: 'POSTED' } }), problem: null } } } }) },
    { id: 'w2a-hide-list-over', label: 'W2a · Hide list beyond the tolerance: every row needs the difference reason', model: listCase('warehouse', { view: 'all', hideList: { held: null, sheet: null, summary: { importId: HIDE_LIST_ID, part: { value: hideListSummary({ counts: { rows: 12, toReceive: 0, receivedBefore: 0, errors: 12 }, lines: [{ ...hideListSummary().lines[0]!, baseArea: '248.1000', after: '460.5000', difference: '40.5000', kind: 'OVER', needsReason: true }] }), problem: null } } } }) },
    { id: 'w2a-hide-list-failed', label: "W2a · The list's totals couldn't be read", model: listCase('warehouse', { view: 'all', hideList: { held: null, sheet: null, summary: { importId: HIDE_LIST_ID, part: { value: null, problem: 'problem.offline' } } } }) },
    { id: 'w2a-hide-list-held', label: 'W2a · Buyer: Import hide list held (receiving is the warehouse’s: inventory.receive)', model: listCase('buyer') },
    { id: 'w2a-disc', label: 'W2a · Discrepancies: open (short), open with photos (damaged), agreed with its claim, closed', model: discCase('warehouse') },
    { id: 'w2a-disc-selected', label: 'W2a · Two open ones selected: Report 2 · Claim 2 (answered ones cannot be selected, with why)', model: discCase('buyer', { selected: [DISCREPANCIES[0]!.id, DISCREPANCIES[1]!.id] }) },
    { id: 'w2a-disc-empty', label: 'W2a · No discrepancies (the first action)', model: discCase('warehouse', { discrepancies: { value: [], problem: null } }, receipt({ discrepancies: { count: 0, open: 0, unsent: 0 } })) },
    { id: 'w2a-disc-loading', label: 'W2a · Discrepancies loading', model: discCase('warehouse', { discrepancies: { value: null, problem: null } }) },
    { id: 'w2a-disc-error', label: "W2a · Discrepancies couldn't be read", model: discCase('warehouse', { discrepancies: { value: null, problem: 'problem.offline' } }) },
    { id: 'w2a-disc-read-only', label: 'W2a · Read-only: New, Report and Claim held with the missing permission', model: discCase('readOnly') },
    { id: 'w2a-disc-reversed', label: 'W2a · A reversed receipt: no new discrepancy (held, with why)', model: discCase('warehouse', {}, receipt({ status: 'REVERSED', reversedAt: '2026-10-29T10:05:00.000Z', reversalReason: 'Booked against the wrong order', reversal: null })) },
    { id: 'w2a-disc-detail', label: 'W2a · A discrepancy in its detail (?open=): photos, what happened, J / K, the moves by hand', model: discCase('warehouse', { open: DISCREPANCIES[1]!.id }) },
    { id: 'w2a-disc-detail-agreed', label: 'W2a · An agreed one: Credit received / Close, its claim linked', model: discCase('warehouse', { open: DISCREPANCIES[2]!.id }) },
    { id: 'w2a-new', label: 'W2a · New discrepancy: empty, Save held until the reason or kind is chosen', model: discCase('warehouse', { dialog: { kind: 'discrepancy', draft: blankDiscrepancy() } }) },
    { id: 'w2a-new-filled', label: 'W2a · New discrepancy filled: reason Damaged (gives the kind), line, 2 hides, a photo ready', model: discCase('warehouse', { dialog: { kind: 'discrepancy', draft: filledDraft } }) },
    { id: 'w2a-new-own-reason', label: "W2a · The company's own reason (Stains): the kind is asked, and it needs a note", model: discCase('warehouse', { dialog: { kind: 'discrepancy', draft: { ...blankDiscrepancy(R.lines[0]!.id), reasonCode: 'STAINS' } } }) },
    { id: 'w2a-new-photo', label: 'W2a · New discrepancy: taking a photo (camera or a file, marks)', model: discCase('warehouse', { dialog: { kind: 'discrepancy', draft: { ...filledDraft, photos: [], photoStep: true } } }) },
    { id: 'w2a-new-refused', label: 'W2a · Save refused: the reason went out of use meanwhile (our words)', model: discCase('warehouse', { dialog: { kind: 'discrepancy', draft: filledDraft }, problem: say('refused.reason') }) },
    { id: 'w2a-change', label: 'W2a · Change an open one (from the row ⋯ or the detail)', model: discCase('warehouse', { dialog: { kind: 'discrepancy', draft: draftOf(DISCREPANCIES[0]!) } }) },
    { id: 'w2a-close', label: 'W2a · Close: what settled it (required)', model: discCase('warehouse', { dialog: { kind: 'settle', id: DISCREPANCIES[2]!.id, to: 'CLOSED', note: '' } }) },
    { id: 'w2a-credited', label: 'W2a · Credit received for an agreed one', model: discCase('warehouse', { dialog: { kind: 'settle', id: DISCREPANCIES[2]!.id, to: 'CREDITED', note: 'Credit note NC-DEMO-12' } }) },
    { id: 'w2a-remove', label: 'W2a · Remove one recorded by mistake (never reported, no photo)', model: discCase('warehouse', { dialog: { kind: 'remove', id: DISCREPANCIES[0]!.id } }) },
    { id: 'w2a-report', label: 'W2a · Send discrepancy report: what it names, the supplier’s contacts (suggested ticked), the PDF as it will leave', model: discCase('warehouse', { dialog: { kind: 'report', draft: { ...checked, preview: { src: REPORT_PDF, problem: null } } } }), note: 'The PDF opens in a new tab too (tab rc-tab-disc): the API’s preview route, marked as a preview, stored nowhere.' },
    { id: 'w2a-report-checking', label: 'W2a · The report being checked (Send held)', model: discCase('warehouse', { dialog: { kind: 'report', draft: reportDraft([DISCREPANCIES[0]!.id]) } }) },
    { id: 'w2a-report-no-contact', label: 'W2a · The supplier has no contact with an e-mail: held, where to fix it', model: discCase('warehouse', { dialog: { kind: 'report', draft: { ...withCheck(reportDraft([DISCREPANCIES[0]!.id]), { ...CHECK, ready: false, recipients: [], problems: [{ path: 'contactIds', message: 'x' }] }), preview: { src: REPORT_PDF, problem: null } } } }) },
    { id: 'w2a-report-letterhead', label: "W2a · The company's letterhead is not complete: the preview says where to fix it", model: discCase('warehouse', { dialog: { kind: 'report', draft: { ...withCheck(reportDraft([DISCREPANCIES[0]!.id]), { ...CHECK, ready: false, problems: [{ path: 'company/legal', message: 'x' }] }), preview: { src: null, problem: 'report.problem.company' } } } }) },
    { id: 'w2a-report-sent', label: 'W2a · Report sent: the result per recipient (the mail’s delivery)', model: discCase('warehouse', { dialog: { kind: 'report', draft: { ...checked, delivery: 'DELIVERED', sent: { report: { documentFileId: uid('6803', 1), fileName: 'GR-2026-0022-non-conformita.pdf', emailId: uid('6804', 1), threadId: uid('6805', 1), to: ['qualita@conceria-demo.example'], cc: ['acquisti@officina-demo.example'], language: 'it', sentAt: '2026-10-29T10:05:00.000Z', discrepancyIds: checked.ids, sentIds: checked.ids }, discrepancies: DISCREPANCIES } } } }) },
    { id: 'w2a-claim', label: 'W2a · Claim 2 from the supplier: the CLAIM reason, credit or replacement → a draft claim', model: discCase('buyer', { dialog: { kind: 'claim', draft: { ...claimDraft([DISCREPANCIES[0]!.id, DISCREPANCIES[1]!.id]), reasonCode: 'QUALITY' } } }) },
    { id: 'w2a-claim-made', label: 'W2a · Claim made: the notice links the claim (Purchasing › Returns & claims)', model: discCase('buyer', { notice: { tone: 'success', words: say('notice.claimMade', { number: 'CLM-2026-0008' }), link: { words: say('notice.openClaim', { number: 'CLM-2026-0008' }), href: `${PREFIX}/purchasing/claims/${uid('6901', 8)}` } } }) },
    { id: 'w2a-docs', label: 'W2a · Documents check: the DDT with its photo; the Cr VI report the leather lot waits for; Request from supplier', model: docsCase('buyer') },
    { id: 'w2a-docs-no-ddt', label: 'W2a · No DDT recorded and no photo: it is asked for too; Photograph the DDT', model: docsCase('warehouse', {}, { ...noDdt, ddtPhotos: [] }) },
    { id: 'w2a-docs-capture', label: 'W2a · Photographing the DDT (the camera or a file, no marks)', model: docsCase('warehouse', { ddtStep: true }) },
    { id: 'w2a-docs-warehouse', label: 'W2a · Warehouse: Request from supplier held (e-mails to suppliers are the buyer’s: email.send)', model: docsCase('warehouse') },
    { id: 'w2a-docs-nothing', label: 'W2a · Nothing missing: these materials need no more documents', model: recordCase('buyer', receipt(), { tab: 'documents', lots: { value: LOTS.map((lot) => ({ ...lot, qualityStatus: 'RELEASED', holds: [], crViStatus: lot.requiresCrViTest ? 'PASS' : lot.crViStatus })), problem: null }, daily: daily('buyer') }) },
    { id: 'w2a-request', label: 'W2a · Request from supplier: the documents asked, the quality contact, the text in the supplier’s language', model: docsCase('buyer', { dialog: { kind: 'request', draft: requestFilled } }, noDdt) },
    { id: 'w2a-request-sent', label: 'W2a · Request sent (on the receipt’s thread)', model: docsCase('buyer', { dialog: { kind: 'request', draft: { ...requestFilled, sentTo: ['qualita@conceria-demo.example'] } } }) },
    { id: 'w2a-lines', label: 'W2a · Lines: a line ⋯ New discrepancy; the supplier invoice match and the discrepancies in the summary', model: recordCase('warehouse', receipt(), { daily: daily('warehouse') }) },
    { id: 'w2a-lots-return', label: 'W2a · Lots & hides: Return to supplier and the lot’s claims (Purchasing › Returns & claims)', model: recordCase('warehouse', receipt(), { tab: 'lots', daily: daily('warehouse') }) },
    { id: 'w2a-changed', label: 'W2a · Changed by someone else while a dialog is open: Reload', model: recordCase('warehouse', receipt(), { tab: 'discrepancies', changed: { at: '2026-10-29T10:12:00.000Z' }, daily: daily('warehouse', { dialog: { kind: 'discrepancy', draft: draftOf(DISCREPANCIES[0]!) } }) }) },
  ],
})
