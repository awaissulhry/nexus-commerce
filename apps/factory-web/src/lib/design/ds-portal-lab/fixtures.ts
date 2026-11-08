import { defineDesignScreen } from '../design-screen'
import { DsPortalLab, type DsPortalLabModel } from './view/DsPortalLab'

/**
 * The portal and link parts lab (`/design/ds-portal-parts`, B-W2b-155): EndState, CodeInput, RefPair, MilestoneTracker,
 * ActionList, LineResponseList with the portal action bar, PartnerThread, PaymentPanel, the stacked size grid, the
 * Modal's phone sheet and branding for pop-ups (D24) — at the portal's comfortable density, in the gallery's language
 * through `useDsLabels()`. Light and dark, 1440 and 390, Italian and English are the gallery's own switches. Made-up data.
 */
export const designScreen = defineDesignScreen<DsPortalLabModel>({
  screen: 'ds-portal-parts',
  title: 'Portal and link DS parts (B-W2b-155)',
  view: DsPortalLab,
  cases: [
    { id: 'parts', label: 'Every part', model: {}, note: 'Every part working: type the demo code 135790, ask for a new link, confirm and undo, sign in the sheet, answer the PO lines, post a message, pay with the test provider, step the sizes, open the pop-up.' },
    { id: 'branded', label: 'Every part, branded', model: { brand: true }, note: 'Inside a branded subtree, with the brand on <body>: the main actions and every pop-up take the brand colour, light and dark.' },
    { id: 'end-accepted', label: 'End: accepted', model: { show: 'end', end: 'accepted' }, note: 'What happened, what happens next, the receipt, the reference, your copy, whom to contact.' },
    { id: 'end-dead', label: 'End: a link that no longer opens', model: { show: 'end', end: 'dead' }, note: 'Ask for a new link: pressed once, held with “Asked — we passed it on”.' },
    { id: 'end-error', label: 'End: our error', model: { show: 'end', end: 'error' } },
    { id: 'code-wrong', label: 'Code: wrong, 1 try left', model: { show: 'code', code: 'wrong' } },
    { id: 'code-locked', label: 'Code: locked', model: { show: 'code', code: 'locked' }, note: 'Held with the reason on screen; a new code unlocks it.' },
    { id: 'actions-empty', label: 'Nothing waits', model: { show: 'actions', actions: 'empty' } },
    { id: 'lines-answered', label: 'PO answered', model: { show: 'lines', lines: 'answered' }, note: 'Read-only: a later date with its reason, a line that cannot be delivered.' },
    { id: 'thread-readonly', label: 'Conversation: read only', model: { show: 'thread', thread: 'readonly' }, note: 'The reason instead of the box; the e-mail line stays.' },
    { id: 'thread-error', label: 'Conversation: could not be read', model: { show: 'thread', thread: 'error' } },
    { id: 'pay-waiting', label: 'Pay: waiting for the bank', model: { show: 'pay', pay: 'waiting' } },
    { id: 'pay-failed', label: 'Pay: declined', model: { show: 'pay', pay: 'failed' } },
    { id: 'pay-held', label: 'Pay: held', model: { show: 'pay', pay: 'held' } },
    { id: 'sheet-open', label: 'Pop-up: phone sheet', model: { show: 'popups', sheet: true }, note: 'Under 720 px a bottom sheet with a grab handle; from 720 px the usual dialog.' },
    { id: 'sheet-branded', label: 'Pop-up: branded', model: { show: 'popups', sheet: true, brand: true }, note: 'The pop-up renders into <body> and still takes the brand (D24).' },
    { id: 'phone-bar', label: 'Action bar: held, above the bottom bar', model: { show: 'bar', bar: 'held' }, note: 'Under 720 px: the bar above the BottomBar, held with its reason.' },
  ],
})
