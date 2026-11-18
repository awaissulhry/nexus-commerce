import { defineDesignScreen } from '../../../lib/design/design-screen'
import { BRAND_BETA } from '../../../lib/testing/two-brands'
import type { OverrideRequest } from './api'
import { emptyDecideDraft } from './model'
import { OverrideCase, type OverrideCaseModel } from './OverrideCase'

/**
 * F-PR-16 (the browser walk; F-PR-09) — "Decide for <customer>…" and "Reverse…" (production plan §3 "No silent decisions"), the
 * office part mounted in Samples, Time & action, Promise dates and Approvals, MADE-UP data only: the decision as the kind allows,
 * a refusal with its words, the reversal of an answer. The button opens THE dialog; Esc or Cancel closes it.
 */

const request = (over: Partial<OverrideRequest> = {}): OverrideRequest => ({
  id: 'c0c0c0c0-0000-4000-8000-000000000901',
  companyId: 'c0c0c0c0-0000-4000-8000-000000000001',
  kind: 'SAMPLE',
  record: { type: 'SampleRound', id: 'c0c0c0c0-0000-4000-8000-000000000902', words: { en: `${BRAND_BETA.numbers.style} · round 2`, it: `${BRAND_BETA.numbers.style} · giro 2` } },
  party: { id: 'c0c0c0c0-0000-4000-8000-000000000903', name: BRAND_BETA.tradeName },
  question: 'Do you approve the stitching and the colour of the sample?',
  dueAt: '2026-11-21T16:00:00Z',
  status: 'OPEN',
  answer: null,
  decidedForParty: null,
  reversed: null,
  override: null,
  askedBy: 'Marta Verdi',
  may: { withdraw: false, decideForParty: true, reverse: false },
  version: 3,
  ...over,
})

const decide = (open: boolean, draft: Partial<ReturnType<typeof emptyDecideDraft>> = {}): OverrideCaseModel => ({
  request: request(),
  customer: BRAND_BETA.tradeName,
  dialog: { act: 'decide', draft: { ...emptyDecideDraft('Carlo Prova'), ...draft }, problem: null, fields: {} },
  open,
})

const ANSWERED = request({
  status: 'APPROVED',
  answer: { at: '2026-11-17T10:12:00Z', typedName: BRAND_BETA.portalPerson.name, words: null, via: 'PORTAL', personName: BRAND_BETA.portalPerson.name },
  may: { withdraw: false, decideForParty: false, reverse: true },
})

export const designScreen = defineDesignScreen<OverrideCaseModel>({
  screen: 'SCR-030-decide-for',
  title: 'Decide for the customer · Reverse (office part)',
  view: OverrideCase,
  part: true,
  cases: [
    { id: 'decide', label: 'F-PR-09 · Decide for Brand Beta…: the decision, why (they read it), the typed name', model: decide(true), note: 'Enter in the typed name sends nothing: the send button and ⌘↵ send (F-PR-16).' },
    { id: 'decide-refused', label: 'F-PR-09 · Refused for them: the words they read are asked', model: decide(true, { decision: 'REFUSED', answer: 'The colour is darker than the lab dip.', reason: 'They asked us on the phone to decide.' }) },
    { id: 'decide-closed', label: 'F-PR-09 · The act alone: the button opens the dialog (the keyboard walk)', model: decide(false) },
    { id: 'reverse', label: 'F-PR-09 · Reverse Brand Beta’s answer: what it does to the record, why', model: { request: ANSWERED, customer: BRAND_BETA.tradeName, dialog: { act: 'reverse', reason: '', problem: null, fields: {} }, open: true } },
  ],
})
