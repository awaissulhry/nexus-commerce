import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../quality/_shared/hooks'
import { CHOICES, CLAIMS, COMPANY, COUNTS, FILES, inSourcingShell, listAnswer, LWG, NOW, ORGANIC_SOON, PFAS_BLOCKED, PFAS_REPLACEMENT, PREFIX, RECYCLED, recordOf, RETIRED, SOURCING_ROLES_DEMO, TODAY, type SourcingRoleDemo } from './_demo/fixtures'
import { draftOf, EMPTY_ADDRESS, EMPTY_DRAFT, EMPTY_USE, replacementOf, sourcingCan, type SourcingAddress } from './model'
import type { NewState, OpenState, SourcingPageModel } from './view-model'
import { SourcingPageView } from './view/SourcingPageView'

/**
 * SCR-215 — Compliance › Sustainability › Sourcing & claims (B-W2b-264; design compliance.sourcing; PRD-380). Made-up data only
 * (./_demo): an invented company, invented styles, materials, labels, files and people. Roles from factory-domain's templates:
 * the quality inspector keeps and approves claims; the production manager and read-only look; sales has no compliance read.
 * The labels and notes are English (the design index only); the screen's words come from the catalogues.
 */

interface SourcingCase {
  role: SourcingRoleDemo
  model: SourcingPageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }

function base(role: SourcingRoleDemo, over: Partial<SourcingPageModel> = {}, address: Partial<SourcingAddress> = {}): SourcingCase {
  const can = sourcingCan(SOURCING_ROLES_DEMO[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      companyId: COMPANY.id,
      companyName: COMPANY.name,
      address: { ...EMPTY_ADDRESS, ...address },
      today: TODAY,
      counts: ready(COUNTS),
      claims: ready(listAnswer({ canManage: can.manage, canApprove: can.approve, claims: CLAIMS.map((row) => ({ ...row, canManage: can.manage, canApprove: can.approve })) })),
      readAt: NOW,
      notice: null,
      selected: [],
      add: null,
      open: null,
      withdrawMany: null,
      stepUp: STEP_UP_CLOSED,
      ...over,
    },
  }
}

const open = (claim = RECYCLED, over: Partial<OpenState> = {}): OpenState => ({
  id: claim.id,
  read: ready(recordOf(claim)),
  mode: 'view',
  tab: 'wording',
  draft: null,
  choices: null,
  use: EMPTY_USE,
  reason: '',
  busy: false,
  problem: null,
  saved: null,
  ...over,
})

const add = (over: Partial<NewState> = {}): NewState => ({ draft: { ...EMPTY_DRAFT, code: 'CL-0007' }, choices: ready(CHOICES), busy: false, problem: null, savedWithoutFile: null, ...over })

const filled = {
  ...EMPTY_DRAFT,
  code: 'CL-0007',
  kind: 'RECYCLED_CONTENT' as const,
  wording: { it: 'Imbottitura in poliestere riciclato al 70 %', en: 'Padding made with 70 % recycled polyester' },
  scope: 'STYLE' as const,
  styleId: CHOICES.styles[0]!.id,
  scopeNote: "Solo l'imbottitura",
  evidenceFileIds: [FILES.recycled.id],
  pending: [{ name: 'Rapporto prova imbottitura Demo.pdf', type: 'application/pdf', size: 240_000 }],
  validUntil: '2027-09-30',
}

