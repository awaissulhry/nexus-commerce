import { at, COMPANY_ID, day, ME, NOW, SITE_ID, uid } from '../../_shared/fixtures'
import type { CapaAction, CapaCounts, CapaPerson, CapaRecord, CapaRow, CustomerChoice, ReportVersion, SourceChoice } from '../api'
import { closeLinesOf } from '../model'

/**
 * Made-up data of the Corrective actions screens (SCR-146): DEMO- numbers, Demo names, made-up problems. Nothing here is a
 * real company, customer, person or result.
 */

export { COMPANY_ID, ME, NOW, SITE_ID }
export const TODAY = day(29)

export const PEOPLE: CapaPerson[] = [
  { id: ME, name: 'Alex Demo', manages: true, remindable: true, me: true },
  { id: uid('5401', 2), name: 'Demo Inspector', manages: true, remindable: true, me: false },
  { id: uid('5401', 3), name: 'Demo Production Manager', manages: true, remindable: true, me: false },
  { id: uid('5401', 4), name: 'Demo Buyer', manages: false, remindable: true, me: false },
]
export const NAMES = PEOPLE.map((person) => ({ id: person.id, name: person.name }))
const [, INSPECTOR, PRODUCTION, BUYER] = PEOPLE.map((person) => person.id) as [string, string, string, string]

export const CUSTOMER = { id: uid('5402', 1), code: 'DEMO-C1', name: 'Demo Moto Shop' }
export const CUSTOMERS: CustomerChoice[] = [CUSTOMER, { id: uid('5402', 2), code: 'DEMO-C2', name: 'Demo Riders Brand' }]

const NCR_A = { id: uid('5403', 1), number: 'NCR-DEMO-0031' }
const NCR_B = { id: uid('5403', 2), number: 'NCR-DEMO-0036' }
const COMPLAINT = { id: uid('5404', 1), number: 'CMP-DEMO-0004' }

type RowOver = Partial<CapaRow>
const row = (n: number, over: RowOver): CapaRow => ({
  id: uid('5400', n),
  number: `CAPA-DEMO-${String(n).padStart(4, '0')}`,
  companyId: COMPANY_ID,
  type: 'CAPA',
  title: 'Demo problem',
  status: 'PLAN',
  priority: 'NORMAL',
  customer: null,
  ownerId: INSPECTOR,
  team: [],
  dueOn: day(30),
  nextDue: null,
  overdue: false,
  sources: { count: 0, items: [] },
  actions: { count: 0, open: 0, overdue: 0, done: 0 },
  ageDays: 3,
  closedAt: null,
  cancelledAt: null,
  version: 3,
  createdAt: at(26),
  updatedAt: at(28),
  ...over,
})

export const ROWS: CapaRow[] = [
  row(7, {
    type: 'EIGHT_D',
    title: 'Seam opens at the shoulder on jacket returns',
    status: 'D3',
    priority: 'HIGH',
    customer: CUSTOMER,
    ownerId: ME,
    team: [
      { userId: ME, role: 'Lead' },
      { userId: INSPECTOR, role: 'Quality' },
      { userId: PRODUCTION, role: 'Production' },
    ],
    dueOn: '2026-11-20',
    nextDue: day(27),
    sources: { count: 2, items: [{ id: uid('5405', 1), recordType: 'Nonconformance', recordId: NCR_A.id, label: NCR_A.number }, { id: uid('5405', 2), recordType: 'Complaint', recordId: COMPLAINT.id, label: COMPLAINT.number }] },
    actions: { count: 3, open: 2, overdue: 1, done: 1 },
    ageDays: 9,
    createdAt: at(20),
  }),
  row(6, {
    title: 'Zip pull loose on a size run',
    status: 'ACT',
    ownerId: PRODUCTION,
    team: [{ userId: PRODUCTION, role: 'Lead' }],
    nextDue: '2026-11-02',
    sources: { count: 1, items: [{ id: uid('5405', 3), recordType: 'Nonconformance', recordId: NCR_B.id, label: NCR_B.number }] },
    actions: { count: 2, open: 1, overdue: 0, done: 1 },
    ageDays: 6,
  }),
  row(5, { title: 'Wrong care label on a lot of gloves', status: 'PLAN', priority: 'LOW', ownerId: INSPECTOR, sources: { count: 1, items: [{ id: uid('5405', 4), recordType: 'Nonconformance', recordId: uid('5403', 3), label: null }] }, ageDays: 1 }),
  row(4, { type: 'EIGHT_D', title: 'Back protector pocket too small', status: 'D6', customer: { id: uid('5402', 2), code: 'DEMO-C2', name: 'Demo Riders Brand' }, ownerId: INSPECTOR, nextDue: '2026-11-05', actions: { count: 4, open: 1, overdue: 0, done: 3 }, ageDays: 21 }),
  row(3, { title: 'Shade difference between two hides of one order', status: 'CHECK', ownerId: ME, actions: { count: 3, open: 0, overdue: 0, done: 3 }, ageDays: 34 }),
  row(2, { title: 'Snap button pulls out', status: 'CLOSED', ownerId: INSPECTOR, actions: { count: 2, open: 0, overdue: 0, done: 2 }, ageDays: 61, closedAt: at(15) }),
  row(1, { title: 'Raised by mistake', status: 'CANCELLED', ownerId: ME, ageDays: 70, cancelledAt: at(2) }),
]

