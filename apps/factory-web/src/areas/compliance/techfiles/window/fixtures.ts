import { createElement } from 'react'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { PREFIX } from '../../../quality/_shared/fixtures'
import { BUILDING_PACK, BUILT_PACK, FAILED_PACK, FILES } from '../_demo/fixtures'
import { failed, LOADING, ready } from '../model'
import { PackWindowView, type PackWindowModel } from './view/PackWindowView'

/**
 * SCR-326 — Evidence pack (PDF) (design compliance.techfiles tab:tf-pack-pdf, a new tab) with made-up data only: a built pack
 * of DEMO-JKT-01 for a made-up German authority in the viewer (a stand-in page), still building, failed with why, the PDF that
 * would not open, the pack that could not be read, and a person without the right.
 */

const PDF = samplePdf(['Pacchetto prove EP-DEMO-0001', 'Fascicolo tecnico TF-DEMO-0001 · DEMO-JKT-01 Giacca Demo Touring', 'Indice: 6 documenti con impronta SHA-256', 'Costi, prezzi e retribuzioni non sono mai inclusi.'])
const file = ready({ id: FILES[0]!.id, number: FILES[0]!.number, style: FILES[0]!.style })
const base = (over: Partial<PackWindowModel> = {}): PackWindowModel => ({ prefix: PREFIX, canView: true, pack: ready(BUILT_PACK), file, pdf: ready(PDF), downloading: null, ...over })

export const designScreen = defineDesignScreen<PackWindowModel>({
  screen: 'SCR-326',
  title: 'Evidence pack (PDF)',
  view: ({ model }) => createElement(PackWindowView, { model }),
  cases: [
    { id: 'built', label: 'Built: the PDF in the viewer, Download PDF / ZIP, what the authority sees', model: base() },
    { id: 'opening', label: 'Opening the PDF', model: base({ pdf: LOADING }) },
    { id: 'building', label: 'Still being built', model: base({ pack: ready(BUILDING_PACK), pdf: null }) },
    { id: 'failed', label: 'The build failed: why', model: base({ pack: ready(FAILED_PACK), pdf: null }) },
    { id: 'pdf-error', label: 'The PDF could not be opened: Try again', model: base({ pdf: failed('problem.unavailable') }) },
    { id: 'loading', label: 'Reading the pack', model: base({ pack: LOADING, pdf: null, file: null }) },
    { id: 'error', label: 'The pack could not be read', model: base({ pack: failed('problem.notFound'), pdf: null, file: null }) },
    { id: 'forbidden', label: 'No right to see it', model: base({ canView: false }) },
  ],
})
