import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { COLOURWAY_IDS, demoStyle, recordModel, REV, REVISIONS, SIZES, STYLE_ID } from '../../demo/fixtures'
import type { StyleRecordViewModel } from '../record-model'
import { StyleRecordView } from '../view/StyleRecordView'
import { demoProtectors, PLACEMENTS, PROTECTOR, readyProtectors } from '../protectors/fixtures'
import { markKey as placementMark } from '../protectors/protectors-model'
import type { PrepackView, StylePrepacksView } from './api'
import { draftOf, markKey, NO_PREPACKS, type PrepacksModel } from './prepacks-model'

/**
 * SCR-287 (new id, B-W2b-233) — Style › Sizes & measurements of DEMO-JKT-01 (design products.styles rec:Style tab
 * style.sizes): the Prepacks section (style.sizes.prepacks, PRD-055) and the Protector placement section
 * (style.sizes.protectors, PRD-074) — made-up data only: the style made in 46–58 on scale EU-46-58 (44–60), packs of the
 * style (2-3-3-2, by colourway, an archived one) and of the scale (one the style cannot sell: 44 and 60), revision 3 (draft)
 * with three pockets and what the BOM and the certificates do not agree on.
 */

const uid = (n: number) => `0190f0e2-6161-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()
const SCALE = { id: '0190f0e2-6161-7000-8000-000000000900', code: 'EU-46-58', name: 'Giacche EU 46–58 (demo)' }
const SCALE_SIZES = ['44', ...SIZES, '60']
const CW = [
  { id: COLOURWAY_IDS.BLK, code: 'NERO', name: 'Nero', status: 'ACTIVE' as const },
  { id: COLOURWAY_IDS.ANT, code: 'ANTR', name: 'Antracite', status: 'ACTIVE' as const },
  { id: COLOURWAY_IDS.RED, code: 'ROSSO', name: 'Rosso corsa', status: 'ACTIVE' as const },
  { id: COLOURWAY_IDS.SND, code: 'SABB', name: 'Sabbia', status: 'ARCHIVED' as const },
]

type Line = { size: string; quantity: number; colour?: (typeof CW)[number] }
function pack(n: number, code: string, name: string, scope: PrepackView['scope'], lines: Line[], extra: Partial<PrepackView> = {}): PrepackView {
  const order = scope === 'SCALE' ? SCALE_SIZES : SIZES
  const totals = order.flatMap((size) => {
    const quantity = lines.filter((line) => line.size === size).reduce((sum, line) => sum + line.quantity, 0)
    return quantity > 0 ? [{ size, quantity }] : []
  })
  const first = order.indexOf(totals[0]!.size)
  const last = order.indexOf(totals[totals.length - 1]!.size)
  const outside = [...new Set(lines.map((line) => line.size))].filter((size) => !SIZES.includes(size))
  const status = extra.status ?? 'ACTIVE'
  return {
    id: uid(n),
    code,
    name,
    scope,
    styleId: scope === 'STYLE' ? STYLE_ID : null,
    sizeScale: SCALE,
    status,
    lines: lines.map((line) => ({ size: line.size, colourwayId: line.colour?.id ?? null, colourway: line.colour ? { id: line.colour.id, code: line.colour.code, name: line.colour.name } : null, quantity: line.quantity })),
    bySize: totals,
    ratio: order
      .slice(first, last + 1)
      .map((size) => totals.find((entry) => entry.size === size)?.quantity ?? 0)
      .join('-'),
    pieces: lines.reduce((sum, line) => sum + line.quantity, 0),
    byColourway: lines.some((line) => !!line.colour),
    outsideRange: outside,
    usable: status === 'ACTIVE' && outside.length === 0,
    words: 'x',
    version: 3,
    createdAt: at(20, 9),
    updatedAt: at(27, 15),
    ...extra,
  }
}

const PACKS: PrepackView[] = [
  pack(1, 'PP-DEALER-10', 'Rivenditore 10 pezzi', 'STYLE', [
    { size: '48', quantity: 2 },
    { size: '50', quantity: 3 },
    { size: '52', quantity: 3 },
    { size: '54', quantity: 2 },
  ]),
  pack(2, 'PP-COL-52', 'Taglia 52 per colore', 'STYLE', [
    { size: '52', quantity: 2, colour: CW[0] },
    { size: '52', quantity: 1, colour: CW[1] },
    { size: '52', quantity: 1, colour: CW[2] },
  ]),
  pack(3, 'PP-SPRING-6', 'Primavera (vecchio)', 'STYLE', [
    { size: '50', quantity: 3 },
    { size: '52', quantity: 3 },
  ], { status: 'ARCHIVED' }),
  pack(4, 'PP-EU-WIDE', 'Scala completa 1-2-3-3-2-1', 'SCALE', [
    { size: '44', quantity: 1 },
    { size: '48', quantity: 2 },
    { size: '50', quantity: 3 },
    { size: '52', quantity: 3 },
    { size: '54', quantity: 2 },
    { size: '60', quantity: 1 },
  ]),
  pack(5, 'PP-EU-CORE', 'Cuore di scala 1-2-2-1', 'SCALE', [
    { size: '48', quantity: 1 },
    { size: '50', quantity: 2 },
    { size: '52', quantity: 2 },
    { size: '54', quantity: 1 },
  ]),
]

export function demoPrepacks(options: { empty?: boolean; rule?: boolean } = {}): StylePrepacksView {
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ACTIVE', baseSize: '52', sizes: SIZES },
    sizeScale: { ...SCALE, companyId: null, sizes: SCALE_SIZES },
    colourways: CW,
    prepacks: options.empty ? [] : PACKS,
    styleRefusal: options.rule ? 'Style DEMO-JKT-01 is discontinued: nothing of it changes in this state.' : null,
    words: 'x',
  }
}

const ready = (view: StylePrepacksView, extra: Partial<PrepacksModel> = {}): PrepacksModel => ({ ...NO_PREPACKS, canManage: true, part: { status: 'ready', value: view }, ...extra })

const sizes = (prepacks: PrepacksModel, overrides: Partial<StyleRecordViewModel> = {}, role: 'owner' | 'production' | 'sales' | 'product' = 'owner') =>
  recordModel(role, { tab: 'sizes', prepacks, protectors: readyProtectors(demoProtectors()), ...overrides })
const released = { style: { status: 'ready' as const, value: demoStyle() }, revisionId: REV.r2 }

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-287',
  title: 'Style studio: Sizes & measurements (prepacks, protector placement)',
  view: StyleRecordView,
  cases: [
    {
      id: 'owner',
      label: 'Prepacks and protector placement (draft revision 3)',
      model: sizes(ready(demoPrepacks())),
      note: 'Two packs of the style (one by colourway), two of the scale (PP-EU-WIDE has 44 and 60: the style cannot sell it). Three pockets; five things to look at, never blocking.',
    },
    {
      id: 'saving',
      label: 'Cells saving and refused',
      model: sizes(
        ready(demoPrepacks(), { marks: { [markKey(uid(1), '50')]: { state: 'saving', value: '4' }, [markKey(uid(5), '54')]: { state: 'refused', value: '0', problem: 'prepacks.problem.quantity' } } }),
        { protectors: readyProtectors(demoProtectors(), { marks: { [placementMark(PLACEMENTS[1]!.id, 'level')]: { state: 'saving', value: '2' }, [placementMark(PLACEMENTS[2]!.id, 'pocket')]: { state: 'refused', value: 'SHOULDER', problem: 'protectors.problem.overlap' } } }) },
      ),
      note: 'Size 50 of PP-DEALER-10 saving (↻); size 54 of PP-EU-CORE refused with "!" (0 is no pieces: leave it empty). The elbow moving to level 2; the back refused as a second shoulder.',
    },
    {
      id: 'offline',
      label: 'Offline: changes wait',
      model: sizes(ready(demoPrepacks(), { offline: true, marks: { [markKey(uid(1), '56')]: { state: 'waiting', value: '1' } } }), { protectors: readyProtectors(demoProtectors(), { offline: true, marks: { [placementMark(PLACEMENTS[0]!.id, 'positionNote')]: { state: 'waiting', value: 'Solo a destra' } } }) }),
      note: 'Each section says what waits on this page; nothing else is queued.',
    },
    { id: 'selected', label: 'Prepacks selected: Archive · Restore', model: sizes(ready(demoPrepacks(), { selected: [uid(1), uid(4)] }), { protectors: readyProtectors(demoProtectors(), { selected: [PLACEMENTS[1]!.id] }) }), note: '"Archive 2" (Restore held: none is archived); "Remove 1" on the placement.' },
    { id: 'show-archived', label: 'Archived packs shown', model: sizes(ready(demoPrepacks(), { showArchived: true })), note: 'PP-SPRING-6 archived: its cells are text, ⋯ offers Restore.' },
    { id: 'prepack-new', label: 'New prepack', model: sizes(ready(demoPrepacks(), { dialog: { kind: 'prepack', prepackId: null } })), note: '`p` opens it; for this style or every style of the scale; Add held until a code, a name and one size.' },
    {
      id: 'prepack-new-colour',
      label: 'New prepack, by colourway',
      model: sizes(ready(demoPrepacks(), { dialog: { kind: 'prepack', prepackId: null }, draft: { ...draftOf(null), code: 'PP-MIX-6', name: 'Mix colori 50-52', byColour: true, cells: { [COLOURWAY_IDS.BLK]: { '50': '1', '52': '2' }, [COLOURWAY_IDS.ANT]: { '50': '1', '52': '1' }, [COLOURWAY_IDS.RED]: { '52': '1' } } } })),
      note: 'One row per active colourway; the totals under the grid ("6 pieces per pack · ratio 2-4").',
    },
    { id: 'prepack-taken', label: 'New prepack: code taken', model: sizes(ready(demoPrepacks(), { dialog: { kind: 'prepack', prepackId: null }, draft: { ...draftOf(null), code: 'PP-EU-CORE', name: 'Doppione', cells: { '': { '52': '2' } } } })), note: 'Held: "Another prepack of this size scale has this code."' },
    { id: 'prepack-edit', label: 'A pack by colourway opened', model: sizes(ready(demoPrepacks(), { dialog: { kind: 'prepack', prepackId: uid(2) } })) },
    { id: 'prepack-archive', label: 'Archive the selection', model: sizes(ready(demoPrepacks(), { selected: [uid(1), uid(2)], dialog: { kind: 'status', ids: [uid(1), uid(2)], status: 'ARCHIVED' } })) },
    { id: 'placement-add', label: 'Add a placement', model: sizes(ready(demoPrepacks()), { protectors: readyProtectors(demoProtectors(), { dialog: { kind: 'placement', placementId: null } }) }), note: '`n` opens it; the protector fills its standard and level; a second protector in one pocket and size is held.' },
    {
      id: 'placement-overlap',
      label: 'Add a placement: pocket taken',
      model: sizes(ready(demoPrepacks()), { protectors: readyProtectors(demoProtectors(), { dialog: { kind: 'placement', placementId: null }, draft: { pocket: 'ELBOW', protectorItemId: PROTECTOR.hip, standard: 'EN 1621-1:2012', level: '1', sizes: [], positionNote: '' } }) }),
      note: 'Held: "That pocket already has a protector for one of these sizes."',
    },
    { id: 'placement-edit', label: 'Open a placement', model: sizes(ready(demoPrepacks()), { protectors: readyProtectors(demoProtectors(), { dialog: { kind: 'placement', placementId: PLACEMENTS[0]!.id } }) }) },
    { id: 'placement-sizes', label: 'Sizes of a placement', model: sizes(ready(demoPrepacks()), { protectors: readyProtectors(demoProtectors(), { dialog: { kind: 'sizes', placementId: PLACEMENTS[0]!.id } }) }) },
    { id: 'placement-remove', label: 'Remove a placement', model: sizes(ready(demoPrepacks()), { protectors: readyProtectors(demoProtectors(), { dialog: { kind: 'remove', ids: [PLACEMENTS[2]!.id] } }) }) },
    { id: 'agree', label: 'Placement in agreement', model: sizes(ready(demoPrepacks()), { protectors: readyProtectors(demoProtectors({ agree: true })) }), note: '"The placement agrees with the BOM and the certificates."' },
    {
      id: 'released',
      label: 'Released revision 2 (placement frozen)',
      model: sizes(ready(demoPrepacks()), { ...released, protectors: readyProtectors(demoProtectors({ revision: REVISIONS[1] })) }),
      note: 'The placement is text with "Revision 2 is released and frozen · Go to revision 3 (draft)"; the prepacks still change (not part of a revision).',
    },
    {
      id: 'rule',
      label: "The style's lifecycle holds changes",
      model: sizes(ready(demoPrepacks({ rule: true })), { protectors: readyProtectors(demoProtectors({ rule: true })) }),
      note: "This style's packs are read only (the scale's still change); the placement is read only; each says why.",
    },
    {
      id: 'no-permission',
      label: 'No edit right (viewer)',
      model: recordModel('owner', { tab: 'sizes', can: { ...recordModel('owner').can, bomManage: false }, prepacks: ready(demoPrepacks(), { canManage: false }), protectors: readyProtectors(demoProtectors()) }),
      note: 'Both read only with a banner; New prepack and Add placement held with why.',
    },
    { id: 'sales', label: 'Sales (prepacks; no BOM: placement absent)', model: sizes(ready(demoPrepacks()), { protectors: undefined }, 'sales'), note: 'Sales keeps the dealer packs; the revision-bound placement reads with the BOM, which sales does not.' },
    { id: 'empty', label: 'Nothing yet', model: sizes(ready(demoPrepacks({ empty: true })), { protectors: readyProtectors(demoProtectors({ empty: true })) }), note: '"No prepacks" + New prepack; "No protectors placed" + Add placement.' },
    { id: 'loading', label: 'Loading', model: sizes({ ...NO_PREPACKS, part: { status: 'loading' } }, { protectors: { ...readyProtectors(demoProtectors()), part: { status: 'loading' } } }) },
    {
      id: 'error',
      label: 'Could not load',
      model: sizes({ ...NO_PREPACKS, part: { status: 'error', problem: 'problem.read.unavailable' } }, { protectors: { ...readyProtectors(demoProtectors()), part: { status: 'error', problem: 'problem.read.unavailable' } } }),
      note: 'Each section fails alone; the rest of the record stays usable.',
    },
  ],
})
