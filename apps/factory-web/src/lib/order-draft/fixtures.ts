import { createElement } from 'react'
import { defineDesignScreen } from '../design/design-screen'
import { WithMessages } from '../../record-panels/i18n'
import { describedLine, kindsRecord, mtmLine, TODAY } from '../../portal/customer/neworder/design-data'
import { draftViewOf, headerDraftOf } from './model'
import type { DraftRecord } from './schema'
import { DRAFT_NS, type DraftDoor } from './words'
import { DraftPage, type DraftPageModel } from './view/DraftPage'

/**
 * SCR-185-od › the ONE draft order's shared part (THE SIMPLE ORDER START, od-tw t.3): the SAME page in both doors — the mail, the
 * products table, Date and delivery, Still open — without any host card or frame (each host adds its own). Shown in the customer's
 * voice and in the office's, with a row in each state ("Not decided yet" an answer), before the first save (the start) and with an
 * empty row "Add a product" drew. No price anywhere (the view is price-free). Made-up data.
 */

interface SharedCase {
  door: DraftDoor
  model: DraftPageModel
}

const suit = mtmLine({ seq: 2, description: 'Custom race suit for the team', colourText: 'Black and white, as the sketch', choices: [{ topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: null }, { topic: 'Protection class', options: ['AA', 'AAA'], picked: 'AAA' }] })
const gloves = describedLine({ seq: 3, description: 'Team gloves', colourText: null, quantity: null, pieces: 0 })

function recordOf(): DraftRecord {
  return kindsRecord({
    custom: [suit, gloves],
    request: {
      subject: 'Race team kit for 2027',
      designStarted: true,
      savedBy: { who: 'FACTORY', name: null },
      stillOpen: {
        openCount: 4,
        confirmHeld: true,
        items: [
          { kind: 'CHOICE', lineId: suit.id, seq: suit.seq, topic: 'Leather', state: 'NOT_DECIDED', confirmNeeds: false },
          { kind: 'SIZING', lineId: gloves.id, seq: gloves.seq, topic: null, state: 'NOT_DECIDED', confirmNeeds: false },
          { kind: 'COLOUR', lineId: gloves.id, seq: gloves.seq, topic: null, state: 'NOT_DECIDED', confirmNeeds: true },
          { kind: 'PIECES', lineId: gloves.id, seq: gloves.seq, topic: null, state: 'NOT_DECIDED', confirmNeeds: true },
        ],
      },
    },
  })
}

function caseOf(door: DraftDoor, over: Partial<DraftPageModel> = {}): SharedCase {
  const record = over.draft === null ? null : recordOf()
  return {
    door,
    model: {
      draft: record ? draftViewOf(record) : null,
      today: TODAY,
      header: headerDraftOf(record?.request ?? null),
      headerErrors: {},
      save: { kind: 'idle' },
      writeHeld: null,
      addAddressHeld: null,
      problem: null,
      stale: false,
      notice: null,
      offlineSince: null,
      pending: false,
      styles: [{ id: '0194f0e2-1940-7000-8000-000000000001', code: 'JKT-100', name: 'Giacca Corsa Esempio' }],
      saving: [],
      uploads: [],
      keys: [],
      ...over,
    },
  }
}

function SharedDraftCase({ model }: { model: SharedCase }) {
  return createElement(WithMessages, { namespaces: [DRAFT_NS, 'ds-words'] }, createElement(DraftPage, { kind: model.door, model: model.model }))
}

export const designScreen = defineDesignScreen<SharedCase>({
  screen: 'SCR-185-od',
  title: 'The draft order — the shared part (both doors)',
  view: SharedDraftCase,
  cases: [
    { id: 'portal', label: 'In the customer’s voice: "the factory" saved it; the factory is working on the design', model: caseOf('portal') },
    { id: 'office', label: 'In the office’s voice: "The customer’s message", Confirm asks it', model: caseOf('office') },
    { id: 'start-portal', label: 'Before the first save: the mail, nothing required, "Saves when you type"', model: caseOf('portal', { draft: null }) },
    { id: 'start-office', label: 'The office before the first save (the host puts the customer above it)', model: caseOf('office', { draft: null }) },
    { id: 'add-product', label: 'An empty row "Add a product" drew: saved on its first input', model: caseOf('portal', { pending: true }) },
    { id: 'stale', label: 'Changed elsewhere: by the factory (portal), never a worker’s name', model: caseOf('portal', { stale: true, staleBy: { who: 'FACTORY', name: null } }) },
  ],
})
