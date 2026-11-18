import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../../admin/shared/model'
import { blankInvite, settingsDraftOf } from '../../../admin/users/partners/model'
import { CUSTOMERS, inShell, partyThread, RECORD_CAN, recordModel } from '../../../parties/_shared/fixtures'
import { PartyRecordView } from '../../../parties/_shared/view/PartyRecordView'
import { dormantMarksWords, PRODUCTION_ROLE_NOT_OFFERED_WORDS } from '@nexus/factory-domain/production-brand/words'
import { CUSTOMER_PEOPLE, customerAccess, freezeList, limitsModel, OFFICE_PEOPLE, portalModel, productionLimits, READ_ONLY, REQUESTS, rolesOf } from './demo'
import { blankFreezeDraft, limitsDraftOf, withPreset } from './limits/model'
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
  return inShell(`/sales/customers/${party.id}`, createElement(PartyRecordView, { model: record, thread: partyThread(party, model.side) /* B-TH-260 */, portal: createElement(PortalAccessView, { model }) }))
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
    { id: 'empty', label: 'Portal off, nobody yet: the first Invite', model: base({ access: customerAccess({ people: [], seats: { taken: 0, max: null }, settings: { portalOn: false, maxUsers: null, allowedRoleKeys: [], version: 0 } }), requests: { items: [], problem: null, selected: [] } }) },
    { id: 'settings-dirty', label: 'Portal card edited: 8 people at most, Viewer not offered (save bar)', model: base({ settingsDraft: { ...settingsDraftOf(customerAccess().settings), maxUsers: '8', allowedRoleKeys: rolesOf(['CUSTOMER']).filter((role) => role.key !== 'customer-viewer').map((role) => role.key) } }) },
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
    // ── F-PR-07: the production limits card ──
    { id: 'limits-preset', label: 'F-PR-07 · Limits: "Production partner" pressed — + Progress, urgent orders on (at most 3), every production request (Apply bar)', model: base({ limits: limitsModel({ draft: withPreset(limitsDraftOf(productionLimits().production)) }) }) },
    { id: 'limits-on', label: 'F-PR-07 · Limits saved: + Progress, urgent orders (2 urgent now), pause and resume, Marco Prova answers, a second person, supervisor Bea Esempio + backup Carlo Prova', model: base({ limits: limitsModel({ read: productionLimits({ level: 'PROGRESS', urgency: { on: true, max: 3, now: 2, dormant: null, overQuota: null }, askKinds: ['HOLD', 'RESUME'], openAsks: ['RUSH', 'HOLD', 'RESUME'], approver: { id: marco.id, name: marco.displayName, active: true }, overrideFourEyes: true, supervisor: { id: OFFICE_PEOPLE.bea.id, name: OFFICE_PEOPLE.bea.name, active: true }, backup: { id: OFFICE_PEOPLE.carlo.id, name: OFFICE_PEOPLE.carlo.name, active: true }, version: 6 }) }) }) },
    { id: 'limits-dormant', label: 'F-PR-07 · Limits: urgent orders switched off — "3 urgent marks are kept but not used while this is off"', model: base({ limits: limitsModel({ read: productionLimits({ urgency: { on: false, max: 3, now: 3, dormant: dormantMarksWords(3), overQuota: null } }) }) }) },
    { id: 'limits-switching-off', label: 'F-PR-07 · Limits edited: urgent orders being switched off with 2 marks (said before Apply)', model: base({ limits: limitsModel({ read: productionLimits({ urgency: { on: true, max: 3, now: 2, dormant: null, overQuota: null } }), draft: { ...limitsDraftOf(productionLimits({ urgency: { on: true, max: 3, now: 2, dormant: null, overQuota: null } }).production), urgencyOn: false } }) }) },
    { id: 'limits-over-quota', label: 'F-PR-07 · Limits edited: the quota lowered to 1 under 3 urgent marks (they stay; new marks only below it)', model: base({ limits: limitsModel({ read: productionLimits({ urgency: { on: true, max: 3, now: 3, dormant: null, overQuota: null } }), draft: { ...limitsDraftOf(productionLimits({ urgency: { on: true, max: 3, now: 3, dormant: null, overQuota: null } }).production), urgentMax: 1 } }) }) },
    { id: 'limits-new-supervisor', label: 'F-PR-07 · Limits: a first supervisor picked — "moves 7 orders that have no supervisor of their own" before Apply', model: base({ limits: limitsModel({ draft: { ...limitsDraftOf(productionLimits().production), supervisorId: OFFICE_PEOPLE.bea.id, backupId: OFFICE_PEOPLE.carlo.id } }) }) },
    { id: 'limits-role-warning', label: 'F-PR-07 · Limits: their allowed roles leave the Production role out (warning)', model: base({ limits: limitsModel({ read: productionLimits({ productionRoleOffered: false, productionRoleWords: PRODUCTION_ROLE_NOT_OFFERED_WORDS }) }) }) },
    { id: 'limits-portal-off', label: 'F-PR-07 · Limits with the portal off (no settings row yet): the card and the office-only supervisor block are drawn', model: base({ access: customerAccess({ people: [], seats: { taken: 0, max: null }, settings: { portalOn: false, maxUsers: null, allowedRoleKeys: [], version: 0 } }), requests: { items: [], problem: null, selected: [] }, limits: limitsModel({ read: productionLimits({ version: 0 }) }) }) },
    { id: 'limits-read-only', label: 'F-PR-07 · Limits read only (no partners.production.manage, no production.brand.manage): every change held with the right it needs', model: base({ can: READ_ONLY, limits: limitsModel({ read: productionLimits({ supervisor: { id: OFFICE_PEOPLE.bea.id, name: OFFICE_PEOPLE.bea.name, active: true } }, false), supervise: false, pick: { status: 'held', key: 'held.noRight', ns: 'production-supervisor' }, freeze: { status: 'ready', list: freezeList({ mayManage: false }) } }) }) },
    { id: 'limits-supervisor-every-company', label: 'F-PR-07 · Limits: the supervisor held — the reader does not manage this customer at every company', model: base({ limits: limitsModel({ pick: { status: 'held', key: 'limits.supervisor.heldEveryCompany', ns: 'portal-access' } }) }) },
    { id: 'limits-nobody', label: 'F-PR-07 · Limits: nobody may supervise yet (what a supervisor needs, in words)', model: base({ limits: limitsModel({ pick: { status: 'ready', people: [], complete: true, ordersOnDefault: 0 } }) }) },
    { id: 'limits-inactive', label: 'F-PR-07 · Limits: the saved supervisor and the named approver are no longer active', model: base({ limits: limitsModel({ read: productionLimits({ approver: { id: CUSTOMER_PEOPLE[4]!.id, name: CUSTOMER_PEOPLE[4]!.displayName, active: false }, supervisor: { id: 'u-gone', name: 'Dora Campione', active: false } }) }) }) },
    { id: 'limits-freeze-dialog', label: 'F-PR-07 · Freeze of colourway for Moda Demo: the company’s, their own (Back to the company’s), a rule of their own', model: base({ limits: limitsModel({ freezeDialog: { field: 'COLOURWAY', draft: blankFreezeDraft('COLOURWAY'), busy: false, problem: null } }) }) },
    { id: 'limits-freeze-twin', label: 'F-PR-07 · Freeze dialog: a second rule of their own at the same stage (held, in words)', model: base({ limits: limitsModel({ freezeDialog: { field: 'COLOURWAY', draft: { ...blankFreezeDraft('COLOURWAY'), frozenFrom: 'RELEASED' }, busy: false, problem: null } }) }) },
    { id: 'limits-save-problem', label: 'F-PR-07 · Apply: the limits saved, the supervisor refused (cannot open measurement sheets)', model: base({ limits: limitsModel({ saveProblem: { key: 'skip.NO_MEASUREMENTS', ns: 'production-supervisor', limitsSaved: true } }) }) },
    { id: 'limits-step-up', label: 'F-PR-07 · Apply: a fresh code before the limits change', model: base({ limits: limitsModel({ draft: withPreset(limitsDraftOf(productionLimits().production)), busy: true }), stepUp: { ...STEP_UP_CLOSED, open: true, sentence: 'stepUp.sentence.production' } }) },
    { id: 'limits-loading', label: 'F-PR-07 · Limits loading (the rest of the tab is read)', model: base({ limits: limitsModel({ state: 'loading', read: null }) }) },
    { id: 'limits-error', label: "F-PR-07 · Limits couldn't be read: Try again (the rest of the tab works)", model: base({ limits: limitsModel({ state: 'error', read: null, problem: 'problem.unavailable' }) }) },
    { id: 'no-permission', label: 'No partners.view: the record has no Portal access tab; opened by its address, the view says why', model: base({ can: { view: false, invite: false, manage: false, preview: false, requests: false } }) },
  ],
})
