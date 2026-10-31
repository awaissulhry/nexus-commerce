import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import { at, canOf, DDT_LIVE, documents, inShell, labelled, ownVan, PACKING_LISTS, PDF, PREFIX, TODAY, type Role } from '../_demo/fixtures'
import { packDocuments } from '../daily-model'
import type { PackModel } from './pack-model'
import { ShipmentPackView } from './view/ShipmentPackView'

/**
 * SCR-067-pack — the driver's pack (design warehouse.shipments tab:sh-tab-pack "All documents (one merged PDF)", a new
 * tab of SCR-067), made-up data only: the driver's sheet and every page of the DDT, the packing list, the DoC and the user
 * information drawn for one print; reading, a document that could not be read, the DDT not issued yet, no files.read
 * (the sheet only), own van, not found, no permission, a failed read.
 */

interface PackCase {
  role: Role
  page: PackModel
}

const PACKING_PDF = samplePdf(['Packing list SH-00160/2', 'Collo 1 di 2 · tg. 50 ×2, 52 ×4', 'Collo 2 di 2 · tg. 54 ×2'])
const DOC_PDF = samplePdf(['Dichiarazione di conformità UE', 'DEMO-JKT-01 rev. 2', 'Reg. (UE) 2016/425 · EN 17092-3:2020 AA'])
const UI_PDF = samplePdf(['Nota informativa', 'DEMO-JKT-01', 'Istruzioni per uso e manutenzione'])

const ready = labelled('PACKED')
const DOCUMENTS = packDocuments({ ddt: { number: DDT_LIVE.number, fileId: DDT_LIVE.fileId }, ddtRequired: true, packingList: PACKING_LISTS[0]!, travel: documents('attached').documents })
const FILES: PackModel['files'] = Object.fromEntries(DOCUMENTS.map((entry) => [entry.key, { data: entry.kind === 'DDT' ? PDF : entry.kind === 'PACKING_LIST' ? PACKING_PDF : entry.kind === 'DECLARATION_OF_CONFORMITY' ? DOC_PDF : UI_PDF, problem: null }]))

const page = (role: Role, over: Partial<PackModel> = {}): PackCase => ({
  role,
  page: {
    prefix: PREFIX,
    allowed: canOf(role).view,
    readFiles: canOf(role).readFiles,
    company: 'Officina Demo S.r.l.',
    sender: 'Demo Pelletteria S.r.l.',
    shipment: { status: 'ready', value: ready },
    ddt: { number: DDT_LIVE.number, documentDate: TODAY, startAt: DDT_LIVE.startAt, fileId: DDT_LIVE.fileId },
    documents: DOCUMENTS,
    files: FILES,
    included: DOCUMENTS.map((entry) => entry.key),
    readAt: at(29, 11, 30),
    ...over,
  },
})

function PackDesign({ model }: { model: PackCase }) {
  return inShell('/warehouse/shipments', createElement(ShipmentPackView, { model: model.page }), model.role)
}

const noDdt = packDocuments({ ddt: null, ddtRequired: true, packingList: PACKING_LISTS[0]!, travel: documents('attached').documents })

export const designScreen = defineDesignScreen<PackCase>({
  screen: 'SCR-067-pack',
  title: "A shipment's driver's pack (print): the sheet and every document, one print",
  view: PackDesign,
  cases: [
    { id: 'ready', label: 'Warehouse: the sheet, then the DDT, the packing list, the DoC and the user information', model: page('warehouse'), note: 'Print sends the sheet and every ticked document at once; untick one to leave it out.' },
    { id: 'some', label: 'Only the DDT and the packing list ticked', model: page('warehouse', { included: DOCUMENTS.filter((entry) => entry.kind === 'DDT' || entry.kind === 'PACKING_LIST').map((entry) => entry.key) }) },
    { id: 'reading', label: 'Reading the shipment', model: page('warehouse', { shipment: { status: 'loading' }, documents: null, files: {}, readAt: null }) },
    { id: 'reading-files', label: 'The sheet is there, the documents still reading (Print held)', model: page('warehouse', { files: {} }) },
    { id: 'file-failed', label: 'The DoC could not be read (said beside it; the rest prints)', model: page('warehouse', { files: { ...FILES, [DOCUMENTS[2]!.key]: { data: null, problem: 'problem.read.unavailable' } } }) },
    { id: 'no-ddt', label: 'The DDT is not issued yet: the sheet says so (the goods do not leave without it)', model: page('warehouse', { ddt: null, documents: noDdt, included: noDdt.filter((entry) => entry.fileId).map((entry) => entry.key) }) },
    { id: 'own-van', label: 'Own van: no carrier, no tracking numbers', model: page('warehouse', { shipment: { status: 'ready', value: ownVan() } }) },
    { id: 'no-files', label: 'Sales without files.read: the sheet only', model: page('sales', { readFiles: false }) },
    { id: 'not-found', label: 'Not found (or another company)', model: page('warehouse', { shipment: { status: 'not_found' } }) },
    { id: 'no-permission', label: 'No permission (shipping.view)', model: page('warehouse', { allowed: false }) },
    { id: 'error', label: 'The read failed: Try again', model: page('warehouse', { shipment: { status: 'error', problem: 'problem.read.unavailable' } }) },
  ],
})
