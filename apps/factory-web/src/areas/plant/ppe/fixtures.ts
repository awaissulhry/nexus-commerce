import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import {
  APRON,
  COUNTS,
  EARS,
  GAP_MARIO,
  GAP_SARA,
  GAPS_ALL_SITES,
  GAPS_EVERYONE,
  GLOVES,
  gapsAnswer,
  inPpeShell,
  ISSUE_ALL_SITES,
  ISSUES,
  issuesAnswer,
  itemRecord,
  itemsAnswer,
  KITS,
  KITS_ALL,
  MASK,
  NOW,
  PPE_ROLES_DEMO,
  PREFIX,
  SCOPE_ALL,
  SCOPE_ONE,
  SHOES,
  SUPPLIERS,
  type PpeRoleDemo,
} from './_demo/fixtures'
import { EMPTY_ADDRESS, EMPTY_ISSUE, EMPTY_ITEM, itemDraftOf, lineKey, ppeCan, prefillLines, type PpeAddress } from './model'
import type { IssueState, ItemState, PpePageModel } from './view-model'
import { PpePageView } from './view/PpePageView'

/**
 * SCR-211 — Plant › Health & safety › PPE for workers (B-W2b-147; design plant.ppe). Made-up data only (./_demo): an invented
 * company with two sites, invented people, roles, items and a supplier. Roles from factory-domain's templates: the safety officer
 * keeps the catalogue and records receipts; the owner sees the unit cost; the floor supervisor records receipts but uploads no
 * file; the production manager reads; sales has no safety.view. The labels and notes are English (the design index only); the
 * screen's words come from the catalogues.
 */

interface PpeCase {
  role: PpeRoleDemo
  model: PpePageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }

function base(role: PpeRoleDemo, over: Partial<PpePageModel> = {}, address: Partial<PpeAddress> = {}, scope: OfficeScope = SCOPE_ONE): PpeCase {
  const can = ppeCan(PPE_ROLES_DEMO[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      scope,
      companyId: scope.company?.id ?? null,
      address: { ...EMPTY_ADDRESS, ...address },
      tabletReady: false,
      riskPage: false,
      counts: ready(COUNTS),
      gaps: ready(gapsAnswer()),
      issues: ready(issuesAnswer()),
      kits: ready(KITS),
      items: ready(itemsAnswer({ canAdd: can.manage, items: itemsAnswer({}, can.cost).items.map((row) => ({ ...row, canManage: can.manage })) }, can.cost)),
      readAt: NOW,
      notice: null,
      roleBanner: null,
      selected: [],
      issue: null,
      item: null,
      voiding: null,
      scan: null,
      archiveMany: null,
      commonBusy: false,
      now: NOW,
      ...over,
    },
  }
}

const issueState = (over: Partial<IssueState> = {}): IssueState => ({ people: ready(GAPS_EVERYONE), items: ready(itemsAnswer().items), draft: EMPTY_ISSUE, busy: false, problem: null, recorded: null, ...over })
const prefilled = { ...EMPTY_ISSUE, employeeId: GAP_MARIO.employee.id, lines: prefillLines(GAP_MARIO) }
const withSizes = { ...prefilled, lines: prefilled.lines.map((entry) => ({ ...entry, size: entry.ppeItemId === GLOVES.id ? '9' : '42' })) }
const itemState = (over: Partial<ItemState> = {}): ItemState => ({ id: null, read: null, draft: EMPTY_ITEM, suppliers: ready(SUPPLIERS), busy: false, problem: null, saved: null, ...over })
const glovesState = (over: Partial<ItemState> = {}): ItemState => itemState({ id: GLOVES.id, read: ready(itemRecord(GLOVES)), draft: itemDraftOf(GLOVES), ...over })

function PpeDesign({ model }: { model: PpeCase }) {
  return inPpeShell('/plant/ppe', createElement(PpePageView, { model: model.model }), model.role, model.model.scope)
}

