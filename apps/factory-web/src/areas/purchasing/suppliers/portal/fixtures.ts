import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { blankInvite } from '../../../admin/users/partners/model'
import { inShell, panels, RECORD_CAN, recordModel, SUPPLIERS } from '../../../parties/_shared/fixtures'
import { PartyRecordView } from '../../../parties/_shared/view/PartyRecordView'
import { portalModel, READ_ONLY, rolesOf, SUPPLIER_PEOPLE, supplierAccess } from '../../../sales/customers/portal/demo'
import type { PortalAccessModel } from '../../../sales/customers/portal/model'
import { PortalAccessView } from '../../../sales/customers/portal/view/PortalAccessView'

/**
 * SCR-057-portal — Supplier › Portal access (B-W2b-180; design purchasing.suppliers rec:Supplier/portal, moved here from
 * W2b-5: the office cannot invite a supplier without it). The customer's tab on the buying side: no prices column and one
 * line saying supplier roles never see a price (C2), no production-progress switch, Report progress instead of
 * measurements. Made-up data only.
 */

const party = SUPPLIERS[0]!

function SupplierPortalDesign({ model }: { model: PortalAccessModel }) {
  const record = recordModel('suppliers', party, { tab: 'portal', can: { ...RECORD_CAN, partners: true } })
  return inShell(`/purchasing/suppliers/${party.id}`, createElement(PartyRecordView, { model: record, panels: panels(party), portal: createElement(PortalAccessView, { model }) }))
}

const base = (over: Partial<PortalAccessModel> = {}) => portalModel('suppliers', over)
const workshop = () =>
  supplierAccess({
    party: { ...supplierAccess().party, code: 'LABORATORIO-DEMO', name: 'Laboratorio Demo', roles: ['SUBCONTRACTOR'] },
    kinds: ['SUBCONTRACTOR'],
    roles: rolesOf(['SUBCONTRACTOR']),
    people: SUPPLIER_PEOPLE.slice(0, 1).map((person) => ({ ...person, kind: 'SUBCONTRACTOR' as const, roleKey: 'subcontractor-admin', roleName: 'Admin' })),
    seats: { taken: 1, max: null },
  })
const both = () =>
  supplierAccess({
    party: { ...supplierAccess().party, roles: ['SUPPLIER', 'SUBCONTRACTOR'] },
    kinds: ['SUPPLIER', 'SUBCONTRACTOR'],
    roles: rolesOf(['SUPPLIER', 'SUBCONTRACTOR']),
  })

export const designScreen = defineDesignScreen<PortalAccessModel>({
  screen: 'SCR-057-portal',
  title: 'Supplier › Portal access',
  view: SupplierPortalDesign,
  cases: [
    { id: 'normal', label: 'Portal on: an admin, an orders contact, an invited one (no prices column)', model: base() },
    { id: 'empty', label: 'Nobody has portal access: links still work without an account', model: base({ access: supplierAccess({ people: [], seats: { taken: 0, max: null }, settings: { portalOn: false, progressShared: false, maxUsers: null, allowedRoleKeys: [], version: 0 } }) }) },
    { id: 'workshop', label: 'A workshop (subcontractor): Jobs and Admin roles', model: base({ access: workshop() }) },
    { id: 'two-portals', label: 'Supplier and workshop at once: the invite asks which portal', model: base({ access: both(), dialog: { kind: 'invite' }, inviteDraft: blankInvite(both()) }) },
    { id: 'invite', label: 'Invite a supplier contact: Orders, no price', model: base({ dialog: { kind: 'invite' } }) },
    { id: 'confirm-revoke', label: 'Revoke the invitation of Carla Fatture', model: base({ dialog: { kind: 'confirm', action: 'revoke', userIds: [SUPPLIER_PEOPLE[2]!.id] } }) },
    { id: 'ask', label: 'Ask for something: report progress', model: base({ dialog: { kind: 'ask' } }) },
    { id: 'read-only', label: 'No partners.invite / partners.manage: shown read-only, actions held with the missing right', model: base({ can: READ_ONLY }) },
    { id: 'blocked', label: 'A blocked supplier: Invite held (unblock first)', model: base({ access: supplierAccess({ party: { ...supplierAccess().party, status: 'BLOCKED' } }) }) },
    { id: 'loading', label: 'Loading', model: base({ access: null, asOf: null, live: 'connecting', requests: { items: null, problem: null, selected: [] } }) },
    { id: 'error', label: "Couldn't load people with access: the reason and Try again (never drawn as empty)", model: base({ access: null, problem: 'problem.unavailable' }) },
  ],
})
