import { defineDesignScreen } from '../../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { DEMO_NOW, OFFICE_PEOPLE } from '../demo-data'
import type { ComposerContext } from './model'
import { ComposerCase, type ComposerCaseModel } from './view/ComposerCase'

/**
 * SCR-006-composer — the composer's audience switch (B-TH-205, T5; picture 3, approved 2026-11-17). Made-up data (the brand-wall
 * helpers' brands, the design kit's people). Each case is a state of the picture: it starts on Office note; typing; the reply in
 * blue (switch back and forth: the text stays; @mentions are taken out of a mail and named); a closed thread; no right to write;
 * a prospect; offline; a work order (For the floor); leaving with unsent text; Brand Beta's copy (the brand wall).
 */

const SALES_ORDER: ComposerContext = {
  recordType: 'SalesOrder',
  recordLabel: BRAND_ALPHA.numbers.order,
  party: { name: BRAND_ALPHA.tradeName },
  can: { post: true, email: true, manage: true },
  people: OFFICE_PEOPLE,
}

const TYPED = 'Cutting confirmed for Thursday 19 Nov.\nThe label move is fine: no cost, no new date.\nSample photos went to the customer this morning.\nOpen point: the hang tags arrive by courier on Monday.\n@Bea Esempio please tell the warehouse.'
const base: ComposerCaseModel = { context: SALES_ORDER, draft: { mode: 'note', body: '', forFloor: false }, now: DEMO_NOW }

export const designScreen = defineDesignScreen<ComposerCaseModel>({
  screen: 'SCR-006-composer',
  title: 'Record thread · the composer’s audience switch (T5)',
  view: ComposerCase,
  cases: [
    { id: 'start', label: 'Starts on Office note', model: base, note: 'Every visit starts on Office note (yellow box, lock, “Add note”). One click or R: Reply to Brand Alpha.' },
    { id: 'typing', label: 'Typing', model: { ...base, draft: { ...base.draft, body: TYPED } }, note: 'The box grows to about 40 % of the column, then scrolls inside. Switch to the reply: the text stays and the @mention is taken out and named.' },
    { id: 'reply', label: 'Reply to the customer', model: { ...base, draft: { mode: 'reply', body: 'Hello Alma,\nthe photos follow this afternoon.\nAlex', forFloor: false } }, note: 'The whole box in blue; Send names the audience: “Send to Brand Alpha”. To / Cc come with the send check (B-TH-207).' },
    {
      id: 'switched',
      label: 'After a switch to the reply',
      model: { ...base, draft: { mode: 'reply', body: 'please tell the warehouse.', forFloor: false }, notes: [{ key: 'switch.mentions', params: { names: '@Bea Esempio' } }] },
      note: 'Mentions stay in Office notes: taken out of the mail and named.',
    },
    { id: 'closed', label: 'Closed thread', model: { ...base, context: { ...SALES_ORDER, closed: { by: 'Bea Esempio', at: '2026-11-12T15:00:00.000Z' } } }, note: 'The box is replaced: nobody types into a closed thread. Reopen for those who manage threads.' },
    { id: 'no-right', label: 'No right to write', model: { ...base, context: { ...SALES_ORDER, can: { post: false, email: false, manage: false } } } },
    {
      id: 'prospect',
      label: 'Prospect',
      model: { ...base, context: { ...SALES_ORDER, recordType: 'Inquiry', recordLabel: 'INQ-2026-0007', party: null, prospect: { name: 'Nova Esempio' } }, draft: { mode: 'reply', body: 'Hello, thank you for your request.', forFloor: false } },
      note: 'A request from someone who is not a customer yet: “Make the customer first”.',
    },
    { id: 'offline', label: 'Offline', model: { ...base, context: { ...SALES_ORDER, offline: true }, draft: { ...base.draft, body: 'Cutting confirmed for Thursday.' } }, note: 'Send waits: “You are offline · your text stays on this device”.' },
    {
      id: 'work-order',
      label: 'Work order: For the floor',
      model: { ...base, context: { ...SALES_ORDER, recordType: 'WorkOrder', recordLabel: 'WO-2026-0311', party: null }, draft: { mode: 'note', body: 'Use the grey mesh for the collar lining, as on the sample.', forFloor: true } },
      note: 'A work order has no customer: notes only. The tick is off by default; on, the line says what the tablets show.',
    },
    { id: 'leave', label: 'Leave with unsent text', model: { ...base, draft: { ...base.draft, body: 'Cutting confirmed for Thursday 19 Nov.' }, leaving: true }, note: 'Stay / Discard: Discard is never the default.' },
    { id: 'brand-beta', label: 'Brand Beta’s copy (brand wall)', model: { ...base, context: { ...SALES_ORDER, recordLabel: BRAND_BETA.numbers.order, party: { name: BRAND_BETA.tradeName } }, draft: { mode: 'reply', body: '', forFloor: false } }, note: '“Reply to Brand Beta”: the reply names only this record’s customer.' },
  ],
})