export const OPEN_ROWS = ROWS.filter((entry) => entry.status !== 'CLOSED' && entry.status !== 'CANCELLED')
export const COUNTS: CapaCounts = { open: OPEN_ROWS.length, actionsOverdue: 1, mine: 2 }

export const SOURCE_CHOICES: SourceChoice[] = [
  { recordType: 'Nonconformance', recordId: uid('5403', 4), number: 'NCR-DEMO-0040', title: 'Stitch density low on a run of trousers', companyId: COMPANY_ID },
  { recordType: 'Complaint', recordId: uid('5404', 2), number: 'CMP-DEMO-0009', title: 'Customer says the jacket zip broke after a week', companyId: COMPANY_ID },
]

const action = (seq: number, over: Partial<CapaAction>): CapaAction => ({
  id: uid('5406', seq),
  seq,
  kind: 'CORRECTIVE',
  description: 'Demo action',
  ownerId: INSPECTOR,
  dueOn: day(31),
  status: 'OPEN',
  overdue: false,
  remindersSent: 0,
  lastRemindedAt: null,
  escalateToId: null,
  escalatedAt: null,
  doneAt: null,
  doneById: null,
  evidenceNote: null,
  files: 0,
  cancelReason: null,
  version: 2,
  createdAt: at(21),
  ...over,
})

export const ACTIONS: CapaAction[] = [
  action(1, { description: 'Re-train line 2 on the shoulder seam allowance', ownerId: PRODUCTION, dueOn: day(27), overdue: true, remindersSent: 2, lastRemindedAt: at(27, 7), escalateToId: INSPECTOR, escalatedAt: at(28, 0, 5) }),
  action(2, { kind: 'PREVENTIVE', description: 'Add the seam allowance to the first-piece checklist', ownerId: INSPECTOR, dueOn: '2026-11-04', remindersSent: 0 }),
  action(3, { description: 'Hold and check the jackets in stock of the same lot', ownerId: BUYER, dueOn: day(24), status: 'DONE', doneAt: at(24, 15), doneById: BUYER, evidenceNote: '48 jackets checked, 3 reworked, the rest released.', files: 1, remindersSent: 1, lastRemindedAt: at(24, 7) }),
]

export const DOCUMENTS: ReportVersion[] = [{ id: uid('5407', 1), version: 1, language: 'en', number: 'CAPA-DEMO-0007', fileId: uid('5408', 1), createdAt: at(28, 16), createdById: ME }]