function SourcingDesign({ model }: { model: SourcingCase }) {
  return inSourcingShell(createElement(SourcingPageView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<SourcingCase>({
  screen: 'SCR-215',
  title: 'Sourcing & claims (Compliance › Sustainability)',
  view: SourcingDesign,
  cases: [
    {
      id: 'normal',
      label: 'Quality inspector: the tiles, the views and the claims',
      model: base('quality'),
      note: 'Tiles (approved, blocked by expired evidence, drafts waiting approval; LWG certificates stay Later) · views Claims | Chain of custody (Later, disabled with why) · the claims with wording, scope, evidence, the validity bar, approver, status (a blocked one in red) and where used. c drafts a claim.',
    },
    { id: 'tile-blocked', label: 'Tile "Claims with expired evidence – blocked" as the filter', model: base('quality', { claims: ready(listAnswer({ claims: [PFAS_BLOCKED] })) }, { state: 'BLOCKED' }) },
    { id: 'label-check-on', label: 'Label print checks the claims (the Owner switched CLAIM-EVIDENCE on)', model: base('quality', { claims: ready(listAnswer({ labelCheck: 'ON' })) }) },
    { id: 'retired', label: 'Rows: Retired', model: base('quality', { claims: ready(listAnswer({ claims: [RETIRED] })) }, { state: 'RETIRED' }) },
    { id: 'selected', label: 'Two rows chosen: Withdraw 2 and Export 2', model: base('quality', { selected: [RECYCLED.id, ORGANIC_SOON.id] }) },
    { id: 'withdraw-many', label: 'Withdraw 2: one reason; their uses end with them', model: base('quality', { selected: [RECYCLED.id, ORGANIC_SOON.id], withdrawMany: { ids: [RECYCLED.id, ORGANIC_SOON.id], reason: '', busy: false } }), note: 'Held "Say why it is withdrawn." until a reason is typed.' },
    { id: 'bulk-result', label: 'After Withdraw 2: one refused, said in words', model: base('quality', { notice: { tone: 'warning', key: 'bulk.withdrawnResult', params: { count: 1 }, refused: [{ label: 'CL-0005', key: 'problem.conflict' }] } }) },
    { id: 'empty', label: 'No claims yet: generic claims are not allowed without evidence', model: base('quality', { counts: ready({ approved: 0, blocked: 0, drafts: 0, retired: 0 }), claims: ready(listAnswer({ claims: [] })) }) },
    { id: 'filtered-empty', label: 'Filters match nothing: Clear filters', model: base('quality', { claims: ready(listAnswer({ claims: [] })) }, { q: 'bambù', kind: 'BIO_BASED' }) },
    { id: 'loading', label: 'Loading: each section in its shape', model: base('quality', { counts: loading, claims: loading, readAt: null }) },
    { id: 'error', label: 'Failed reads: said with Try again, never drawn as empty', model: base('quality', { counts: failed, claims: failed }) },
    { id: 'read-only', label: 'Production manager: reads; New claim held with the reason', model: base('production') },
    { id: 'read-only-role', label: 'Read-only role', model: base('readOnly') },
    { id: 'no-permission', label: 'Sales: no compliance read', model: base('sales') },
    { id: 'notice', label: 'After New claim: the notice', model: base('quality', { notice: { tone: 'success', key: 'notice.drafted', params: { code: 'CL-0007' } } }) },
    { id: 'new', label: 'New claim: empty, Create held "Choose what kind of claim it is."', model: base('quality', { add: add() }, { add: true }) },
    {
      id: 'new-refused-words',
      label: 'New claim: the checker refuses "eco-friendly" and "carbon neutral" and offers allowed wording',
      model: base('quality', { add: add({ draft: { ...filled, kind: 'RECYCLED_CONTENT', wording: { it: 'Giacca ecologica a impatto zero', en: 'Eco-friendly jacket' } } }) }, { add: true }),
      note: 'Each refused finding names its law (Annex I 4a / 4c) with "Use this wording"; Create is held until no language is refused.',
    },
    { id: 'new-lwg', label: 'New claim: "LWG certified jacket" refused, the tannery wording offered (PRD-361)', model: base('quality', { add: add({ draft: { ...filled, kind: 'CERTIFICATION_LABEL', wording: { it: '', en: 'LWG certified jacket' }, scope: 'MATERIAL', styleId: null, itemId: CHOICES.materials[0]!.id } }) }, { add: true }) },
    { id: 'new-filled', label: 'New claim: filled, a stored file and one to upload, the earliest expiry offered', model: base('quality', { add: add({ draft: filled }) }, { add: true }) },
    { id: 'new-advice', label: 'New claim: a content claim without its share is advised', model: base('quality', { add: add({ draft: { ...filled, wording: { it: 'Imbottitura in poliestere riciclato', en: '' }, pending: [] } }) }, { add: true }) },
    { id: 'new-replacement', label: 'Draft a replacement of a blocked claim', model: base('quality', { add: add({ draft: replacementOf(PFAS_BLOCKED, 'CL-0007') }) }, { add: true, replaces: PFAS_BLOCKED.id }) },
    { id: 'new-code-taken', label: 'New claim refused: the code is taken', model: base('quality', { add: add({ draft: { ...filled, code: 'CL-0001' }, problem: { key: 'refusal.CODE_TAKEN', field: 'code' } }) }, { add: true }) },
    { id: 'new-file-refused', label: 'Saved, but its file was not taken: open the draft', model: base('quality', { add: add({ draft: filled, savedWithoutFile: LWG.id, problem: { key: 'problem.unavailable', field: null } }) }, { add: true }) },
    { id: 'new-choices-failed', label: 'New claim: the choices could not be read', model: base('quality', { add: add({ choices: failed }) }, { add: true }) },
    { id: 'claim', label: 'The claim: Wording (per language, checked)', model: base('quality', { open: open() }, { open: RECYCLED.id }), note: 'J / K move through the claims; Record a use and Draft a replacement for an approved claim.' },
    { id: 'claim-evidence', label: 'The claim: Evidence with each file and its validity', model: base('quality', { open: open(ORGANIC_SOON, { tab: 'evidence' }) }, { open: ORGANIC_SOON.id, tab: 'evidence' }) },
    { id: 'claim-where', label: 'The claim: Where used (live and ended)', model: base('quality', { open: open(RECYCLED, { tab: 'where' }) }, { open: RECYCLED.id, tab: 'where' }) },
    { id: 'claim-activity', label: 'The claim: Activity', model: base('quality', { open: open(RECYCLED, { tab: 'activity' }) }, { open: RECYCLED.id, tab: 'activity' }) },
    { id: 'blocked-evidence', label: 'A blocked claim: why its evidence no longer holds', model: base('quality', { open: open(PFAS_BLOCKED, { tab: 'evidence' }) }, { open: PFAS_BLOCKED.id, tab: 'evidence' }) },
    { id: 'blocked-where', label: 'A blocked claim flags every place it is still used', model: base('quality', { open: open(PFAS_BLOCKED, { tab: 'where' }) }, { open: PFAS_BLOCKED.id, tab: 'where' }), note: 'Draft a replacement is the primary action; Record a use is held "Its evidence no longer holds…".' },
    { id: 'draft', label: 'A draft: Edit, Approve, Withdraw', model: base('quality', { open: open(LWG) }, { open: LWG.id }) },
    { id: 'approve', label: 'Approve: the sign-off with a fresh code', model: base('quality', { open: open(PFAS_REPLACEMENT, { mode: 'approve' }) }, { open: PFAS_REPLACEMENT.id, mode: 'approve' }), note: 'Says that approving withdraws CL-0003 and moves its uses here.' },
    { id: 'approve-held', label: 'Approve held: no evidence yet', model: base('quality', { open: open({ ...LWG, evidence: [] }, { mode: 'approve' }) }, { open: LWG.id, mode: 'approve' }) },
    { id: 'step-up', label: 'Approving asks for a fresh code', model: base('quality', { open: open(PFAS_REPLACEMENT, { mode: 'approve', busy: true }), stepUp: { open: true, busy: false, sentence: 'approve.sentence', problem: null } }, { open: PFAS_REPLACEMENT.id, mode: 'approve' }) },
    { id: 'approved', label: 'After Approve: the replacement took over', model: base('quality', { open: open({ ...PFAS_REPLACEMENT, status: 'APPROVED', state: 'APPROVED', approvedAt: NOW }, { saved: { key: 'saved.approvedReplacing', params: { code: 'CL-0003', count: 2 } } }) }, { open: PFAS_REPLACEMENT.id }) },
    { id: 'edit', label: 'Edit a draft: the same fields; Save held "Nothing changed."', model: base('quality', { open: open(LWG, { mode: 'edit', draft: draftOf(LWG), choices: ready(CHOICES) }) }, { open: LWG.id, mode: 'edit' }) },
    { id: 'withdraw', label: 'Withdraw: the reason; its uses end with it', model: base('quality', { open: open(RECYCLED, { mode: 'withdraw', reason: 'Il fornitore della fodera è cambiato' }) }, { open: RECYCLED.id, mode: 'withdraw' }) },
    { id: 'use', label: 'Record a use: a label or a style, named', model: base('quality', { open: open(RECYCLED, { mode: 'use', tab: 'where', choices: ready(CHOICES), use: { kind: 'CATALOGUE', recordId: CHOICES.styles[0]!.id, label: '', note: '' } }) }, { open: RECYCLED.id, mode: 'use', tab: 'where' }), note: 'Held "Name where it appears" for a catalogue until named.' },
    { id: 'retired-claim', label: 'A retired claim: Draft a replacement', model: base('quality', { open: open(RETIRED) }, { open: RETIRED.id }) },
    { id: 'claim-read-only', label: 'Production manager: every action held with the reason', model: base('production', { open: open({ ...LWG, canManage: false, canApprove: false }) }, { open: LWG.id }) },
    { id: 'claim-loading', label: 'The window loading', model: base('quality', { open: open(RECYCLED, { read: loading }) }, { open: RECYCLED.id }) },
    { id: 'claim-error', label: 'The window failed', model: base('quality', { open: open(RECYCLED, { read: failed }) }, { open: RECYCLED.id }) },
    { id: 'claim-refused', label: 'A write refused: said in the window', model: base('quality', { open: open(RECYCLED, { problem: { key: 'refusal.USE_TAKEN', field: null } }) }, { open: RECYCLED.id }) },
    { id: 'keys', label: 'Keyboard shortcuts (?)', model: base('quality', { keysOpen: true }) },
  ],
})
