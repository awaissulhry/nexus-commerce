import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PREFIX, type Role } from '../../_demo/fixtures'
import { permissionsOf } from '../../invoices/test-mode/demo/fixtures'
import { designScreen as payablesScreen } from '../fixtures'
import { PayablesListView } from '../view/PayablesListView'
import type { InboxItem, InboxList } from './api'
import { inboxAbilitiesOf, type InboxRows } from './model'
import { SdiInboxSection, type SdiInboxModel } from './view/SdiInboxSection'

/**
 * SCR-153-inbox — the SDI inbox on Finance › Payables (B-W2b-GB02; B-W2b-21's routes, G088's kept file), made-up data only:
 * three deliveries waiting (a sender who is not our supplier, a closed month, a file the intermediary did not hand over),
 * one dismissed with its reason and one recorded with its invoice; Dismiss… with the reason (held while empty), a refusal,
 * the notices, the rows chosen, read-only without the right to manage supplier invoices, every row empty, failed.
 * Every company, number and file name is invented.
 */

const uid = (n: number) => `0190f0e2-9a9a-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = { id: uid(900), code: 'SCA', name: 'Officina Demo S.r.l.' }
const item = (n: number, over: Partial<InboxItem>): InboxItem => ({
  id: uid(n),
  company: COMPANY,
  sdiIdentifier: `99900${n}`,
  fileName: `IT0000000000${n}_0000${n}.xml`,
  receivedAt: '2026-11-12T08:15:00.000Z',
  problem: 'SUPPLIER_UNKNOWN',
  attempts: 3,
  lastTriedAt: '2026-11-14T06:00:00.000Z',
  status: 'OPEN',
  xmlFileId: uid(500 + n),
  recorded: null,
  dismissed: null,
  version: 2,
  ...over,
})

const OPEN: InboxItem[] = [
  item(1, {}),
  item(2, { problem: 'PERIOD_LOCKED', receivedAt: '2026-11-03T10:40:00.000Z', attempts: 9 }),
  item(3, { problem: 'FILE_UNAVAILABLE', xmlFileId: null, attempts: 1, receivedAt: '2026-11-14T05:55:00.000Z' }),
]
const DISMISSED = item(4, { status: 'DISMISSED', problem: 'OTHER_ADDRESSEE', dismissed: { at: '2026-11-10T09:00:00.000Z', by: { id: uid(800), name: 'Laura Demo' }, reason: 'Consegna di prova dell’intermediario.' } })
const RECORDED = item(5, { status: 'RECORDED', recorded: { at: '2026-11-11T07:00:00.000Z', supplierInvoiceId: uid(700), supplierInvoiceFileId: null } })
const list = (items: InboxItem[], counts = { open: 3, dismissed: 1 }): InboxList => ({ items, nextCursor: null, counts })

interface InboxCase {
  role: Role
  inbox: SdiInboxModel
  inPage?: boolean
}

const base = (role: Role, over: Partial<SdiInboxModel> = {}, extra: Partial<InboxCase> = {}): InboxCase => ({
  role,
  inbox: { prefix: PREFIX, can: inboxAbilitiesOf([...permissionsOf(role), 'payables.view', ...(role === 'sales' ? [] : ['payables.manage', 'files.read'])]), rows: 'open', list: { value: list(OPEN), problem: null }, dismissing: null, reason: '', busy: false, writeProblem: null, notice: null, fileProblem: null, ...over },
  ...extra,
})

function InboxDesign({ model }: { model: InboxCase }) {
  const section = createElement(SdiInboxSection, { model: model.inbox })
  if (!model.inPage) return inShell('/finance/payables', section, model.role)
  const page = payablesScreen.cases.find((entry) => entry.id === 'finance')!.model
  return inShell('/finance/payables', createElement(PayablesListView, { model: page.page, inbox: section }), model.role)
}

const rows = (value: InboxRows, items: InboxItem[]) => base('finance', { rows: value, list: { value: list(items), problem: null } })

export const designScreen = defineDesignScreen<InboxCase>({
  screen: 'SCR-153-inbox',
  title: 'Payables › SDI inbox: the deliveries the pickup could not record, why, the file SDI sent; dismiss or reopen',
  view: InboxDesign,
  cases: [
    { id: 'waiting', label: 'Finance · Three deliveries wait: a sender who is not our supplier, a closed month, a file not handed over', model: base('finance') },
    { id: 'in-page', label: 'Finance · The inbox in its place on Payables, before the self-invoices', model: base('finance', {}, { inPage: true }) },
    { id: 'dismiss', label: 'Finance · Dismiss…: the reason', model: base('finance', { dismissing: OPEN[0]!, reason: 'Non è un nostro fornitore: consegna sbagliata dello SDI' }) },
    { id: 'dismiss-empty', label: 'Finance · Dismiss…: no reason yet (held with why)', model: base('finance', { dismissing: OPEN[0]! }) },
    { id: 'dismiss-refused', label: 'Finance · Refused: recorded meanwhile (said in the dialog)', model: base('finance', { dismissing: OPEN[0]!, reason: 'Consegna di prova', writeProblem: { key: 'problem.write.state' } }) },
    { id: 'dismissed', label: 'Finance · Dismissed (notice); the rows Dismissed: Reopen', model: base('finance', { rows: 'dismissed', list: { value: list([DISMISSED], { open: 2, dismissed: 1 }), problem: null }, notice: { key: 'notice.dismissed', params: { file: DISMISSED.fileName } } }) },
    { id: 'all', label: 'Finance · Every delivery: waiting, dismissed, recorded (Open the invoice)', model: rows('all', [...OPEN, DISMISSED, RECORDED]) },
    { id: 'file-failed', label: 'Finance · The file could not be opened (in words)', model: base('finance', { fileProblem: 'problem.read.unavailable' }) },
    { id: 'sales', label: 'Sales · Read only: Dismiss held with why', model: base('sales') },
    { id: 'empty-recorded', label: 'Finance · The rows Recorded with none yet', model: rows('recorded', []) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base('finance', { list: { value: null, problem: 'problem.read.unavailable' } }) },
  ],
})
