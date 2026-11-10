import { defineDesignScreen } from '../../../lib/design/design-screen'
import { designScreen as publicDoc } from '../fixtures'
import type { PublicDocViewModel } from '../model'
import { PublicDocView } from '../view/PublicDocView'
import type { PublicSafetyNotice } from './model'

/**
 * SCR-102-notice (B-W2b-271; links.doc › sec:recall) — the public DoC page with a recall's or withdrawal's safety notice
 * FIRST: the batch called back whole, some garments by serial, a style's page listing the batches to check, every garment
 * of the model, two notices (newest first), words only in another language, and no notice (nothing drawn). Made-up data
 * only: SCR-102's own pages with made-up notices.
 */

const caseOf = (id: string): PublicDocViewModel => publicDoc.cases.find((entry) => entry.id === id)!.model

const WORDS = {
  it: { title: 'Richiamo della giacca DEMO, lotto L-2231', problem: 'L’etichetta indica una classe di protezione più alta di quella reale (dati inventati).', action: 'Smetti di usare la giacca e riportala al negozio: la sostituiamo gratis.', contact: 'Servizio clienti Demo, +39 000 000 0000, sicurezza@example.com' },
  en: { title: 'Recall of the DEMO jacket, batch L-2231', problem: 'The label names a higher protection class than the garment has (made-up).', action: 'Stop using the jacket and bring it back to the shop: we replace it free of charge.', contact: 'Demo customer service, +39 000 000 0000, safety@example.com' },
}

const notice = (over: Partial<PublicSafetyNotice>): PublicSafetyNotice => ({ kind: 'RECALL', number: 'RCL-DEMO-2026-0002', publishedOn: '2026-10-28', reach: 'BATCH', batches: [], bySerial: false, words: WORDS, ...over })

function withNotices(model: PublicDocViewModel, notices: PublicSafetyNotice[]): PublicDocViewModel {
  if (!model.page) return model
  return { ...model, page: { ...model.page, notices } }
}

export const designScreen = defineDesignScreen<PublicDocViewModel>({
  screen: 'SCR-102-notice',
  title: 'Public DoC: the safety notice first (recall or withdrawal)',
  view: PublicDocView,
  cases: [
    { id: 'batch', label: 'A batch called back whole: the notice before everything', model: withNotices(caseOf('batch-current'), [notice({ batches: ['L-2231'] })]), note: 'Danger banner: what is wrong, what to do, whom to contact; the number to quote.' },
    { id: 'by-serial', label: 'Some garments of the batch, by serial: check the serial on your label', model: withNotices(caseOf('batch-current'), [notice({ reach: 'PART', bySerial: true })]) },
    { id: 'style-page', label: 'A style’s page: the batches to check on the label', model: withNotices(caseOf('style-current'), [notice({ batches: ['L-2231', 'L-2232'] })]) },
    { id: 'whole-style', label: 'Every garment of the model (a withdrawal)', model: withNotices(caseOf('batch-current'), [notice({ kind: 'WITHDRAWAL', number: 'RCL-DEMO-2026-0005', reach: 'STYLE' })]) },
    {
      id: 'two-notices',
      label: 'Two notices on one batch, newest first',
      model: withNotices(caseOf('batch-current'), [notice({ kind: 'WITHDRAWAL', number: 'RCL-DEMO-2026-0006', publishedOn: '2026-10-29', reach: 'STYLE' }), notice({ batches: ['L-2231'] })]),
    },
    {
      id: 'other-language',
      label: 'A German reader, the notice written in Italian and English only: the English words, said so',
      model: withNotices(caseOf('language-german'), [notice({ batches: ['L-2231'] })]),
    },
    { id: 'none', label: 'No notice: the section is not drawn', model: withNotices(caseOf('batch-current'), []) },
  ],
})
