import { createElement } from 'react'
import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_SITES, DEMO_USER } from '../../shell/design-data'
import { PrintFrameView, type PrintFrameModel } from '../../shell/print/view/PrintFrameView'
import { designScreen as panels } from '../fixtures'
import type { RecordPanelsViewModel } from '../model'
import { RecordPrintView } from './view/RecordPrintView'

/**
 * SCR-006-print — "Print view of the record" (B-W2b-05, PLT-171; design shell.panels tab:print): any record's print view,
 * a new tab opened from the band's Print. The paper's head (company, site, place, who printed it and when), then the
 * record panels for paper: the thread, the open tasks, the files and the history one after the other, read-only. The
 * record page's own band (number, state, version) prints above them on a real page. Made-up record (SCR-006's cases).
 */

interface RecordPrintCase {
  frame: PrintFrameModel
  panels: RecordPanelsViewModel
}

const panelsCase = (id: string): RecordPanelsViewModel => {
  const found = panels.cases.find((item) => item.id === id)
  if (!found) throw new Error(`SCR-006 has no case ${id}`)
  return found.model
}

const frame: PrintFrameModel = {
  kind: 'record',
  company: { name: DEMO_COMPANIES[0].name, code: DEMO_COMPANIES[0].code },
  site: { kind: 'site', name: DEMO_SITES[0].name },
  place: 'Compliance › Certificates',
  printedBy: DEMO_USER.displayName,
  printedAt: new Date(Date.UTC(2026, 9, 31, 9, 42)).toISOString(),
  backHref: '/w/DEMO/compliance/certificates/0190f0e2-5555-7000-8000-000000000001',
}

function RecordPrintDesign({ model }: { model: RecordPrintCase }) {
  return createElement(PrintFrameView, { model: model.frame }, createElement(RecordPrintView, { model: model.panels }))
}

export const designScreen = defineDesignScreen<RecordPrintCase>({
  screen: 'SCR-006-print',
  title: 'Print view of the record',
  view: RecordPrintDesign,
  cases: [
    {
      id: 'normal',
      label: 'A record with its thread, tasks, files and history',
      model: { frame, panels: panelsCase('followers') },
      note: 'Every panel under its name, nothing to write, upload or follow on paper. Page numbers at the foot of each sheet.',
    },
    {
      id: 'mail',
      label: 'A conversation with the customer',
      model: { frame, panels: panelsCase('email') },
    },
    {
      id: 'empty',
      label: 'A new record: nothing yet',
      model: { frame: { ...frame, site: null }, panels: panelsCase('empty') },
    },
    {
      id: 'loading',
      label: 'Still reading',
      model: { frame, panels: panelsCase('loading') },
      note: 'Print only once every panel has its rows: the panels say they are still reading.',
    },
    {
      id: 'error',
      label: 'A panel could not be read',
      model: { frame, panels: panelsCase('error') },
    },
  ],
})
