import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COVERAGE, DRAFT_DE, DRAFT_EN, DRAFT_IT, GLV, inShell, JKT, listAnswer, NOW, POINTS_IT, PREFIX, COMPANY, ROLES_DEMO, ROWS, UNRECORDED, type RoleDemo } from './_demo/fixtures'
import type { Preview } from './api'
import { declarationsCan, EMPTY_ADDRESS, rowKey, type DeclarationsAddress } from './model'
import type { DeclarationsPageModel, NewState } from './view-model'
import { DeclarationsView } from './view/DeclarationsView'

/**
 * SCR-052 — Compliance › Declarations & instructions (B-W2b-268; design compliance.declarations). Made-up data only (./_demo).
 * Roles from factory-domain's templates: the quality inspector makes and checks drafts; the warehouse reads and builds packs;
 * read-only looks; sales has no compliance read. The labels and notes are English (the design index only); the screen's words
 * come from the catalogues.
 */

interface PageCase {
  role: RoleDemo
  model: DeclarationsPageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.unavailable' }

function base(role: RoleDemo, over: Partial<DeclarationsPageModel> = {}, address: Partial<DeclarationsAddress> = {}): PageCase {
  return {
    role,
    model: {
      prefix: PREFIX,
      can: declarationsCan(ROLES_DEMO[role]),
      companyId: COMPANY.id,
      companies: [{ id: COMPANY.id, code: COMPANY.code, name: COMPANY.name }],
      address: { ...EMPTY_ADDRESS, ...address },
      coverage: ready(COVERAGE),
      list: ready(listAnswer()),
      readAt: NOW,
      live: 'live',
      updates: 0,
      notice: null,
      selected: [],
      selectedCoverage: [],
      add: null,
      translate: null,
      check: null,
      unrecorded: null,
      online: true,
      ...over,
    },
  }
}

const docPreview: Preview = {
  kind: 'DECLARATION_OF_CONFORMITY',
  style: { id: JKT.id, code: JKT.code, name: JKT.name, ppeCategory: 'CATEGORY_II' },
  revision: { id: 'rev-2', revision: 2, status: 'RELEASED' },
  companyId: COMPANY.id,
  language: 'it',
  number: `DoC-${JKT.code}-IT-r2`,
  maker: { name: 'Demo Pelletteria S.r.l.', address: 'Via Esempio 1, 00000 Demoville (XX), Italia', partyId: null },
  certificate: { id: 'cert-1', number: 'CERT-DEMO-0042', body: 'Organismo Demo', bodyNumber: '0000' },
  standards: ['EN 17092-3:2020'],
  points: POINTS_IT,
  blocking: [],
  warnings: [{ code: 'SIGNATORY_TO_TYPE', point: '9', message: '' }],
  missingPhrases: [],
  existing: null,
}

const leafletPreview: Preview = {
  ...docPreview,
  kind: 'USER_INFORMATION',
  number: `UI-${JKT.code}-IT-r2`,
  sections: [
    { key: 'product', text: `Prodotto: ${JKT.name}, modello ${JKT.code}, revisione 2.`, source: { kind: 'STYLE' }, wording: null, values: [] },
    { key: 'storage', text: 'Conservazione: in un luogo asciutto, lontano dalla luce del sole.', source: { kind: 'PHRASE' }, wording: null, values: [] },
    { key: 'protectors', text: 'Protezioni: spalle livello 2, gomiti livello 1.', source: { kind: 'PROTECTOR_PLACEMENT' }, wording: null, values: [] },
  ],
  protectorPositions: [],
  spareProtectors: [],
  warnings: [{ code: 'SPARE_NOT_CERTIFIED', point: 'spares', message: '' }],
}

const add = (over: Partial<NewState> = {}): NewState => ({ styleId: null, kind: 'DECLARATION_OF_CONFORMITY', languages: [], marketCode: null, packs: [], companyId: COMPANY.id, preview: null, busy: false, problem: null, ...over })
const filled = (over: Partial<NewState> = {}) => add({ styleId: JKT.id, languages: ['it', 'en', 'de'], preview: ready(docPreview), ...over })

function PageDesign({ model }: { model: PageCase }) {
  return inShell(createElement(DeclarationsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<PageCase>({
  screen: 'SCR-052',
  title: 'Declarations & instructions (Compliance)',
  view: PageDesign,
  cases: [
    {
      id: 'normal',
      label: 'Quality inspector: the gate, the tiles, the language coverage and every declaration',
      model: base('quality'),
      note: 'GATE-PPE-TEXTS said first: generated documents are drafts; the signed PDF on the style stays the live route. Tiles are saved filters; a coverage cell opens its document or adds the language; the grid is style › kind › language with ⋯ Open, PDF, New revision, Translate, Copy public address.',
    },
    { id: 'tile-gaps', label: 'Tile "Languages missing": only rows with a missing language', model: base('quality', {}, { gaps: true }) },
    { id: 'tile-drafts', label: 'Tile "Drafts" as the grid filter', model: base('quality', { list: ready(listAnswer(ROWS.filter((row) => row.status === 'DRAFT'))) }, { status: 'DRAFT' }) },
    { id: 'selected', label: 'Two declarations chosen: CSV of 2 and Export 2', model: base('quality', { selected: [DRAFT_IT.id, DRAFT_EN.id] }) },
    { id: 'coverage-selected', label: 'Coverage rows chosen: Translate the gaps', model: base('quality', { selectedCoverage: [rowKey(COVERAGE.rows[0]!)] }), note: 'Rows without a generated original or without gaps are not selectable: their box says why.' },
    { id: 'updates', label: 'Live: 3 updates waiting behind Show', model: base('quality', { updates: 3 }) },
    { id: 'notice-gaps', label: 'After Translate the gaps: one row refused, in words', model: base('quality', { notice: { tone: 'warning', key: 'notice.gaps', params: { count: 2 }, refused: [{ label: `${GLV.code} · DoC`, key: 'refusal.NO_CERTIFICATE' }] } }) },
    { id: 'empty', label: 'Nothing yet: W1 keeps the signed DoC on the style', model: base('quality', { coverage: ready({ ...COVERAGE, rows: [], tiles: { issued: 0, drafts: 0, languagesMissing: 0, supersededIn30Days: 0, batchesShippedWithoutVersion: 0 } }), list: ready(listAnswer([])) }) },
    { id: 'filtered-empty', label: 'Filters match nothing: Clear filters', model: base('quality', { list: ready(listAnswer([])) }, { kind: 'USER_INFORMATION', status: 'ISSUED', q: 'zzz' }) },
    { id: 'loading', label: 'Loading: each part in its shape', model: base('quality', { coverage: loading, list: loading, readAt: null }) },
    { id: 'error', label: 'Failed reads: said with Try again, never drawn as empty', model: base('quality', { coverage: failed, list: failed }) },
    { id: 'offline', label: 'Offline: the last copy, writes held with the reason', model: base('quality', { online: false, live: 'offline' }) },
    { id: 'warehouse', label: 'Warehouse: reads; New declaration held with the reason', model: base('warehouse') },
    { id: 'read-only', label: 'Read-only role', model: base('readOnly') },
    { id: 'no-permission', label: 'Sales: no compliance read', model: base('sales') },
    { id: 'new', label: 'New declaration: empty, Create held "Choose the style."', model: base('quality', { add: add() }, { add: true }) },
    { id: 'new-preview', label: 'New declaration: the preview with each value\'s source', model: base('quality', { add: filled() }, { add: true }), note: 'Point 9 typed; the warning "type who signs" until the signatory is typed. Create draft (3 languages).' },
    { id: 'new-leaflet', label: 'New declaration: user information with the DE pack', model: base('quality', { add: filled({ kind: 'USER_INFORMATION', languages: ['it'], packs: ['DE'], preview: ready(leafletPreview) }) }, { add: true }) },
    { id: 'new-refused', label: 'New declaration: no valid certificate refuses it', model: base('quality', { add: filled({ styleId: GLV.id, preview: ready({ ...docPreview, style: { ...docPreview.style, id: GLV.id, code: GLV.code, name: GLV.name }, certificate: null, blocking: [{ code: 'NO_CERTIFICATE', point: '7', message: '' }] }) }) }, { add: true }) },
    { id: 'new-exists', label: 'New declaration: a draft of this revision and language exists — open it', model: base('quality', { add: filled({ preview: ready({ ...docPreview, existing: { id: DRAFT_IT.id, status: 'DRAFT' } }) }) }, { add: true }) },
    { id: 'new-loading', label: 'New declaration: reading what the records give', model: base('quality', { add: filled({ preview: loading }) }, { add: true }) },
    { id: 'new-failed', label: 'New declaration: create refused by the database', model: base('quality', { add: filled({ problem: { key: 'refusal.DATABASE', field: null } }) }, { add: true }) },
    { id: 'translate', label: 'Translate (from a row or a cell): the languages to add', model: base('quality', { translate: { originalId: DRAFT_IT.id, kind: 'DECLARATION_OF_CONFORMITY', label: `${DRAFT_IT.number} (IT)`, options: ['es', 'fr'], languages: ['fr'], busy: false, problem: null } }) },
    { id: 'language-check', label: 'Language check: per style and kind, gaps first', model: base('quality', {}, { check: true }) },
    { id: 'unrecorded', label: 'Batches shipped without a recorded version', model: base('quality', { unrecorded: { read: ready(UNRECORDED), busy: null, problem: null } }, { unrecorded: true }) },
    { id: 'unrecorded-none', label: 'Every batch recorded', model: base('quality', { unrecorded: { read: ready([]), busy: null, problem: null } }, { unrecorded: true }) },
    { id: 'unrecorded-held', label: 'Read-only: Record held with the reason', model: base('readOnly', { unrecorded: { read: ready(UNRECORDED), busy: null, problem: null } }, { unrecorded: true }) },
    { id: 'translations-to-type', label: 'Rows with words still to type (DE)', model: base('quality', { list: ready(listAnswer([DRAFT_IT, DRAFT_DE])) }) },
    { id: 'keys', label: 'Keyboard shortcuts (?)', model: base('quality', { keysOpen: true }) },
  ],
})
