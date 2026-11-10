import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CAN, recordModel, REV, STYLE_ID } from '../demo/fixtures'
import { tabsFor } from '../model'
import type { StyleRecordViewModel } from '../record/record-model'
import { StyleRecordView } from '../record/view/StyleRecordView'
import { demoTechPack, NOT_ALLOWED_VIEWER, PARTIES, VERSIONS } from './demo/fixtures'
import { allowedSections, failed, ready, reading, techPackCan, type MakeDraft, type TechPackSection } from './model'
import type { MakeDialogModel } from './view/MakePdfDialog'
import { TechPackTabView, type TechPackTabModel } from './view/TechPackTabView'

/**
 * SCR-305 — Style › Tech pack (B-W2b-243; design products.styles rec:Style tab style.techpack, pop:styles.techpackPdf), inside
 * the Style studio, made-up data only (demo/fixtures.ts: DEMO-JKT-01 revision 3 in draft). The audience switch is the preview:
 * each copy is made by factory-domain's own rule, so what a workshop or a customer never gets is absent as the API leaves it
 * out. Make tech pack PDF with every audience, the private-label brand copy, held and refused; the versions; every state.
 */

interface Case {
  studio: StyleRecordViewModel
  tab: TechPackTabModel
}

const OWNER = ['product.bom.view', 'product.techpacks.make', 'product.routing.view', 'compliance.certificates.view', 'money.cost', 'parties.view']
const PRODUCTION = ['product.bom.view', 'product.techpacks.make', 'product.routing.view', 'compliance.certificates.view']
const VIEWER = ['product.bom.view']

const studio = (overrides: Partial<StyleRecordViewModel> = {}) => recordModel('owner', { tab: 'techpack', ...overrides })

function tab(permissions: readonly string[], overrides: Partial<TechPackTabModel> = {}): TechPackTabModel {
  const can = techPackCan(permissions)
  return {
    prefix: '/w/DEMO',
    styleId: STYLE_ID,
    styleCode: 'DEMO-JKT-01',
    revision: { id: REV.r3, revision: 3, status: 'DRAFT' },
    can,
    tabs: tabsFor(CAN.owner),
    audience: 'INTERNAL',
    language: 'it',
    sections: allowedSections(can),
    view: ready(demoTechPack({ cost: can.cost })),
    versions: ready(VERSIONS),
    online: true,
    make: null,
    notice: null,
    ...overrides,
  }
}

function make(draft: Partial<MakeDraft>, overrides: Partial<MakeDialogModel> = {}, allowed: readonly TechPackSection[] = allowedSections(techPackCan(OWNER))): MakeDialogModel {
  const audience = draft.audience ?? 'INTERNAL'
  return {
    styleCode: 'DEMO-JKT-01',
    revision: { revision: 3, status: 'DRAFT' },
    draft: { audience, language: 'it', sections: [...allowed], partyId: null, ...draft },
    allowed,
    parties: audience === 'INTERNAL' ? null : ready(PARTIES[audience]),
    privateLabel: null,
    busy: false,
    problem: null,
    opensHere: false,
    ...overrides,
  }
}

const View = ({ model }: { model: Case }) => createElement(StyleRecordView, { model: model.studio, techPack: createElement(TechPackTabView, { model: model.tab }) })

