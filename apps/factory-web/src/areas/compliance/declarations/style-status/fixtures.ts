import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DocStatusCard, type StyleDocStatusRead } from '../../../products/styles/compliance/doc-status'
import { COVERAGE, JKT, PNT, PREFIX, ROWS } from '../_demo/fixtures'

/**
 * SCR-045-docstatus — Products › Styles › a style › Compliance › "DoC and user information status" (B-W2b-268; design
 * style.cp.label, W2b): the part the Compliance tab mounts with one line. Made-up data only.
 */

interface PartCase {
  read: StyleDocStatusRead
  styleId: string
  styleCode: string
  canGenerate: boolean
}

function PartDesign({ model }: { model: PartCase }) {
  return createElement(DocStatusCard, { read: model.read, prefix: PREFIX, styleId: model.styleId, styleCode: model.styleCode, canGenerate: model.canGenerate })
}

const jacket = { status: 'ready' as const, rows: COVERAGE.rows.filter((row) => row.style.id === JKT.id), documents: ROWS.filter((row) => row.styleId === JKT.id) }

export const designScreen = defineDesignScreen<PartCase>({
  screen: 'SCR-045-docstatus',
  title: 'Style › Compliance: DoC and user information status',
  view: PartDesign,
  part: true,
  cases: [
    { id: 'drafts', label: 'Jacket: drafts, a translation in progress, languages missing', model: { read: jacket, styleId: JKT.id, styleCode: JKT.code, canGenerate: true } },
    { id: 'issued', label: 'Trousers: the Italian DoC issued, the leaflet missing', model: { read: { status: 'ready', rows: COVERAGE.rows.filter((row) => row.style.id === PNT.id), documents: ROWS.filter((row) => row.styleId === PNT.id) }, styleId: PNT.id, styleCode: PNT.code, canGenerate: true } },
    { id: 'none', label: 'No market needs a language yet', model: { read: { status: 'ready', rows: [], documents: [] }, styleId: JKT.id, styleCode: JKT.code, canGenerate: true } },
    { id: 'read-only', label: 'Read-only: no New declaration', model: { read: jacket, styleId: JKT.id, styleCode: JKT.code, canGenerate: false } },
    { id: 'loading', label: 'Loading', model: { read: { status: 'loading' }, styleId: JKT.id, styleCode: JKT.code, canGenerate: true } },
    { id: 'error', label: 'Failed read: Try again', model: { read: { status: 'error', problem: 'problem.unavailable' }, styleId: JKT.id, styleCode: JKT.code, canGenerate: true } },
  ],
})
