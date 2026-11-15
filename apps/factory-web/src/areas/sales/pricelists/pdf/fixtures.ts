import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DETAIL, V2 } from '../_demo/fixtures'
import type { KeptPdfs } from './api'
import { emptySend, type KeptPdfModel } from './model'
import { KeptPdfPart } from './view/KeptPdfPart'

/**
 * SCR-531 — the price list PDF kept for mail (B-W2b-380, XF6:01; design tab pricelists.pdf "Sent to a customer or printed for a
 * fair"): above the print view (SCR-420, case `kept`), never printed. The invented list MODA-DEMO, its draft version 2; made-up
 * people and addresses only.
 */

const KEPT: KeptPdfs = {
  listId: DETAIL.id,
  versionId: V2.id,
  revision: V2.revision,
  upToDate: true,
  needsCompany: false,
  pdfs: [
    { id: 'pdf-2', version: 2, number: `${DETAIL.code} v${V2.revision} · 2`, language: 'it', companyId: 'c-demo', fileId: 'f-2', createdAt: '2026-11-14T09:12:00.000Z', createdBy: 'Giulia Esempio' },
    { id: 'pdf-1', version: 1, number: `${DETAIL.code} v${V2.revision} · 1`, language: 'en', companyId: 'c-demo', fileId: 'f-1', createdAt: '2026-11-13T16:40:00.000Z', createdBy: 'Giulia Esempio' },
  ],
}

const CUSTOMERS: KeptPdfModel['customers'] = [
  { id: 'cust-1', code: 'CLI-DEMO-01', legalName: 'Motoclub Fittizio S.r.l.' },
  { id: 'cust-2', code: 'CLI-DEMO-02', legalName: 'Negozio Esempio S.n.c.' },
]

const model = (extra: Partial<KeptPdfModel> = {}): KeptPdfModel => ({
  can: { manage: true, price: true },
  customers: CUSTOMERS,
  read: { status: 'ready', value: KEPT },
  language: 'it',
  busy: false,
  notice: null,
  send: null,
  ...extra,
})

const draft = { ...emptySend(CUSTOMERS[0]!.id), to: 'acquisti@cliente-fittizio.example.com', cc: 'agente@esempio-fittizio.example.com', message: 'Buongiorno, ecco il listino della nuova stagione.' }

export const designScreen = defineDesignScreen<KeptPdfModel>({
  screen: 'SCR-531',
  title: 'Price list PDF kept for mail: keep, open, send (B-W2b-380)',
  view: KeptPdfPart,
  cases: [
    { id: 'kept', label: 'Sales · the newest PDF shows the version as it is', model: model(), note: 'Keep again, Open the PDF, Send… (the same file goes attached).' },
    { id: 'none', label: 'No PDF kept yet', model: model({ read: { status: 'ready', value: { ...KEPT, upToDate: null, pdfs: [] } } }) },
    { id: 'outdated', label: 'The version changed since the newest PDF', model: model({ read: { status: 'ready', value: { ...KEPT, upToDate: false } } }), note: 'Keep this version as a PDF makes PDF 3; Send keeps one first by itself.' },
    { id: 'keeping', label: 'Keeping (Keep and Send held while it runs)', model: model({ busy: true }) },
    { id: 'kept-done', label: 'Kept: the receipt', model: model({ notice: { tone: 'success', words: { key: 'pdf.kept', params: { version: 2 } } } }) },
    { id: 'refused', label: "Refused in words: the company's letterhead is not complete", model: model({ notice: { tone: 'danger', words: { key: 'pdf.problem.conflict' } } }) },
    { id: 'send', label: 'Send…: to, copies, message', model: model({ send: draft }) },
    { id: 'send-outdated', label: 'Send… when the newest is out of date (a new one is kept first)', model: model({ read: { status: 'ready', value: { ...KEPT, upToDate: false } }, language: 'en', send: draft }) },
    { id: 'send-held', label: 'Send held: an address that is not one', model: model({ send: { ...draft, to: 'acquisti@cliente-fittizio, non-un-indirizzo' } }) },
    { id: 'send-sending', label: 'Sending', model: model({ send: { ...draft, sending: true } }) },
    { id: 'sent', label: 'Sent: to whom, when', model: model({ send: { ...draft, sent: { to: draft.to, at: '2026-11-14T09:15:00.000Z' } }, notice: { tone: 'success', words: { key: 'pdf.sent', params: { version: 2 } } } }) },
    { id: 'send-refused', label: 'The send refused (said in the dialog)', model: model({ send: { ...draft, problem: { key: 'pdf.problem.unavailable' } } }) },
    { id: 'every-company', label: 'A list of every company: Send held with why', model: model({ read: { status: 'ready', value: { ...KEPT, needsCompany: true } } }) },
    { id: 'no-customer', label: 'No customer has the list yet: Send held with why', model: model({ customers: [] }) },
    { id: 'send-contact', label: 'Send… to the customer’s own contact (no address typed)', model: model({ send: { ...draft, to: '', cc: '' } }) },
    { id: 'no-manage', label: 'Finance: may read, not keep or send (held with why)', model: model({ can: { manage: false, price: true } }) },
    { id: 'no-price', label: 'A role without selling prices', model: model({ can: { manage: true, price: false } }) },
    { id: 'no-version', label: 'A list without a version to print', model: model({ read: { status: 'none' } }) },
    { id: 'loading', label: 'Reading the kept PDFs', model: model({ read: { status: 'loading' } }) },
    { id: 'error', label: "The kept PDFs couldn't be read", model: model({ read: { status: 'error', problem: { key: 'pdf.problem.unavailable' } } }) },
  ],
})