export function recordOf(base: CapaRow, over: Partial<CapaRecord> = {}, capaOver: Partial<CapaRecord['capa']> = {}): CapaRecord {
  const actions = over.actions ?? (base.id === ROWS[0]!.id ? ACTIONS : [])
  const capa: CapaRecord['capa'] = {
    ...base,
    problem: base.id === ROWS[0]!.id ? { what: 'The shoulder seam opens after a few rides', where: 'Line 2, jackets of style DEMO-JK-100', when: 'Seen on returns since early October', howMany: '6 of 120 sold' } : { what: null, where: null, when: null, howMany: null },
    closedById: base.status === 'CLOSED' ? INSPECTOR : null,
    closeNote: base.status === 'CLOSED' ? 'Buttons changed; no repeat in four lots.' : null,
    cancelReason: base.status === 'CANCELLED' ? 'Raised twice by mistake.' : null,
    createdById: ME,
    ...capaOver,
  }
  const open = actions.filter((entry) => entry.status === 'OPEN').length
  const done = actions.filter((entry) => entry.status === 'DONE').length
  const checks = closeLinesOf({ type: capa.type, status: capa.status, open, done }).map((line) => ({ key: line.key, ok: line.ok, words: 'x' }))
  const ended = capa.status === 'CLOSED' || capa.status === 'CANCELLED'
  return {
    capa,
    sources:
      base.id === ROWS[0]!.id
        ? [
            { id: uid('5405', 1), recordType: 'Nonconformance', recordId: NCR_A.id, note: null, createdAt: at(20), createdById: ME, record: { number: NCR_A.number, title: 'Shoulder seam open on returned jackets', state: 'CONTAINED', severity: 'MAJOR', category: null, siteId: SITE_ID, namesThisCapa: true } },
            { id: uid('5405', 2), recordType: 'Complaint', recordId: COMPLAINT.id, note: null, createdAt: at(20), createdById: ME, record: { number: COMPLAINT.number, title: 'Seam opened on the first ride', state: 'INVESTIGATING', severity: null, category: 'QUALITY', siteId: null, namesThisCapa: true } },
          ]
        : base.sources.items.map((item) => ({ id: item.id, recordType: item.recordType as 'Nonconformance' | 'Complaint', recordId: item.recordId, note: null, createdAt: at(26), createdById: ME, record: item.label ? { number: item.label, title: null, state: 'OPEN', severity: 'MINOR', category: null, siteId: SITE_ID, namesThisCapa: true } : null })),
    containment:
      base.id === ROWS[0]!.id
        ? [
            {
              ncrId: NCR_A.id,
              number: NCR_A.number,
              stage: 'CONTAINED',
              activeHolds: 1,
              actions: [
                { seq: 1, kind: 'HOLD_STOCK', description: 'Jackets of lot DEMO-L-17 on hold', status: 'DONE', dueAt: at(21, 12), doneAt: at(21, 11) },
                { seq: 2, kind: 'CHECK_WIP', description: 'Check the jackets on line 2', status: 'OPEN', dueAt: at(22, 18), doneAt: null },
              ],
            },
          ]
        : [],
    causes: base.id === ROWS[0]!.id ? [{ id: uid('5409', 1), code: 'METHOD-01', labelIt: 'Metodo di lavoro non seguito', labelEn: 'Work method not followed', process: 'SEWING' }] : [],
    actions,
    documents: base.id === ROWS[0]!.id ? DOCUMENTS : [],
    next: { stage: null },
    closing: { checks, ready: checks.every((check) => check.ok) },
    may: { manage: true, edit: !ended, close: !ended && checks.every((check) => check.ok), report: true },
    people: NAMES,
    ...over,
  }
}

export const RECORD: CapaRecord = recordOf(ROWS[0]!)

/** A one-page made-up PDF (Helvetica, ASCII), so the 8D preview draws in the review. */
export function demoPdf(lines: readonly string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`)
  const content = ['BT', '/F1 11 Tf', '56 780 Td', '16 TL', ...lines.map((line, index) => `${index === 0 ? '' : 'T* '}(${escape(line)}) Tj`), 'ET'].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

export const REPORT_IT = demoPdf(['Demo Factory Srl - made-up letterhead', '', 'Rapporto 8D CAPA-DEMO-0007', 'ANTEPRIMA', '', 'D1 Team: Alex Demo (guida), Demo Inspector (qualita)', 'D2 Problema: la cucitura della spalla si apre', 'D3 Contenimento: NCR-DEMO-0031, 1 blocco in vigore', 'D5 Azioni correttive: 2 (1 in ritardo)'])
export const REPORT_EN = demoPdf(['Demo Factory Srl - made-up letterhead', '', '8D report CAPA-DEMO-0007', 'PREVIEW', '', 'D1 Team: Alex Demo (lead), Demo Inspector (quality)', 'D2 Problem: the shoulder seam opens', 'D3 Containment: NCR-DEMO-0031, 1 hold in force', 'D5 Corrective actions: 2 (1 overdue)'])