export const designScreen = defineDesignScreen<PpeCase>({
  screen: 'SCR-211',
  title: 'PPE for workers (Plant › Health & safety)',
  view: PpeDesign,
  cases: [
    {
      id: 'normal',
      label: 'Safety officer: tiles and Gaps per person',
      model: base('safety'),
      note: 'Tiles (people missing kit items, receipts not signed, replacements due; "Items below minimum" stays Later: not drawn) · the four lenses · Gaps: person, role, missing items, last issue, Issue now and the PPE card. i issues PPE, c adds an item, 1–4 switch the lenses.',
    },
    { id: 'all-sites', label: 'All sites: a Site column and the site chip', model: base('safety', { gaps: ready(gapsAnswer({ people: GAPS_ALL_SITES })), kits: ready(KITS_ALL) }, {}, SCOPE_ALL) },
    { id: 'gaps-replace', label: 'Gaps · Replacements due (the tile as the filter)', model: base('safety', { gaps: ready(gapsAnswer({ people: GAPS_EVERYONE })) }, { show: 'replace' }) },
    { id: 'gaps-everyone', label: 'Gaps · Everyone (with a person without a role)', model: base('safety', { gaps: ready(gapsAnswer({ people: GAPS_EVERYONE })) }, { show: 'all' }) },
    { id: 'gaps-selected', label: 'Gaps · two people chosen: Print 2 PPE cards', model: base('safety', { selected: [GAP_MARIO.employee.id, GAPS_EVERYONE[1]!.employee.id] }) },
    { id: 'gaps-empty', label: 'Gaps empty: "Everyone has their kit."', model: base('safety', { gaps: ready(gapsAnswer({ people: [], withoutRole: 0 })), counts: ready({ ...COUNTS, peopleMissingKit: 0 }) }) },
    { id: 'gaps-filtered', label: 'Gaps: filters match nothing', model: base('safety', { gaps: ready(gapsAnswer({ people: [] })) }, { q: 'zz' }) },
    { id: 'issues', label: 'Issues and receipts', model: base('safety', {}, { view: 'issues' }), note: 'Signed with PIN (the giver hidden: "A worker"), on paper with its scan, a paper receipt still without its scan (Add the signed scan), a voided line with its reason. Enter opens the receipt in a new tab.' },
    { id: 'issues-not-signed', label: 'Issues · Receipts not signed (the tile as the filter)', model: base('safety', { issues: ready(issuesAnswer({ issues: [ISSUES[0]!] })) }, { view: 'issues', signed: 'notSigned' }) },
    { id: 'issues-selected', label: 'Issues · three lines chosen: Print 2 receipts', model: base('safety', { selected: [ISSUES[1]!.id, ISSUES[2]!.id, ISSUES[3]!.id] }, { view: 'issues' }) },
    { id: 'issues-all-sites', label: 'Issues with All sites', model: base('safety', { issues: ready(issuesAnswer({ issues: [...ISSUES, ISSUE_ALL_SITES] })) }, { view: 'issues' }, SCOPE_ALL) },
    { id: 'issues-empty', label: 'Issues empty: signed on the floor tablet', model: base('safety', { issues: ready(issuesAnswer({ issues: [] })) }, { view: 'issues' }) },
    { id: 'kits', label: 'Kits per role (roles × items, read only)', model: base('safety', {}, { view: 'kits' }), note: 'Read here; edited in the role sheet (Plant › Risk assessment, linked once that page is built).' },
    { id: 'kits-empty', label: 'Kits: no role names a PPE item yet', model: base('safety', { kits: ready({ ...KITS, cells: [] }) }, { view: 'kits' }) },
    { id: 'catalogue', label: 'Catalogue — owner: with the unit cost', model: base('owner', {}, { view: 'catalogue' }) },
    { id: 'catalogue-no-cost', label: 'Catalogue — safety officer: unit cost withheld (Columns ▾ "Hidden")', model: base('safety', {}, { view: 'catalogue' }) },
    { id: 'catalogue-archived', label: 'Catalogue · archived items', model: base('safety', { items: ready(itemsAnswer({ items: [MASK] }, false)) }, { view: 'catalogue', status: 'ARCHIVED' }) },
    { id: 'catalogue-selected', label: 'Catalogue · Archive 1 (items in a kit cannot be chosen)', model: base('safety', { selected: [itemsAnswer().items[2]!.id] }, { view: 'catalogue' }) },
    { id: 'catalogue-empty', label: 'Catalogue empty: Start from common items', model: base('safety', { items: ready(itemsAnswer({ items: [] }, false)) }, { view: 'catalogue' }) },
    { id: 'loading', label: 'Loading: each section in its shape', model: base('safety', { counts: loading, gaps: loading, kits: loading, readAt: null }) },
    { id: 'error', label: 'Failed reads: said with Try again, never drawn as empty', model: base('safety', { counts: failed, gaps: failed }) },
    { id: 'error-issues', label: 'Issues failed', model: base('safety', { issues: failed }, { view: 'issues' }) },
    { id: 'read-only', label: 'Production manager: reads; Issue PPE and New PPE item held with the reason', model: base('production') },
    { id: 'no-permission', label: 'Sales: no safety.view', model: base('sales') },
    { id: 'role-banner', label: 'Live: a role sheet changed — the banner', model: base('safety', { roleBanner: { role: 'Tagliatore', people: 4 } }) },
    { id: 'notice', label: 'After a paper receipt without its scan: the notice', model: base('safety', { notice: { tone: 'success', key: 'notice.issuedNoScan', params: { name: 'Giorgio Demo', count: 1 } } }) },
    {
      id: 'issue',
      label: 'Issue PPE: choose the person',
      model: base('safety', { issue: issueState() }, { issue: 'new' }),
      note: 'Held "Choose the person." The person picker lists everyone of the site with their role.',
    },
    {
      id: 'issue-prefilled',
      label: 'Issue PPE from "Issue now": the missing kit prefilled',
      model: base('safety', { issue: issueState({ draft: prefilled }) }, { issue: GAP_MARIO.employee.id }),
      note: 'Gloves ×2 and shoes ×1 come from the role kit; held "Choose each item\'s size." until the sizes are picked.',
    },
    { id: 'issue-paper', label: 'Issue PPE on paper, with the signed scan', model: base('safety', { issue: issueState({ draft: { ...withSizes, signedAt: '2026-11-05T08:30:00.000Z', scan: { name: 'ricevuta-mario.pdf', type: 'application/pdf', size: 184_000 } } }) }, { issue: GAP_MARIO.employee.id }) },
    { id: 'issue-replacement', label: 'Issue PPE: a replacement for units past their life', model: base('safety', { issue: issueState({ draft: { ...EMPTY_ISSUE, employeeId: GAP_SARA.employee.id, lines: prefillLines(GAP_SARA).map((entry) => ({ ...entry, size: '8' })) } }) }, { issue: GAP_SARA.employee.id }) },
    { id: 'issue-tablet', label: 'Issue PPE at the floor tablet: held until the floor screen ships', model: base('safety', { issue: issueState({ draft: { ...withSizes, method: 'tablet' } }) }, { issue: GAP_MARIO.employee.id }) },
    { id: 'issue-tablet-ready', label: 'Issue PPE at the floor tablet (the floor screen built): nothing recorded here', model: base('safety', { tabletReady: true, issue: issueState({ draft: { ...withSizes, method: 'tablet' } }) }, { issue: GAP_MARIO.employee.id }) },
    {
      id: 'issue-refused',
      label: 'Issue PPE refused: a size the item does not have, said on its line',
      model: base('safety', { issue: issueState({ draft: { ...withSizes, lines: [...withSizes.lines, { key: lineKey(), ppeItemId: APRON.id, size: 'XXL', quantity: 1, reason: 'LOST' }] }, problem: { key: 'held.line.size', field: 'lines', line: 2 } }) }, { issue: GAP_MARIO.employee.id }),
    },
    { id: 'issue-no-upload', label: 'Floor supervisor: records the paper, cannot upload the scan', model: base('supervisor', { issue: issueState({ draft: withSizes }) }, { issue: GAP_MARIO.employee.id }) },
    {
      id: 'issue-scan-refused',
      label: 'Recorded, but the scan was not taken',
      model: base('safety', { issue: issueState({ draft: withSizes, recorded: { answer: { receipt: { ...receiptForMario(), state: 'NOT_SIGNED' }, scan: { recordType: 'PpeIssue', recordId: ISSUES[0]!.id, companyId: SCOPE_ONE.company!.id } }, scanProblem: 'problem.unavailable' } }) }, { issue: GAP_MARIO.employee.id }),
    },
    { id: 'issue-loading', label: 'Issue PPE reading the people and the catalogue', model: base('safety', { issue: issueState({ people: loading, items: loading }) }, { issue: 'new' }) },
    { id: 'issue-error', label: 'Issue PPE: the people could not be read', model: base('safety', { issue: issueState({ people: failed }) }, { issue: 'new' }) },
    { id: 'item-new', label: 'New PPE item: empty, Save held', model: base('safety', { item: itemState() }, { view: 'catalogue', item: 'new' }) },
    { id: 'item-new-filled', label: 'New PPE item filled (owner, with the unit cost)', model: base('owner', { item: itemState({ draft: { ...EMPTY_ITEM, code: 'occhiali-uv', name: 'Occhiali UV', nameIt: 'Occhiali UV', nameEn: 'UV glasses', category: 'CATEGORY_II', standard: 'EN 170:2002', lifeMonths: '12', supplierPartyId: SUPPLIERS[0]!.id, unitCost: '9,90' } }) }, { view: 'catalogue', item: 'new' }) },
    { id: 'item-code-taken', label: 'New PPE item refused: the code is taken, said at its field', model: base('safety', { item: itemState({ draft: { ...EMPTY_ITEM, code: 'GLOVES-CUT', name: 'Guanti', category: 'CATEGORY_II' }, problem: { key: 'refusal.CODE_TAKEN', field: 'code', line: null } }) }, { view: 'catalogue', item: 'new' }) },
    { id: 'item', label: 'PPE item: the gloves, named by two role kits; Archive held', model: base('safety', { item: glovesState() }, { view: 'catalogue', item: GLOVES.id }), note: 'Save held "Nothing changed." until a field changes; Archive held while the cutters\' kits name it.' },
    { id: 'item-edited', label: 'PPE item edited (sizes and life)', model: base('safety', { item: glovesState({ draft: { ...itemDraftOf(GLOVES), sizes: ['7', '8', '9', '10', '11'], lifeMonths: '4' } }) }, { view: 'catalogue', item: GLOVES.id }) },
    { id: 'item-archived', label: 'PPE item archived: Put back in use', model: base('safety', { item: itemState({ id: MASK.id, read: ready(itemRecord(MASK)), draft: itemDraftOf(MASK) }) }, { view: 'catalogue', item: MASK.id }) },
    { id: 'item-read-only', label: 'Production manager: the item read only', model: base('production', { item: itemState({ id: EARS.id, read: ready(itemRecord({ ...EARS, canManage: false })), draft: itemDraftOf(EARS), suppliers: null }) }, { view: 'catalogue', item: EARS.id }) },
    { id: 'item-loading', label: 'PPE item reading', model: base('safety', { item: itemState({ id: SHOES.id, read: loading }) }, { view: 'catalogue', item: SHOES.id }) },
    { id: 'void', label: 'Void an issue: the reason; the receipt stays with a void mark', model: base('safety', { voiding: { issueId: ISSUES[0]!.id, reason: 'Taglia sbagliata: scambiate con il 44', busy: false, problem: null } }, { view: 'issues', void: ISSUES[0]!.id }) },
    { id: 'void-held', label: 'Void held: "Say why this issue is wrong."', model: base('safety', { voiding: { issueId: ISSUES[3]!.id, reason: '', busy: false, problem: null } }, { view: 'issues', void: ISSUES[3]!.id }) },
    { id: 'void-refused', label: 'Void refused: voided already', model: base('safety', { voiding: { issueId: ISSUES[0]!.id, reason: 'Errore', busy: false, problem: { key: 'refusal.VOIDED_ALREADY', field: null, line: null } } }, { view: 'issues', void: ISSUES[0]!.id }) },
    { id: 'scan', label: 'Add the signed scan to a paper receipt', model: base('safety', { scan: { receiptId: ISSUES[0]!.receiptId, file: { name: 'ricevuta-giorgio.jpg', type: 'image/jpeg', size: 640_000 }, busy: false, problem: null } }, { view: 'issues', scan: ISSUES[0]!.receiptId }) },
    { id: 'archive-many', label: 'Archive 1 item', model: base('safety', { selected: [itemsAnswer().items[2]!.id], archiveMany: { ids: [itemsAnswer().items[2]!.id], busy: false } }, { view: 'catalogue' }) },
    { id: 'keys', label: 'Keyboard shortcuts (?)', model: base('safety', { keysOpen: true }) },
  ],
})

function receiptForMario() {
  const line = { ...ISSUES[0]!, employee: GAP_MARIO.employee, item: { id: GLOVES.id, code: GLOVES.code, name: GLOVES.name, nameI18n: GLOVES.nameI18n, category: GLOVES.category }, size: '9', quantity: 2 }
  return {
    id: line.receiptId,
    companyId: line.companyId,
    siteId: line.siteId,
    site: line.site,
    employee: line.employee,
    issuedAt: NOW,
    method: 'PAPER' as const,
    state: 'NOT_SIGNED' as const,
    issuedBy: line.issuedBy,
    signature: null,
    scan: null,
    document: null,
    lines: [line],
    units: 2,
    canIssue: true,
  }
}
