import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { docDetail, DRAFT_DE, DRAFT_IT, DRAFT_PDF, inShell, leafletDetail, LUCA, MARTA, NOW, PREFIX, RECORD_DE, RECORD_DRAFT, RECORD_EN, RECORD_LEAFLET, RECORD_SIGNED, ROLES_DEMO, type RoleDemo } from '../_demo/fixtures'
import { declarationsCan, draftOf, recordOfDeclaration, recordOfLeaflet, type RecordAddress, type RecordDoc } from '../model'
import type { RecordModel } from '../view-model'
import { RecordView } from '../view/RecordView'

/**
 * SCR-052-record — a declaration or a leaflet of Compliance › Declarations & instructions (B-W2b-268; design
 * compliance.declarations › rec:Declaration). Made-up data only (../_demo). The PDF beside the fields is a small made-up PDF.
 */

interface RecordCase {
  role: RoleDemo
  model: RecordModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })

function base(role: RoleDemo, record: RecordDoc, over: Partial<RecordModel> = {}, address: Partial<RecordAddress> = {}): RecordCase {
  return {
    role,
    model: {
      prefix: PREFIX,
      can: declarationsCan(ROLES_DEMO[role]),
      userId: MARTA.id,
      address: { tab: 'content', dialog: null, edit: false, ...address },
      read: ready(record),
      readAt: NOW,
      live: 'live',
      changedAt: null,
      notice: null,
      preview: { documentId: record.row.id, pdf: ready<Uint8Array | string>(DRAFT_PDF) },
      draft: null,
      busy: false,
      problem: null,
      reason: '',
      typed: '',
      translateLanguages: [],
      translatePacks: [],
      marketLanguages: ['de', 'en', 'fr', 'it'],
      online: true,
      ...over,
    },
  }
}

const stale = recordOfDeclaration(docDetail(DRAFT_IT, { stale: { differences: [{ point: '6', stored: 'EN 17092-3:2020', fresh: 'EN 17092-3:2020/A1:2024' }, { point: '7', stored: null, fresh: null }], problems: [] } }))
const refused = recordOfDeclaration(docDetail(DRAFT_IT, { problems: [{ code: 'NO_CERTIFICATE', point: '7', message: '' }, { code: 'POINT8_TO_TYPE', point: '8', message: '' }] }))
const readyToCheck = recordOfDeclaration(docDetail({ ...DRAFT_DE, pointsToType: [], translationStatus: 'DRAFT' }, { points: docDetail(DRAFT_IT).points.map((point) => ({ ...point, text: `[de] ${point.text}`, source: point.point === '3' ? { kind: 'TYPED', recordType: 'User', recordId: LUCA.id } : point.source })) }))
const withdrawn = recordOfDeclaration(docDetail({ ...DRAFT_IT, status: 'WITHDRAWN' }, { may: { edit: false, refresh: false, translate: false, check: false, withdraw: false } }))
const readOnly = (record: RecordDoc): RecordDoc => ({ ...record, may: { edit: false, refresh: false, translate: false, check: false, withdraw: false } })

