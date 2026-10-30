import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, NOW, OPEN_QUEUE } from '../../_shared/fixtures'
import { RequestsPrintView, type RequestsPrintModel } from './view/RequestsPrintView'

/**
 * SCR-148-print — the open machine requests on paper (Plant › Machine requests › Print, a new tab), made-up data only:
 * the queue of one site, all sites, nothing open, still reading and a failed read.
 */

const model = (over: Partial<RequestsPrintModel> = {}): RequestsPrintModel => ({ person: 'Alex Demo', site: 'STAB-N · Stabilimento Demo Nord', at: NOW, requests: { value: OPEN_QUEUE, problem: null }, ...over })

function PrintDesign({ model }: { model: RequestsPrintModel }) {
  return inShell('/plant/requests/print', createElement(RequestsPrintView, { model }))
}

export const designScreen = defineDesignScreen<RequestsPrintModel>({
  screen: 'SCR-148-print',
  title: 'Open machine requests (print for the shift)',
  view: PrintDesign,
  cases: [
    { id: 'site', label: 'One site: the open requests, unsafe first', model: model(), note: 'The browser prints it or saves it as a PDF; the Office frame is hidden on paper.' },
    { id: 'all-sites', label: 'All sites', model: model({ site: null }) },
    { id: 'none', label: 'Nothing open', model: model({ requests: { value: [], problem: null } }) },
    { id: 'loading', label: 'Still reading', model: model({ requests: { value: null, problem: null } }) },
    { id: 'error', label: "The requests couldn't be read", model: model({ requests: { value: null, problem: 'problem.unavailable' } }) },
  ],
})
