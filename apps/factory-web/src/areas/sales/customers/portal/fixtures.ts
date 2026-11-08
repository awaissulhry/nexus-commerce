import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../../admin/shared/model'
import { blankInvite, settingsDraftOf } from '../../../admin/users/partners/model'
import { CUSTOMERS, inShell, panels, RECORD_CAN, recordModel } from '../../../parties/_shared/fixtures'
import { PartyRecordView } from '../../../parties/_shared/view/PartyRecordView'
import { CUSTOMER_PEOPLE, customerAccess, portalModel, READ_ONLY, REQUESTS, rolesOf } from './demo'
import type { PortalAccessModel } from './model'
import { PortalAccessView } from './view/PortalAccessView'

/**
 * SCR-033-portal — Customer › Portal access (B-W2b-180; design sales.customers rec:Customer/customer.portal, the new tab
 * customers.portalPreview, the live line "portal user signed in"), inside the customer record. Made-up data only. Every
 * state: loading, a failed read, no right, read-only, nobody yet, the portal off, the terms not published (invite held),
 * every seat taken, each dialog and the refusals in words, the live line, the requests and their failed read.
 */

const party = CUSTOMERS.find((item) => item.code === 'MODA-DEMO')!

export function PortalDesign({ model }: { model: PortalAccessModel }) {
  const record = recordModel(model.side, party, { tab: 'portal', can: { ...RECORD_CAN, partners: true } })
  return inShell(`/sales/customers/${party.id}`, createElement(PartyRecordView, { model: record, panels: panels(party), portal: createElement(PortalAccessView, { model }) }))
}

const base = (over: Partial<PortalAccessModel> = {}) => portalModel('customers', over)
const marco = CUSTOMER_PEOPLE[1]!
const sara = CUSTOMER_PEOPLE[2]!

