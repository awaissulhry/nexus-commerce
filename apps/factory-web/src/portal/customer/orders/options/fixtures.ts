import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { PortalOptions } from './api'
import { OptionsSection, type OptionsSectionModel } from './view/OptionsSection'

/**
 * SCR-434 — the options and artwork of the customer's order in the portal (B-W2b-374; XF3:04; Order › Lines), made-up data
 * only: a demo brand's order of the demo touring jacket with a liner, front perforation in fluo yellow and a name, and the
 * logo it sent, shown by the office.
 */

const w = (it: string, en: string) => ({ it, en })
const READ: PortalOptions = {
  orderId: '88888888-0000-4000-8000-000000000434',
  lines: [
    {
      lineId: '99999999-0000-4000-8000-000000000010',
      seq: 10,
      options: [
        w('Imbottitura termica: Imbottitura removibile', 'Thermal liner: Removable thermal liner'),
        w('Foratura: Pannelli anteriori forati (Giallo fluo demo (DEMO-FLUO))', 'Perforation: Front panels perforated (Demo fluo yellow (DEMO-FLUO))'),
        w('Nome sul petto: Nome ricamato «BIANCHI»', 'Name on the chest: Embroidered name «BIANCHI»'),
      ],
      artwork: [
        { fileId: 'aaaaaaaa-0000-4000-8000-000000000434', name: 'demo-brand-logo.pdf', contentType: 'application/pdf', sizeBytes: 182_400, picture: false },
        { fileId: 'aaaaaaaa-0000-4000-8000-000000000435', name: 'demo-back-print.png', contentType: 'image/png', sizeBytes: 640_000, picture: true },
      ],
    },
    { lineId: '99999999-0000-4000-8000-000000000020', seq: 20, options: [w('Protezioni spalle: Protezioni standard', 'Shoulder protectors: Standard protectors')], artwork: [] },
  ],
}

const model = (extra: Partial<OptionsSectionModel> = {}): OptionsSectionModel => ({ read: { status: 'ready', value: READ }, fileHeld: null, problem: null, opening: null, ...extra })

export const designScreen = defineDesignScreen<OptionsSectionModel>({
  screen: 'SCR-434',
  title: 'The portal: the options and artwork of the customer\'s order lines (opened and downloaded, logged)',
  view: OptionsSection,
  cases: [
    { id: 'lines', label: 'Two lines: options in words, artwork the office shows', model: model(), note: 'Order › Lines, after the size runs.' },
    { id: 'opening', label: 'A file being opened', model: model({ opening: READ.lines[0]!.artwork[0]!.fileId }) },
    { id: 'open-failed', label: 'A file could not be opened', model: model({ problem: { key: 'portal.openProblem' } }) },
    { id: 'office-preview', label: 'An office preview of the portal: opening is held with why', model: model({ fileHeld: { key: 'portal.preview' } }) },
    { id: 'empty', label: 'No line has options or artwork', model: model({ read: { status: 'ready', value: { ...READ, lines: [] } } }) },
    { id: 'loading', label: 'Loading', model: model({ read: { status: 'loading' } }) },
    { id: 'error', label: 'Could not be read', model: model({ read: { status: 'error' } }) },
  ],
})
