import { createElement, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../quality/_shared/fixtures'
import { BUILT_PACK, BUILDING_PACK, FILES, LIST, NOW, STYLES } from './_demo/fixtures'
import type { ListAnswer } from './api'
import { emptyPack, EMPTY_ADDRESS, failed, LOADING, ready, techfilesCan, type ListAddress, type Read } from './model'
import type { PackDialogModel } from './view/PackDialog'
import { TechFilesView, type TechFilesModel } from './view/TechFilesView'

/**
 * SCR-120 — Compliance › Technical files with made-up styles, certificates, batches and packs only ("Demo" names, DEMO- codes):
 * the owner's list (tiles and grid), each tile as a filter, nothing matching, no file yet, loading (skeletons, "Still loading"),
 * a failed read (the tiles and the grid say so), offline (writes held with the reason), live changes waiting, rows chosen
 * (Export N, Build evidence pack, Archive N), New technical file (and a style that already has one), Archive N, Build evidence
 * pack (the draft, a refusal, building with JobProgress, built with its documents), the keys, and the roles: quality
 * inspector, production manager (reads, changes nothing), read only, and sales (no right).
 */

export interface ListDesignModel {
  readonly role: RoleCase
  readonly list: Read<ListAnswer>
  readonly over?: Partial<TechFilesModel>
}

function ListDesign({ model }: { model: ListDesignModel }) {
  const [address, setAddress] = useState<ListAddress>(model.over?.address ?? EMPTY_ADDRESS)
  const [selected, setSelected] = useState<readonly string[]>(model.over?.selected ?? [])
  const view: TechFilesModel = {
    prefix: PREFIX,
    can: techfilesCan(ROLE_PERMISSIONS[model.role]),
    address,
    list: model.list,
    online: true,
    live: 'live',
    readAt: model.list.status === 'ready' ? NOW : null,
    updates: 0,
    selected,
    notice: null,
    add: null,
    archive: null,
    pack: null,
    ...model.over,
  }
  return inShell(
    '/compliance/techfiles',
    createElement(TechFilesView, {
      model: { ...view, address, selected },
      actions: { onAddress: (patch) => setAddress((now) => ({ ...now, ...patch })), onSelected: (ids) => setSelected(ids) },
    }),
    model.role,
  )
}

const ready_ = ready(LIST)
const list = (role: RoleCase, over: Partial<TechFilesModel> = {}, read: Read<ListAnswer> = ready_): ListDesignModel => ({ role, list: read, over })
const target = { id: FILES[0]!.id, number: FILES[0]!.number, style: { code: STYLES.jacket.code, name: STYLES.jacket.name } }
const packModel = (over: Partial<PackDialogModel> = {}): PackDialogModel => ({
  file: target,
  draft: emptyPack('it', 'LOT-DEMO-0044'),
  parties: ready([
    { id: '0190f0e2-7417-7000-8000-000000000001', code: 'DEMO-AUT-DE', name: 'Marktaufsicht Demo' },
    { id: '0190f0e2-7417-7000-8000-000000000002', code: 'DEMO-AUT-IT', name: 'Autorità di vigilanza Demo' },
  ]),
  shipments: ready([{ id: '0190f0e2-7422-7000-8000-000000000001', number: 'SH-DEMO-0042', partyName: 'Cliente Demo S.r.l.', status: 'SHIPPED' }]),
  busy: false,
  problem: null,
  pack: null,
  startedAt: null,
  online: true,
  held: null,
  ...over,
})

export const designScreen = defineDesignScreen<ListDesignModel>({
  screen: 'SCR-120',
  title: 'Technical files',
  view: ListDesign,
  holdsPage: true,
  cases: [
    { id: 'normal', label: 'Owner: tiles and the grid of five files', model: list('owner'), note: 'The Annex III bar, risk, tests, production control (2 of 4 batches) and the row verbs.' },
    { id: 'tile-items', label: 'Tile "Items missing" pressed (a saved filter)', model: list('owner', { address: { ...EMPTY_ADDRESS, tile: 'ITEMS_MISSING' } }, ready({ ...LIST, files: [FILES[0]!, FILES[2]!, FILES[4]!] })) },
    { id: 'tile-batches', label: 'Tile "Batches without evidence" pressed', model: list('owner', { address: { ...EMPTY_ADDRESS, tile: 'BATCHES_WITHOUT_EVIDENCE' } }, ready({ ...LIST, files: [FILES[0]!] })) },
    { id: 'filtered-none', label: 'Filters that match nothing: Clear filters', model: list('owner', { address: { ...EMPTY_ADDRESS, q: 'XYZ', status: 'ARCHIVED' } }, ready({ ...LIST, files: [] })) },
    { id: 'empty', label: 'No technical file yet: New technical file', model: list('owner', {}, ready({ ...LIST, files: [], tiles: { complete: 0, withItemsMissing: 0, itemsMissing: 0, batchesWithoutEvidence: 0, retentionEndingInYear: 0, onLegalHold: 0, authorityPacksSentThisYear: 0 } })) },
    { id: 'loading', label: 'Loading: skeletons, "Still loading" after a second', model: list('owner', {}, LOADING) },
    { id: 'error', label: 'The read failed: the tiles and the grid say so, Try again', model: list('owner', {}, failed('problem.unavailable')) },
    { id: 'offline', label: 'Offline: the last copy, writes held with the reason', model: list('owner', { online: false, live: 'offline' }) },
    { id: 'updates', label: 'Live changes waiting: "3 updates · Show"', model: list('owner', { updates: 3 }) },
    { id: 'selected', label: 'Two rows chosen: Export 2, Archive 2', model: list('owner', { selected: [FILES[0]!.id, FILES[2]!.id] }) },
    { id: 'selected-one', label: 'One row chosen: Build evidence pack from the toolbar', model: list('owner', { selected: [FILES[1]!.id] }) },
    {
      id: 'new',
      label: 'New technical file: the style picker',
      model: list('owner', { add: { q: '', styles: ready([STYLES.gloves, STYLES.vest, STYLES.suit].map((style) => ({ id: style.id, code: style.code, name: style.name, companyId: null, ppeCategory: style.ppeCategory }))), styleId: STYLES.gloves.id, note: '', busy: false, problem: null, existing: null } }),
    },
    {
      id: 'new-existing',
      label: 'New technical file: the style has a live file (open that one)',
      model: list('owner', { add: { q: '', styles: ready([{ id: STYLES.suit.id, code: STYLES.suit.code, name: STYLES.suit.name, companyId: null, ppeCategory: STYLES.suit.ppeCategory }]), styleId: STYLES.suit.id, note: '', busy: false, problem: null, existing: { id: FILES[1]!.id, number: FILES[1]!.number } } }),
    },
    { id: 'archive', label: 'Archive 2: one reason for both', model: list('owner', { selected: [FILES[0]!.id, FILES[2]!.id], archive: { ids: [FILES[0]!.id, FILES[2]!.id], reason: '', busy: false } }) },
    {
      id: 'archived-some',
      label: 'Archive N: a receipt with what was refused',
      model: list('owner', { notice: { tone: 'warning', key: 'done.archivedSome', params: { count: 1, refused: 1 }, detail: ['TF-DEMO-0003: The file is being changed by someone else.'] } }),
    },
    { id: 'pack', label: 'Build evidence pack: for whom, language, scope, contents (all on)', model: list('owner', { pack: packModel() }) },
    { id: 'pack-held', label: 'Build evidence pack held: no recipient yet (the reason on the button)', model: list('owner', { pack: packModel({ draft: { ...emptyPack('de'), recipient: '' } }) }) },
    {
      id: 'pack-refused',
      label: 'Build evidence pack refused: the scope names no batch of the style',
      model: list('owner', { pack: packModel({ draft: { ...emptyPack('de'), recipient: 'Marktaufsicht Demo', scope: 'BATCHES', batchNumbers: 'LOT-NONE' }, problem: { tone: 'danger', key: 'pack.refused', detail: ['No work order of style DEMO-JKT-01 has batch LOT-NONE.'] } }) }),
    },
    { id: 'pack-building', label: 'Building: JobProgress, the dialog can be left', model: list('owner', { pack: packModel({ pack: BUILDING_PACK, startedAt: Date.parse(NOW) - 8000 }) }) },
    { id: 'pack-built', label: 'Built: every document with its fingerprint, Open the PDF, Send by link', model: list('owner', { pack: packModel({ pack: BUILT_PACK }) }) },
    { id: 'keys', label: 'The keys (?)', model: list('owner', { keysOpen: true }) },
    { id: 'inspector', label: 'Quality inspector (keeps the files)', model: list('inspector') },
    { id: 'production', label: 'Production manager: reads, changes nothing (held with the reason)', model: list('production') },
    { id: 'read-only', label: 'Read only: New technical file held', model: list('readOnly', {}, ready({ ...LIST, mayCreate: false, files: LIST.files.map((row) => ({ ...row, may: { manage: false, sign: false, share: false } })) })) },
    { id: 'sales', label: 'Sales: no right (says which and who grants it)', model: list('sales') },
  ],
})