export const designScreen = defineDesignScreen<PortalAccessModel>({
  screen: 'SCR-033-portal',
  title: 'Customer › Portal access',
  view: PortalDesign,
  cases: [
    { id: 'normal', label: 'Portal on: people in every state, two requests waiting', model: base(), note: 'Sara’s access ends in 5 days (ends soon); Paolo is invited; Elena suspended; Luca left (hidden until asked).' },
    { id: 'live-signed-in', label: 'Live line: Marco Prova signed in just now', model: base({ signedIn: { name: 'Marco Prova', at: '2026-10-29T09:41:00.000Z', first: false } }) },
    { id: 'live-first', label: 'Live line: the invited person signed in for the first time', model: base({ signedIn: { name: 'Paolo Campione', at: '2026-10-29T09:41:00.000Z', first: true } }) },
    { id: 'show-left', label: 'Show people who left (the deactivated row cannot be ticked)', model: base({ showLeft: true }) },
    { id: 'selected', label: 'Three ticked: Send again 1 · Suspend 1 · Reactivate 1 · Deactivate 2', model: base({ selected: [marco.id, CUSTOMER_PEOPLE[3]!.id, CUSTOMER_PEOPLE[4]!.id] }) },
    { id: 'empty', label: 'Portal off, nobody yet: the first Invite', model: base({ access: customerAccess({ people: [], seats: { taken: 0, max: null }, settings: { portalOn: false, progressShared: false, maxUsers: null, allowedRoleKeys: [], version: 0 } }), requests: { items: [], problem: null, selected: [] } }) },
    { id: 'settings-dirty', label: 'Portal card edited: production progress on, 8 people at most, Viewer not offered (save bar)', model: base({ settingsDraft: { ...settingsDraftOf(customerAccess().settings), progressShared: true, maxUsers: '8', allowedRoleKeys: rolesOf(['CUSTOMER']).filter((role) => role.key !== 'customer-viewer').map((role) => role.key) } }) },
    { id: 'settings-problem', label: 'Portal card: people at most below the people already in (held, in words)', model: base({ settingsDraft: { ...settingsDraftOf(customerAccess().settings), maxUsers: '3' } }) },
    { id: 'no-terms', label: 'Portal terms not published: Invite held with the reason', model: base({ access: customerAccess({ termsInForce: false }) }) },
    { id: 'seats-full', label: 'Every seat taken: Invite held', model: base({ access: customerAccess({ seats: { taken: 5, max: 5 }, settings: { ...customerAccess().settings, maxUsers: 5 } }) }) },
    { id: 'read-only', label: 'Read only (partners.view): every action held with the right it needs', model: base({ can: READ_ONLY }) },
    { id: 'invite', label: 'Invite: role cards with prices, what they may also do, until, language', model: base({ dialog: { kind: 'invite' } }) },
    { id: 'invite-filled', label: 'Invite filled: Quality, until 31/12, English', model: base({ dialog: { kind: 'invite' }, inviteDraft: { ...blankInvite(customerAccess()), name: 'Nadia Esempio', email: 'nadia.esempio@example.com', roleKey: 'customer-quality', capabilities: ['comment', 'upload'], until: '2026-12-31', locale: 'en' } }) },
    { id: 'invite-problems', label: 'Invite with problems: no name, an address already in, a day in the past', model: base({ dialog: { kind: 'invite' }, inviteDraft: { ...blankInvite(customerAccess()), name: '', email: 'marco.prova@example.com', until: '2026-10-01' } }) },
    { id: 'invite-refused', label: 'Invite refused by the API: the address is an office person’s', model: base({ dialog: { kind: 'invite' }, inviteDraft: { ...blankInvite(customerAccess()), name: 'Chiara Ufficio', email: 'chiara@factory.example' }, dialogProblem: 'problem.officeAddress' }) },
    { id: 'person', label: 'Change access of Sara Demo: role, capabilities, end of access', model: base({ dialog: { kind: 'person', userId: sara.id } }) },
    { id: 'person-invited', label: 'Change access of an invited person (applies to the invitation)', model: base({ dialog: { kind: 'person', userId: CUSTOMER_PEOPLE[3]!.id } }) },
    { id: 'confirm-suspend', label: 'Suspend Marco Prova (with a reason)', model: base({ dialog: { kind: 'confirm', action: 'suspend', userIds: [marco.id] } }) },
    { id: 'confirm-deactivate', label: 'Deactivate 2 people (one ticked person left out)', model: base({ dialog: { kind: 'confirm', action: 'deactivate', userIds: [marco.id, sara.id, CUSTOMER_PEOPLE[3]!.id] } }) },
    { id: 'confirm-resend', label: 'Send the invitation again', model: base({ dialog: { kind: 'confirm', action: 'resend', userIds: [CUSTOMER_PEOPLE[3]!.id] } }) },
    { id: 'confirm-revoke', label: 'Revoke the invitation', model: base({ dialog: { kind: 'confirm', action: 'revoke', userIds: [CUSTOMER_PEOPLE[3]!.id] } }) },
    { id: 'step-up', label: 'A fresh code before the change', model: base({ dialog: { kind: 'confirm', action: 'suspend', userIds: [marco.id] }, stepUp: { ...STEP_UP_CLOSED, open: true, sentence: 'stepUp.sentence.status' } }) },
    { id: 'step-up-wrong', label: 'A wrong code', model: base({ stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.invite', problem: 'stepUp.problem.wrong' } }) },
    { id: 'done', label: 'Receipt after a run: 2 suspended, 1 refused with the reason', model: base({ notice: { key: 'done.suspend', tone: 'warning', params: { count: 2 }, refused: [{ name: 'Sara Demo', problem: 'problem.conflict' }] } }) },
    { id: 'preview-opening', label: 'Open preview: the new tab waits for the portal', model: base({ previewing: true }) },
    { id: 'preview-opened', label: 'Preview opened in a new tab (receipt)', model: base({ notice: { key: 'done.preview', tone: 'info', params: { name: 'Moda Demo' } } }) },
    { id: 'ask', label: 'Ask for something: upload a document by a date', model: base({ dialog: { kind: 'ask' } }) },
    { id: 'cancel-requests', label: 'Cancel 2 requests', model: base({ dialog: { kind: 'cancelRequest', requestIds: REQUESTS.map((item) => item.id) }, requests: { items: REQUESTS, problem: null, selected: REQUESTS.map((item) => item.id) } }) },
    { id: 'requests-failed', label: "Requests couldn't be read: the rest of the tab works", model: base({ requests: { items: null, problem: 'problem.unavailable', selected: [] } }) },
    { id: 'loading', label: 'Loading', model: base({ access: null, asOf: null, live: 'connecting', requests: { items: null, problem: null, selected: [] } }) },
    { id: 'error', label: "Couldn't load the portal access: Try again", model: base({ access: null, problem: 'problem.unavailable' }) },
    { id: 'no-permission', label: 'No partners.view: the record has no Portal access tab; opened by its address, the view says why', model: base({ can: { view: false, invite: false, manage: false, preview: false, requests: false } }) },
  ],
})
