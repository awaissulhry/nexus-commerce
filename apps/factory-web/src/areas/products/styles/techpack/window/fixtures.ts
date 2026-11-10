import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { permissionCheck } from '../../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, demoPdf } from '../../../../../shell/design-data'
import { isWindowPage, officeNavFor } from '../../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../../shell/office/view/OfficeShellView'
import { REV, REVISIONS, STYLE_ID } from '../../demo/fixtures'
import { demoScan, PARTIES, VERSIONS } from '../demo/fixtures'
import { allowedSections, failed, ready, reading, techPackCan, WINDOW_PATH } from '../model'
import { TechPackWindowView, type TechPackWindowModel } from './view/TechPackWindowView'

/**
 * SCR-306 — Tech pack PDF (B-W2b-243; design products.styles tab:styles.techpack, a window page), made-up data only: a stored
 * version of DEMO-JKT-01 revision 3 in the PdfViewer (a stand-in PDF: the API paints the real one), its versions, Make new
 * version in place; and the landing of a scanned QR (`/tech-pack/<code>`): current, a draft, a newer version, a newer
 * revision, obsolete, an unknown code (type it again). Every state.
 */

const PERMISSIONS = {
  production: [...(templateOf('production_manager')?.permissions ?? [])],
  viewer: ['product.styles.view', 'product.bom.view'],
  none: ['product.styles.view'],
}

function inWindow(page: ReactNode, permissions: readonly string[]): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...permissions])),
    path: WINDOW_PATH,
    ...(isWindowPage(WINDOW_PATH) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: WINDOW_PATH },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

interface Case {
  role: keyof typeof PERMISSIONS
  model: TechPackWindowModel
}

const STYLE = { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', revisions: REVISIONS }
const pdf = demoPdf(['DEMO-JKT-01 - Giacca Touring Demo', 'Scheda tecnica - revisione 3 (bozza) - versione 3', 'Copia per il terzista - TP 00000-00003', '1. Copertina   2. Distinta base   3. Costruzione', 'Nessun costo: la carta viaggia.'])

function windowCase(role: keyof typeof PERMISSIONS, overrides: Partial<TechPackWindowModel> = {}): Case {
  const can = techPackCan(PERMISSIONS[role])
  return {
    role,
    model: {
      can,
      online: true,
      scanCode: null,
      scan: null,
      style: ready(STYLE),
      revisionId: REV.r3,
      versions: ready(VERSIONS),
      versionId: VERSIONS[0]!.id,
      pdf: ready(pdf),
      make: null,
      notice: null,
      ...overrides,
    },
  }
}

const scanned = (state: Parameters<typeof demoScan>[0], overrides: Partial<TechPackWindowModel> = {}): Case => {
  const scan = demoScan(state)
  const version = VERSIONS.find((entry) => entry.version === scan.printed.version) ?? VERSIONS[2]!
  return windowCase('production', { scanCode: scan.code, scan: ready(scan), revisionId: scan.printed.revisionId, versionId: scan.printed.revisionId === REV.r3 ? version.id : null, versions: ready(scan.printed.revisionId === REV.r3 ? VERSIONS : []), pdf: scan.printed.revisionId === REV.r3 ? ready(pdf) : null, ...overrides })
}

const allowed = allowedSections(techPackCan(PERMISSIONS.production))

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-306',
  title: 'Tech pack PDF (window and scanned QR)',
  view: ({ model }: { model: Case }) => inWindow(createElement(TechPackWindowView, { model: model.model }), PERMISSIONS[model.role]),
  cases: [
    { id: 'workshop', label: 'v3 workshop copy (production manager)', model: windowCase('production'), note: 'Revision and version pickers, Make new version, Print; the draft banner; who made it and the code under its QR.' },
    { id: 'customer', label: 'v2 customer copy in English', model: windowCase('production', { versionId: VERSIONS[1]!.id }) },
    { id: 'reader', label: 'A reader without Make', model: windowCase('viewer'), note: 'Make new version held: the production manager or the buyer makes it.' },
    { id: 'make', label: 'Make new version (here)', model: windowCase('production', { make: { styleCode: 'DEMO-JKT-01', revision: { revision: 3, status: 'DRAFT' }, draft: { audience: 'SUBCONTRACTOR', language: 'it', sections: [...allowed], partyId: PARTIES.SUBCONTRACTOR[0]!.id }, allowed, parties: ready(PARTIES.SUBCONTRACTOR), privateLabel: null, busy: false, problem: null, opensHere: true } }) },
    { id: 'made', label: 'Version made', model: windowCase('production', { notice: { key: 'techpack.notice.same', params: { version: 3, code: 'TP 0VCTY-7BFRV' }, tone: 'info' } }) },
    { id: 'none', label: 'No PDF of the revision yet', model: windowCase('production', { revisionId: REV.r2, versions: ready([]), versionId: null, pdf: null }) },
    { id: 'none-reader', label: 'No PDF yet, a reader', model: windowCase('viewer', { revisionId: REV.r2, versions: ready([]), versionId: null, pdf: null }) },
    { id: 'scan-current', label: 'Scanned: current', model: scanned('CURRENT', { versionId: VERSIONS[0]!.id }) },
    { id: 'scan-draft', label: 'Scanned: the newest, of a draft', model: scanned('DRAFT', { versionId: VERSIONS[0]!.id }) },
    { id: 'scan-newer-version', label: 'Scanned: a newer version exists', model: scanned('NEWER_VERSION', { versionId: VERSIONS[2]!.id }), note: 'The page scanned shows, with "do not work from it" and Open version 3.' },
    { id: 'scan-newer-revision', label: 'Scanned: a newer revision is in force', model: scanned('NEWER_REVISION', { revisionId: REV.r1, versions: ready([]), versionId: null, pdf: null }), note: 'The scanned revision\'s PDF is shown when kept; Open revision 3\'s newest copy.' },
    { id: 'scan-obsolete', label: 'Scanned: obsolete', model: scanned('OBSOLETE', { revisionId: REV.r1, versions: ready([]), versionId: null, pdf: null }) },
    { id: 'scan-unknown', label: 'Scanned: no page has this code', model: windowCase('production', { scanCode: 'TP 7K3QM-2XA9B', scan: failed('techpack.problem.read.not_found'), style: null, revisionId: null, versions: null, versionId: null, pdf: null }), note: 'Type the code under the QR again.' },
    { id: 'scan-reading', label: 'Scanned: checking', model: windowCase('production', { scanCode: 'TP 7K3QM-2XA9B', scan: reading(), style: null, revisionId: null, versions: null, versionId: null, pdf: null }) },
    { id: 'opening', label: 'Opening the PDF', model: windowCase('production', { pdf: reading() }) },
    { id: 'pdf-error', label: 'The PDF could not be read', model: windowCase('production', { pdf: failed('techpack.problem.read.unavailable') }) },
    { id: 'error', label: 'The style could not be read', model: windowCase('production', { style: failed('techpack.problem.read.not_found'), versions: null, pdf: null }) },
    { id: 'no-permission', label: 'No access', model: windowCase('none') },
  ],
})
