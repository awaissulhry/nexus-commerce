import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { demoPdf } from '../../../../shell/design-data'
import { inShell, RECORD, VERSIONS } from '../demo/fixtures'
import { failed, ready, reading } from '../model'
import { SheetView, type SheetModel } from './view/SheetView'

/**
 * SCR-285-pdf — Instruction sheet PDF (design production.instructions tab:wi-tab-pdf, a new tab), made-up data only: the
 * version in force in Italian (a stand-in PDF: the API renders the real one), English, the draft (its banner), making the
 * sheet, the company's legal data missing, no version yet, no access.
 */

const pdf = demoPdf(['WI-2026-0007 · v2', 'DEMO-CUC-SPALLA Cucitura spalla · tutti gli articoli', '1. ALIGN_PANELS  Allinea davanti e dietro sulle tacche', '2. SEAM_ALLOWANCE  Cuci a 10 mm dal bordo  [punto critico]', '3. PRESS_OPEN  Apri la cucitura e stira a bassa temperatura', '4. CHECK_SEAM  Controlla la cucitura'])
const base: SheetModel = { allowed: true, record: ready(RECORD), versionId: VERSIONS[1]!.id, language: 'it', pdf: ready(pdf) }

export const designScreen = defineDesignScreen<SheetModel>({
  screen: 'SCR-285-pdf',
  title: 'Work instruction · sheet PDF',
  view: ({ model }: { model: SheetModel }) => inShell('/production/instructions', createElement(SheetView, { model })),
  cases: [
    { id: 'italian', label: 'v2 in force, Italian', model: base, note: 'The paper at the station in the DS PdfViewer; Print prints.' },
    { id: 'english', label: 'English', model: { ...base, language: 'en' } },
    { id: 'draft', label: 'Draft v3', model: { ...base, versionId: VERSIONS[0]!.id }, note: 'The paper carries the draft\'s banner; the floor does not use it.' },
    { id: 'reading', label: 'Making the sheet', model: { ...base, pdf: reading() } },
    { id: 'company-data', label: 'Company legal data missing', model: { ...base, pdf: failed('problem.sheetCompany') }, note: 'The API refuses a sheet without the company\'s legal data: said where to fill it.' },
    { id: 'no-version', label: 'No version yet', model: { ...base, versionId: null, pdf: null } },
    { id: 'no-permission', label: 'No access', model: { ...base, allowed: false } },
  ],
})
