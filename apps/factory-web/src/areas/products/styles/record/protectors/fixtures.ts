import { REVISIONS, STYLE_ID, SIZES } from '../../demo/fixtures'
import type { PlacementView, ProtectorPlacementView } from './api'
import { NO_PROTECTORS, type ProtectorsModel } from './protectors-model'

/**
 * Made-up data for SCR-287's Protector placement section (B-W2b-233): DEMO-JKT-01 revision 3 (draft) with a shoulder, an
 * elbow and a back pocket. Its BOM has the shoulder protector only; the elbow protector has no certificate; the shoulder
 * pocket covers 46–54 while the BOM uses the shoulder protector in every size. Every code and name is invented.
 */

const uid = (n: number) => `0190f0e2-6262-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()

export const PROTECTOR = { shoulder: uid(901), limb: uid(902), back: uid(903), hip: uid(904) }

type Revision = (typeof REVISIONS)[number]

const placement = (n: number, pocket: PlacementView['pocket'], protectorId: string, code: string, name: string, standard: string, level: PlacementView['level'], sizes: string[] = [], positionNote: string | null = null): PlacementView => ({
  id: uid(n),
  seq: n,
  pocket,
  protector: { id: protectorId, code, name, approval: 'APPROVED', standard: code === 'DEMO-PRO-L1' ? null : standard, level: code === 'DEMO-PRO-L1' ? null : level },
  standard,
  level,
  sizes,
  positionNote,
  version: 2,
  updatedAt: at(27, 15),
})

export const PLACEMENTS: PlacementView[] = [
  placement(1, 'SHOULDER', PROTECTOR.shoulder, 'DEMO-PRO-S2', 'Protezione spalla livello 2', 'EN 1621-1:2012', '2', ['46', '48', '50', '52', '54'], 'Destra e sinistra, nella testa manica'),
  placement(2, 'ELBOW', PROTECTOR.limb, 'DEMO-PRO-L1', 'Protezione gomito livello 1', 'EN 1621-1:2012', '1', [], 'Tasca con velcro, 2 cm sopra la cucitura'),
  placement(3, 'BACK', PROTECTOR.back, 'DEMO-PRO-B1', 'Paraschiena livello 1', 'EN 1621-2:2014', '1'),
]

const CHOICES: ProtectorPlacementView['choices'] = [
  { id: PROTECTOR.back, code: 'DEMO-PRO-B1', name: 'Paraschiena livello 1', approval: 'APPROVED', standard: 'EN 1621-2:2014', level: '1', inBom: false },
  { id: PROTECTOR.hip, code: 'DEMO-PRO-H1', name: 'Protezione anca livello 1', approval: 'CONDITIONAL', standard: 'EN 1621-1:2012', level: '1', inBom: false },
  { id: PROTECTOR.limb, code: 'DEMO-PRO-L1', name: 'Protezione gomito livello 1', approval: 'PENDING', standard: null, level: null, inBom: false },
  { id: PROTECTOR.shoulder, code: 'DEMO-PRO-S2', name: 'Protezione spalla livello 2', approval: 'APPROVED', standard: 'EN 1621-1:2012', level: '2', inBom: true },
]

const FINDINGS: ProtectorPlacementView['findings'] = [
  { code: 'NOT_IN_BOM', placementId: uid(2), itemId: PROTECTOR.limb, sizes: SIZES, params: { pocket: 'ELBOW', item: 'DEMO-PRO-L1', seq: '2', standard: 'EN 1621-1:2012', asked: '1' }, message: 'x' },
  { code: 'NO_ITEM_CERTIFICATE', placementId: uid(2), itemId: PROTECTOR.limb, sizes: SIZES, params: { pocket: 'ELBOW', item: 'DEMO-PRO-L1', seq: '2', standard: 'EN 1621-1:2012', asked: '1' }, message: 'x' },
  { code: 'NOT_IN_BOM', placementId: uid(3), itemId: PROTECTOR.back, sizes: SIZES, params: { pocket: 'BACK', item: 'DEMO-PRO-B1', seq: '3', standard: 'EN 1621-2:2014', asked: '1' }, message: 'x' },
  { code: 'STYLE_CERTIFICATE_LEVEL', placementId: uid(3), itemId: PROTECTOR.back, sizes: SIZES, params: { pocket: 'BACK', certificate: 'DEMO-CE-0042', level: '2', asked: '1', seq: '3', item: 'DEMO-PRO-B1' }, message: 'x' },
  { code: 'BOM_NOT_PLACED', placementId: null, itemId: PROTECTOR.shoulder, sizes: ['56', '58'], params: { item: 'DEMO-PRO-S2', seq: '60', sizes: '56, 58', all: 'no' }, message: 'x' },
]

export function demoProtectors(options: { revision?: Revision; empty?: boolean; agree?: boolean; rule?: boolean } = {}): ProtectorPlacementView {
  const rev = options.revision ?? REVISIONS[0]!
  const draft = rev.status === 'DRAFT'
  const placements = options.empty ? [] : options.agree ? PLACEMENTS.map((entry) => (entry.pocket === 'SHOULDER' ? { ...entry, sizes: [] } : entry)) : PLACEMENTS
  const refusal = !draft ? `Revision ${rev.revision} is ${rev.status.toLowerCase()}: its protector placement is frozen.` : options.rule ? 'Style DEMO-JKT-01 is discontinued: nothing of it changes in this state.' : null
  return {
    revision: { id: rev.id, styleId: STYLE_ID, revision: rev.revision, status: rev.status, changeNote: rev.changeNote, plannedHideYieldPct: '82', labelTemplateId: rev.labelTemplateId, releasedAt: rev.releasedAt, releasedById: rev.releasedById, version: rev.version, createdAt: rev.createdAt, updatedAt: rev.updatedAt },
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ACTIVE', sizes: SIZES },
    placements,
    findings: options.empty || options.agree ? [] : FINDINGS,
    choices: CHOICES,
    editable: refusal === null,
    refusal,
    words: 'x',
  }
}

export const readyProtectors = (view: ProtectorPlacementView, extra: Partial<ProtectorsModel> = {}): ProtectorsModel => ({ ...NO_PROTECTORS, part: { status: 'ready', value: view }, ...extra })
