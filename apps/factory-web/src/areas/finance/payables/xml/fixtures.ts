import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { asSeenBy, canAs, DETAIL_0412, DETAIL_DE77, inShell, PREFIX, XML_0412, type Role } from '../demo/fixtures'
import { XmlView, type XmlViewModel } from './view/XmlView'

/**
 * SCR-153 new tab "Supplier invoice as received (XML view / PDF)" (design finance.payables tab:xml) with made-up data only:
 * what the XML names and the XML as SDI delivered it; a typed invoice (no XML, its PDF); a reader without the cost grain
 * (the XML holds the prices: not shown, said in words); the PDF reading and failed; loading, not found, no permission.
 */

interface Case {
  role: Role
  page: XmlViewModel
}

const base = (role: Role, over: Partial<XmlViewModel> = {}): Case => {
  const can = canAs(role)
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      invoiceId: DETAIL_0412.id,
      invoice: { status: 'ready', value: asSeenBy(DETAIL_0412, can) },
      xml: { value: asSeenBy(XML_0412, can), problem: null },
      pdf: { status: 'idle', src: null },
      ...over,
    },
  }
}

function XmlDesign({ model }: { model: Case }) {
  return inShell('/finance/payables', createElement(XmlView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-153-xml',
  title: 'Supplier invoice as received: the XML and the PDF',
  view: XmlDesign,
  cases: [
    { id: 'sdi', label: 'From SDI · what it names, the XML as received, the PDF on request', model: base('finance') },
    { id: 'pdf-loading', label: 'The PDF being read', model: base('finance', { pdf: { status: 'loading', src: null } }) },
    { id: 'pdf-failed', label: "The PDF couldn't be read", model: base('finance', { pdf: { status: 'error', src: null } }) },
    { id: 'typed', label: 'A typed foreign invoice: no XML, its PDF', model: base('finance', { invoiceId: DETAIL_DE77.id, invoice: { status: 'ready', value: DETAIL_DE77 }, xml: null }) },
    { id: 'no-cost', label: 'Read-only · the XML holds the prices: not shown, said in words', model: base('readonly') },
    { id: 'xml-reading', label: 'The XML being read', model: base('finance', { xml: { value: null, problem: null } }) },
    { id: 'xml-failed', label: "The XML couldn't be read: Try again", model: base('finance', { xml: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'loading', label: 'Loading', model: base('finance', { invoice: { status: 'loading' }, xml: null }) },
    { id: 'not-found', label: 'Not found', model: base('finance', { invoice: { status: 'not_found' }, xml: null }) },
    { id: 'no-permission', label: 'Warehouse · no payables.view', model: base('warehouse') },
  ],
})
