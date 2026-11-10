import { at, uid } from '../../library/demo'
import { ROLE_PERMISSIONS, type RoleCase } from '../../library/demo'
import { LEATHER, PROTECTOR, ROWS, TEXTILE } from '../demo'
import type { MaterialApprovalsView } from './api'
import { depthCan, type MaterialDepthModel, type MaterialDepthView, type MaterialWhereUsedView } from './depth-model'

/**
 * Design-only made-up data of materials in depth (B-W2b-238; SCR-047, SCR-048, SCR-045): the lining DEMO-LN-MESH typed as a
 * fabric (220 g/m², 150 cm, knitted) whose composition says "nylon" (not the official name), approved on a condition; the
 * protector DEMO-PR-SH2 (EN 1621-1:2012 shoulder level 2), approved; the leather DEMO-PL-NAP12, used in two made-up styles
 * and three revisions with two open work orders. Every name, code and person is invented ("Demo").
 */

const person = { id: uid('4790', 1), name: 'Giulia Demo' }
const ref = (material: { id: string; code: string; name: string; kind: string; companyId: string | null; status: string; version: number }) => ({
  id: material.id,
  code: material.code,
  name: material.name,
  kind: material.kind as MaterialDepthView['material']['kind'],
  companyId: material.companyId,
  status: material.status as MaterialDepthView['material']['status'],
  version: material.version,
})
const REACH = { styles: 2, draftRevisions: 1, releasedRevisions: 2, openWorkOrders: 2 }
const consequences = ['No new BOM line takes it.', '1 draft revision(s) naming it cannot be released until it is replaced or approved again.', '2 released revision(s) keep it as they are, and their 2 open work order(s) go on.']

export const LINING_DEPTH: MaterialDepthView = {
  material: ref(TEXTILE),
  properties: { shape: 'TEXTILE', keys: ['weightGsm', 'widthCm', 'construction'], values: { weightGsm: '220', widthCm: '150', construction: 'knitted' } },
  fibres: [
    { fibre: 'nylon', percent: '88', annexFibre: 'polyamide', official: { it: 'poliammide', en: 'polyamide' }, finding: 'NOT_OFFICIAL', message: 'nylon is not the official name: the label says polyamide.' },
    { fibre: 'elastane', percent: '12', annexFibre: 'elastane', official: { it: 'elastan', en: 'elastane' }, finding: null, message: null },
  ],
  approval: { approval: 'CONDITIONAL', note: 'Only away from the skin until the mill sends its test report (made-up).', decidedAt: at(12, 10), decidedBy: person },
  reach: REACH,
  consequences,
}

export const PROTECTOR_DEPTH: MaterialDepthView = {
  material: ref(PROTECTOR),
  properties: { shape: 'PROTECTOR', keys: ['standard', 'type', 'level', 'size'], values: { standard: 'EN 1621-1:2012', type: 'shoulder', level: '2', size: 'A' } },
  fibres: [],
  approval: { approval: 'APPROVED', note: null, decidedAt: at(8, 9), decidedBy: person },
  reach: { styles: 3, draftRevisions: 1, releasedRevisions: 3, openWorkOrders: 4 },
  consequences: [],
}

export const LEATHER_DEPTH: MaterialDepthView = {
  material: ref(LEATHER),
  properties: { shape: null, keys: [], values: null },
  fibres: [],
  approval: { approval: 'PENDING', note: null, decidedAt: null, decidedBy: null },
  reach: REACH,
  consequences,
}

const STYLES = {
  touring: { id: uid('4791', 1), code: 'DEMO-JKT-01', name: 'Giacca touring demo', companyId: null, status: 'ACTIVE' },
  racing: { id: uid('4791', 2), code: 'DEMO-JKT-07', name: 'Giacca racing esempio', companyId: null, status: 'ACTIVE' },
}
const BLK = { id: LEATHER.colours[0]!.id, code: 'BLK', name: 'Nero' }
const RED = { id: LEATHER.colours[1]!.id, code: 'RED', name: 'Rosso corsa' }
const orders = [
  { id: uid('4792', 1), number: 'OL-DEMO-0041', status: 'IN_PROGRESS', siteId: uid('2222', 1) },
  { id: uid('4792', 2), number: 'OL-DEMO-0044', status: 'RELEASED', siteId: uid('2222', 1) },
]