const owner = tab(OWNER)
const workshop = tab(OWNER, { audience: 'SUBCONTRACTOR', view: ready(demoTechPack({ audience: 'SUBCONTRACTOR' })) })

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-305',
  title: 'Style › Tech pack',
  view: View,
  cases: [
    { id: 'internal', label: 'Internal copy (owner, cost grain)', model: { studio: studio(), tab: owner }, note: 'Every section; a BOM line shows its cost on screen only. Contents beside the sections, each linking to where its data lives; the PDF versions open in a new tab.' },
    { id: 'production', label: 'Production manager (no cost grain)', model: { studio: recordModel('production', { tab: 'techpack' }), tab: tab(PRODUCTION, { view: ready(demoTechPack({ cost: false })) }) }, note: 'The same copy without a cost column: the API sends none.' },
    { id: 'subcontractor', label: 'Workshop copy (the preview)', model: { studio: studio(), tab: workshop }, note: 'No cost, minutes, supplier or workshop names, alternates, approval states or people: absent from the answer, said in one line. The kit mark stays.' },
    { id: 'customer', label: 'Customer copy', model: { studio: studio(), tab: tab(OWNER, { audience: 'BRAND', view: ready(demoTechPack({ audience: 'BRAND' })) }) }, note: 'As the workshop copy, and no internal notes and no kit mark.' },
    { id: 'english', label: 'English copy on an Italian page', model: { studio: studio(), tab: tab(OWNER, { language: 'en', view: ready(demoTechPack({ language: 'en' })) }) }, note: 'The copy\'s own texts come as typed; the page says the PDF prints them so.' },
    { id: 'some-sections', label: 'Some sections left out', model: { studio: studio(), tab: tab(OWNER, { sections: ['COVER', 'BOM', 'PROTECTION'] }) } },
    { id: 'released', label: 'Revision 2 (released)', model: { studio: studio({ revisionId: REV.r2 }), tab: tab(OWNER, { revision: { id: REV.r2, revision: 2, status: 'RELEASED' }, view: ready(demoTechPack({ revision: 'released' })), versions: ready([]) }) }, note: 'No banner; the release takes NERO and ANTR only. No PDF yet.' },
    { id: 'obsolete', label: 'Revision 1 (obsolete)', model: { studio: studio({ revisionId: REV.r1 }), tab: tab(OWNER, { revision: { id: REV.r1, revision: 1, status: 'OBSOLETE' }, view: ready(demoTechPack({ revision: 'obsolete' })) }) }, note: 'The banner says revision 2 is in force and goes there.' },
    { id: 'viewer', label: 'A role without routing and certificates', model: { studio: recordModel('owner', { tab: 'techpack', can: { ...CAN.viewer, complianceView: false, routingView: false } }), tab: tab(VIEWER, { view: ready(demoTechPack({ cost: false, notAllowed: NOT_ALLOWED_VIEWER })), tabs: tabsFor({ ...CAN.viewer, complianceView: false, routingView: false }) }) }, note: 'Construction, protection and compliance are held in Contents with why; Make tech pack PDF is held: the production manager or the buyer makes it.' },
    { id: 'make-internal', label: 'Make tech pack PDF: internal', model: { studio: studio(), tab: tab(OWNER, { make: make({}) }) }, note: 'Make PDF opens the version in a new tab (opened on the press).' },
    { id: 'make-workshop', label: 'Make tech pack PDF: workshop copy for a workshop', model: { studio: studio(), tab: { ...workshop, make: make({ audience: 'SUBCONTRACTOR', partyId: PARTIES.SUBCONTRACTOR[0]!.id }) } } },
    { id: 'make-private-label', label: 'Make tech pack PDF: a private-label customer copy', model: { studio: studio(), tab: tab(OWNER, { audience: 'BRAND', view: ready(demoTechPack({ audience: 'BRAND', privateLabel: true })), make: make({ audience: 'BRAND', partyId: PARTIES.BRAND[0]!.id }, { privateLabel: { id: PARTIES.BRAND[0]!.id, code: PARTIES.BRAND[0]!.code, name: PARTIES.BRAND[0]!.tradeName ?? PARTIES.BRAND[0]!.legalName } }) }) }, note: 'Only its brand is offered.' },
    { id: 'make-held', label: 'Make tech pack PDF: no section ticked', model: { studio: studio(), tab: tab(OWNER, { make: make({ sections: [] }) }) }, note: 'Make PDF held with the reason.' },
    { id: 'make-refused', label: 'Make tech pack PDF: refused', model: { studio: studio(), tab: tab(OWNER, { make: make({ audience: 'BRAND', partyId: PARTIES.BRAND[1]!.id }, { problem: 'techpack.problem.make.party' }) }) }, note: 'The API\'s refusal in our words; nothing was made.' },
    { id: 'make-busy', label: 'Make tech pack PDF: being made', model: { studio: studio(), tab: tab(OWNER, { make: make({}, { busy: true }) }) } },
    { id: 'made', label: 'A version made', model: { studio: studio(), tab: tab(OWNER, { notice: { key: 'techpack.notice.made', params: { version: 4, code: 'TP 0VCTY-7BFRV' }, tone: 'success', versionId: VERSIONS[0]!.id } }) } },
    { id: 'same', label: 'Nothing changed since the newest', model: { studio: studio(), tab: tab(OWNER, { notice: { key: 'techpack.notice.same', params: { version: 3, code: 'TP 0VCTY-7BFRV' }, tone: 'info', versionId: VERSIONS[0]!.id } }) } },
    { id: 'offline', label: 'Offline', model: { studio: studio(), tab: tab(OWNER, { online: false }) }, note: 'Readable; Make tech pack PDF held with the reason.' },
    { id: 'loading', label: 'Loading', model: { studio: studio(), tab: tab(OWNER, { view: reading(), versions: reading() }) } },
    { id: 'error', label: 'Error', model: { studio: studio(), tab: tab(OWNER, { view: failed('techpack.problem.read.unavailable'), versions: failed('techpack.problem.read.unavailable') }) } },
  ],
})
