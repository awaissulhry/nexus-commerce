import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PREFIX, TD01_ID, type Role } from '../../_demo/fixtures'
import { SAMPLE_XML } from '../daily/demo/fixtures'
import { InvoiceXmlView, type InvoiceXmlModel } from './view/InvoiceXmlView'

/**
 * SCR-081-xml — the invoice's legal XML shown readable (design finance.invoices tab:xml "XML view", a new tab of the invoice
 * record SCR-081) with a made-up FatturaPA file of the demo company: the readable parts (transmission, seller, buyer, the
 * document, its order and DDT, the lines, the VAT summary, the payment), the file itself, a draft (no file yet), files
 * pending, the states (loading, reading, error, not found, no permission) and the roles: Finance, Sales (read-only: same).
 */

interface XmlCase {
  role: Role
  xml: InvoiceXmlModel
}

const ready = { number: 'FT-2026-00031', docType: 'TD01', partyName: 'Moto Demo S.r.l.', status: 'DELIVERED', filesPending: false, xmlFileId: '0190f0e2-9191-7000-8000-000000000001' }

const base = (role: Role, over: Partial<InvoiceXmlModel> = {}): XmlCase => ({
  role,
  xml: { prefix: PREFIX, invoiceId: TD01_ID, invoice: { status: 'ready', value: ready }, xml: { status: 'ready', text: SAMPLE_XML }, view: 'readable', ...over },
})

function XmlDesign({ model }: { model: XmlCase }) {
  return inShell(`/finance/invoices/${TD01_ID}/xml`, createElement(InvoiceXmlView, { model: model.xml }), model.role)
}

export const designScreen = defineDesignScreen<XmlCase>({
  screen: 'SCR-081-xml',
  title: 'Invoice XML: the legal file shown readable for checking (a new tab of the invoice record)',
  view: XmlDesign,
  cases: [
    { id: 'readable', label: 'Finance · The file readable: each field in words with its legal tag', model: base('finance'), note: 'Opened in a new tab from the record’s Documents and ⋯, and the list’s row verb "View the XML".' },
    { id: 'source', label: 'Finance · The file itself, one element per line', model: base('finance', { view: 'source' }) },
    { id: 'sales', label: 'Sales · The same file (read-only everywhere)', model: base('sales') },
    { id: 'draft', label: 'Finance · A draft: no legal file yet (Download held with why)', model: base('finance', { invoice: { status: 'ready', value: { ...ready, number: null, status: 'DRAFT', xmlFileId: null } }, xml: { status: 'idle', text: null } }) },
    { id: 'pending', label: 'Finance · Issued, files pending: make them on the Documents tab', model: base('finance', { invoice: { status: 'ready', value: { ...ready, filesPending: true, xmlFileId: null } }, xml: { status: 'idle', text: null } }) },
    { id: 'reading', label: 'Reading the file from the store', model: base('finance', { xml: { status: 'loading', text: null } }) },
    { id: 'unreadable', label: 'A file that cannot be laid out: show it as it is', model: base('finance', { xml: { status: 'ready', text: '<FatturaElettronica><Broken>' } }) },
    { id: 'file-error', label: 'The file store did not answer (Try again)', model: base('finance', { xml: { status: 'error', text: null } }) },
    { id: 'loading', label: 'Loading the invoice', model: base('finance', { invoice: { status: 'loading' }, xml: { status: 'idle', text: null } }) },
    { id: 'error', label: 'The invoice could not be read (Try again)', model: base('finance', { invoice: { status: 'error', problem: 'problem.read.unavailable' }, xml: { status: 'idle', text: null } }) },
    { id: 'not-found', label: 'Not found', model: base('finance', { invoice: { status: 'not_found' }, xml: { status: 'idle', text: null } }) },
    { id: 'no-permission', label: 'No permission (invoices.view)', model: base('sales', { invoice: { status: 'forbidden' }, xml: { status: 'idle', text: null } }) },
  ],
})