export const WHERE_USED: MaterialWhereUsedView = {
  material: ref(LEATHER),
  stylesAllowed: true,
  workOrdersAllowed: true,
  summary: { styles: 2, draftRevisions: 1, releasedRevisions: 1, obsoleteRevisions: 1, lines: 4, alternates: 1, openWorkOrders: 2 },
  colours: [
    { colour: BLK, status: 'ACTIVE', lines: 4 },
    { colour: RED, status: 'ACTIVE', lines: 2 },
    { colour: { id: LEATHER.colours[2]!.id, code: 'WHT', name: 'Bianco' }, status: 'ACTIVE', lines: 0 },
  ],
  itemColourId: null,
  rows: [
    { lineId: uid('4793', 1), role: 'LINE', priority: null, style: STYLES.touring, revision: { id: uid('4794', 3), revision: 3, status: 'DRAFT' }, seq: 10, placement: 'Front and back panels', section: 'SHELL', colour: null, colourways: [{ colourwayId: uid('4795', 1), colourwayCode: 'BLK', colour: BLK }, { colourwayId: uid('4795', 2), colourwayCode: 'RED', colour: RED }], openWorkOrders: [] },
    { lineId: uid('4793', 2), role: 'LINE', priority: null, style: STYLES.touring, revision: { id: uid('4794', 2), revision: 2, status: 'RELEASED' }, seq: 10, placement: 'Front and back panels', section: 'SHELL', colour: null, colourways: [{ colourwayId: uid('4795', 1), colourwayCode: 'BLK', colour: BLK }, { colourwayId: uid('4795', 2), colourwayCode: 'RED', colour: RED }], openWorkOrders: orders },
    { lineId: uid('4793', 3), role: 'ALTERNATE', priority: 1, style: STYLES.racing, revision: { id: uid('4794', 7), revision: 1, status: 'DRAFT' }, seq: 20, placement: 'Sleeve inserts', section: 'SHELL', colour: BLK, colourways: [], openWorkOrders: [] },
    { lineId: uid('4793', 4), role: 'LINE', priority: null, style: STYLES.touring, revision: { id: uid('4794', 1), revision: 1, status: 'OBSOLETE' }, seq: 10, placement: 'Front and back panels', section: null, colour: BLK, colourways: [], openWorkOrders: [] },
  ],
  more: false,
}

/** The record's depth model for a role, with each part as given. */
export function depthModel(role: RoleCase, over: Partial<MaterialDepthModel> = {}): MaterialDepthModel {
  return {
    can: depthCan(ROLE_PERMISSIONS[role]),
    depth: { status: 'ready', value: LINING_DEPTH },
    whereUsed: { status: 'ready', value: WHERE_USED },
    colourId: null,
    busy: false,
    offline: false,
    refused: null,
    notice: null,
    ...over,
  }
}

/** The list's rows with their approval and how many styles use each (made up). */
const APPROVALS = ['APPROVED', 'APPROVED', 'CONDITIONAL', 'CONDITIONAL', 'PENDING', 'BLOCKED', 'APPROVED', 'PENDING', 'APPROVED'] as const
const USED = [2, 1, 3, 2, 5, 0, 3, 0, 0]
export const ROWS_IN_DEPTH = ROWS.map((row, index) => ({ ...row, approval: APPROVALS[index] ?? 'PENDING', usedInStyles: USED[index] ?? 0 }))

/** The style's Compliance › Blocked or unapproved materials of a draft revision (made up). */
export const STYLE_APPROVALS: MaterialApprovalsView = {
  style: { id: uid('4791', 1), code: 'DEMO-JKT-01' },
  revision: { id: uid('4794', 3), revision: 3, status: 'DRAFT' },
  materials: [
    { itemId: ROWS[5]!.id, code: ROWS[5]!.code, name: ROWS[5]!.name, kind: 'HARDWARE', approval: 'BLOCKED', note: 'Nickel release above the limit in the supplier test (made-up).', isPpeComponent: false, lines: [40], alternateOnly: false },
    { itemId: ROWS[3]!.id, code: ROWS[3]!.code, name: ROWS[3]!.name, kind: 'LINING', approval: 'CONDITIONAL', note: 'Only away from the skin until the mill sends its test report (made-up).', isPpeComponent: false, lines: [20], alternateOnly: false },
    { itemId: ROWS[7]!.id, code: ROWS[7]!.code, name: ROWS[7]!.name, kind: 'LABEL', approval: 'PENDING', note: null, isPpeComponent: false, lines: [60], alternateOnly: false },
    { itemId: ROWS[0]!.id, code: ROWS[0]!.code, name: ROWS[0]!.name, kind: 'LEATHER', approval: 'APPROVED', note: null, isPpeComponent: false, lines: [10], alternateOnly: false },
    { itemId: ROWS[6]!.id, code: ROWS[6]!.code, name: ROWS[6]!.name, kind: 'PROTECTOR', approval: 'APPROVED', note: null, isPpeComponent: true, lines: [30], alternateOnly: false },
  ],
  counts: { blocked: 1, conditional: 1, pending: 1, approved: 2 },
  releasable: false,
}