function RecordDesign({ model }: { model: RecordCase }) {
  return inShell(createElement(RecordView, { model: model.model }), model.role, '/compliance/declarations/[id]')
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-052-record',
  title: 'Declaration or user information (Compliance › Declarations & instructions)',
  view: RecordDesign,
  cases: [
    {
      id: 'content',
      label: 'A generated DoC draft: the nine Annex IX points with their sources, the PDF beside',
      model: base('quality', RECORD_DRAFT),
      note: 'The band: Issue… opens the review (issuing held: GATE-PPE-TEXTS), ⋯ Translate, Refresh, Withdraw, the PDF and the public page in new tabs. Each value names where it came from (SourceIndicator; a record opens in a new tab).',
    },
    { id: 'edit', label: 'Content in edit mode: points, signatory, number; Save with ⌘S', model: base('quality', RECORD_DRAFT, { draft: { ...draftOf(RECORD_DRAFT), parts: { ...draftOf(RECORD_DRAFT).parts, '8': 'Non applicabile: DPI di categoria II (modulo B).' } } }, { edit: true }) },
    { id: 'edit-empty', label: 'Edit: a point emptied — Save held with the reason', model: base('quality', RECORD_DRAFT, { draft: { ...draftOf(RECORD_DRAFT), parts: { ...draftOf(RECORD_DRAFT).parts, '3': '' } } }, { edit: true }) },
    { id: 'stale', label: 'The records changed: refresh (typed words kept)', model: base('quality', stale) },
    { id: 'refused', label: 'What refuses the draft and what to check, in words', model: base('quality', refused) },
    { id: 'leaflet', label: 'User information: Annex II 1.4 sections, protector positions and certified spares', model: base('quality', RECORD_LEAFLET), note: 'The spare protectors changed (a certificate): refresh.' },
    { id: 'translation-to-type', label: 'A German translation with points 3 and 9 still to type', model: base('quality', RECORD_DE, { preview: { documentId: DRAFT_DE.id, pdf: ready<Uint8Array | string>(DRAFT_PDF) } }) },
    { id: 'translation-check', label: 'A translation ready: Check translation (a second person)', model: base('quality', readyToCheck, {}, { dialog: 'check' }) },
    { id: 'check-own-words', label: 'Check held: you typed words of it', model: base('quality', readyToCheck, { userId: LUCA.id }, { dialog: 'check' }) },
    { id: 'checked', label: 'A checked translation: still a draft; send back to the translator', model: base('quality', RECORD_EN, {}, { tab: 'languages' }) },
    { id: 'signed', label: 'A signed DoC (W1 upload): its file, issued, nothing to type', model: base('quality', RECORD_SIGNED) },
    { id: 'languages', label: 'Languages: each language, its state, who checked it, what is to type', model: base('quality', RECORD_DRAFT, {}, { tab: 'languages' }) },
    { id: 'leaflet-languages', label: 'User information › Languages with the packs per market', model: base('quality', RECORD_LEAFLET, {}, { tab: 'languages' }) },
    { id: 'batches', label: 'Versions by batch: revisions on a timeline, batches and DDTs', model: base('quality', RECORD_SIGNED, {}, { tab: 'batches' }) },
    { id: 'batches-none', label: 'Versions by batch: none recorded yet', model: base('quality', RECORD_DRAFT, {}, { tab: 'batches' }) },
    { id: 'publication', label: 'Publication: the public address and its QR, labels, packs sent', model: base('quality', RECORD_SIGNED, {}, { tab: 'publication' }) },
    { id: 'issue', label: 'Issue: the review, and why a generated DoC is not issued here', model: base('quality', RECORD_DRAFT, {}, { dialog: 'issue' }), note: 'Owner 11-09 (GATE-PPE-TEXTS = B): the final button is held with the reason; the signed upload on the style is the route.' },
    { id: 'issue-signed', label: 'Issue on a signed DoC: issued already', model: base('quality', RECORD_SIGNED, {}, { dialog: 'issue' }) },
    { id: 'translate', label: 'Translate: languages to add', model: base('quality', RECORD_DRAFT, { translateLanguages: ['fr'] }, { dialog: 'translate' }) },
    { id: 'translate-leaflet', label: 'Translate user information: languages or a market pack', model: base('quality', RECORD_LEAFLET, { translatePacks: ['DE'] }, { dialog: 'translate' }) },
    { id: 'withdraw', label: 'Withdraw: the reason and the typed number', model: base('quality', RECORD_DRAFT, { reason: 'Sostituita dalla revisione 3', typed: 'DoC-GIA' }, { dialog: 'withdraw' }), note: 'Held "Type the confirmation exactly." until the number is typed; its two draft translations go with it.' },
    { id: 'refresh', label: 'Refresh from the records', model: base('quality', stale, {}, { dialog: 'refresh' }) },
    { id: 'withdrawn', label: 'A withdrawn draft', model: base('quality', withdrawn) },
    { id: 'conflict', label: 'Save refused: someone changed it meanwhile', model: base('quality', RECORD_DRAFT, { problem: { key: 'problem.conflict', field: null } }) },
    { id: 'changed', label: 'Live: changed while typing — Read again', model: base('quality', RECORD_DRAFT, { changedAt: NOW, draft: draftOf(RECORD_DRAFT) }, { edit: true }) },
    { id: 'pdf-failed', label: 'The PDF could not be read', model: base('quality', RECORD_DRAFT, { preview: { documentId: RECORD_DRAFT.row.id, pdf: { status: 'error', problem: 'problem.unavailable' } } }) },
    { id: 'signed-no-file', label: 'A signed document without its PDF yet', model: base('quality', RECORD_SIGNED, { preview: { documentId: RECORD_SIGNED.row.id, pdf: { status: 'error', problem: 'preview.noFile' } } }) },
    { id: 'read-only', label: 'Read-only role: every action held with the reason', model: base('readOnly', readOnly(RECORD_DRAFT)) },
    { id: 'offline', label: 'Offline: writes held', model: base('quality', RECORD_DRAFT, { online: false, live: 'offline' }) },
    { id: 'leaflet-loading', label: 'Loading', model: base('quality', recordOfLeaflet(leafletDetail()), { read: { status: 'loading' } }) },
    { id: 'not-found', label: 'Not found (another company, or removed)', model: base('quality', RECORD_DRAFT, { read: { status: 'error', problem: 'problem.notFound' } }) },
    { id: 'error', label: 'Failed read: Try again', model: base('quality', RECORD_DRAFT, { read: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'no-permission', label: 'Sales: no compliance read', model: base('sales', RECORD_DRAFT) },
  ],
})
