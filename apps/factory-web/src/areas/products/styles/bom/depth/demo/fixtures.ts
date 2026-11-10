import { at, uid } from '../../../../library/demo'
import type { BomLine, BomView } from '../../../api'
import { BRANDS, demoBom, demoLines, lineMaterial, REVISIONS, STYLE_ID } from '../../../demo/fixtures'
import type { MaterialView } from '../../../api'
import type { Alternate, BomDepthView, BomStructureView, CheckItem, DepthLine, StructureLine, StyleOptionsView, TreeNode, UsedInView } from '../api'
import { NO_BOM_DEPTH, type BomDepthModel } from '../model'

/**
 * B-W2b-241 design data for the Materials (BOM) tab in depth (SCR-042 `w2b-241-*` cases) — made-up only, on DEMO-JKT-01's
 * draft revision 3: W1's eight lines plus two components we make — 90 the CE armour kit (the group row of the shoulder and
 * elbow protectors, lines 40 and 50) and 100 the removable thermal liner, a sub-assembly (DEMO-LNR-01 revision 2, which
 * takes DEMO-PAD-01's thermal panel at level 2), only for the option "Thermal liner: Yes". The lining has an alternate used
 * only when short, the shoulder protector one needing approval and a certificate check (no certificate in the register
 * covers it), the leather one always allowed; the care label is sent by the brand; the leather goes to the workshop cut and
 * the lining in its kit. Every code and figure is invented.
 */

const STRUCTURE_ID = (n: number) => uid('4444', n)
const ITEM_ID = (n: number) => uid('4400', n)
const OPTION = { termGroup: uid('2410', 1), yes: uid('2410', 2), no: uid('2410', 3), perfGroup: uid('2410', 4), full: uid('2410', 5), front: uid('2410', 6) }
const SUB = { liner: uid('2411', 1), linerRev: uid('2411', 2), pad: uid('2411', 3), padRev: uid('2411', 4), set: uid('2411', 5), setRev: uid('2411', 6) }

/** W1's lines with the two components we make (kit 90, liner 100). */
export function depthLines(): BomLine[] {
  const base = demoLines()
  const protector = base[3]!
  const component = (n: number, code: string, name: string, placement: string): BomLine => ({
    ...protector,
    id: STRUCTURE_ID(n),
    seq: n * 10,
    item: { id: ITEM_ID(n), code, name, kind: 'COMPONENT', status: 'ACTIVE', baseUom: 'PCS' },
    placement,
    qty: '1',
    uom: 'PCS',
    bySize: protector.bySize.map((entry) => ({ ...entry, qty: '1', gross: '1', base: '1' })),
    routingStep: null,
  })
  return [...base, component(9, 'KIT-PROT-CE', 'Kit protezioni CE (demo)', 'Tasche protezioni'), component(10, 'LNR-TERM', 'Fodera termica staccabile (demo)', 'Interno')]
}

export function depthBom(options: { released?: boolean } = {}): BomView {
  if (options.released) return demoBom({ revision: REVISIONS[1] })
  return { ...demoBom(), lines: depthLines() }
}

const SECTION: Record<number, StructureLine['section']> = { 1: 'SHELL', 2: 'LINING', 3: 'INSULATION', 4: 'PROTECTION', 5: 'PROTECTION', 6: 'TRIMS', 7: 'THREAD', 8: 'LABELS', 9: 'PROTECTION', 10: 'LINING' }
const FILED = new Set([9, 10])
const PARENT: Record<number, number> = { 4: 9, 5: 9 }
const ALTERNATES: Record<number, number> = { 1: 1, 2: 1, 4: 1 }

const linerRef = (status: 'RELEASED' | 'DRAFT' = 'RELEASED'): NonNullable<StructureLine['subAssembly']> => ({
  style: { id: SUB.liner, code: 'DEMO-LNR-01', name: 'Fodera termica (demo)', status: 'ACTIVE' },
  revision: { id: SUB.linerRev, revision: 2, status },
  outputQuantity: 1,
  outputUom: 'PCS',
})

function structureLines(lines: readonly BomLine[], liner: 'RELEASED' | 'DRAFT'): StructureLine[] {
  const n = (line: BomLine) => line.seq / 10
  const all = lines.map((line): StructureLine => {
    const k = n(line)
    return {
      id: line.id,
      seq: line.seq,
      item: { id: line.item.id, code: line.item.code, name: line.item.name, kind: line.item.kind as StructureLine['item']['kind'], sourcing: line.item.kind === 'COMPONENT' ? 'MAKE' : 'BUY', status: 'ACTIVE', approval: k === 4 ? 'PENDING' : 'APPROVED' },
      placement: line.placement,
      qty: line.qty,
      uom: line.uom,
      section: SECTION[k] ?? 'OTHER',
      filed: FILED.has(k),
      parentLineId: PARENT[k] ? STRUCTURE_ID(PARENT[k]!) : null,
      depth: PARENT[k] ? 1 : 0,
      groupedLineIds: k === 9 ? [STRUCTURE_ID(4), STRUCTURE_ID(5)] : [],
      subAssembly: k === 10 ? linerRef(liner) : null,
      customerSuppliedByPartyId: k === 8 ? BRANDS[0]!.id : null,
      issueToSubcontract: k === 1 || k === 2,
      sourceKey: null,
      optionValueId: k === 10 ? OPTION.yes : null,
      alternates: ALTERNATES[k] ?? 0,
    }
  })
  // The grouped order: roots by place, each group row followed by its lines.
  const roots = all.filter((line) => line.parentLineId === null)
  return roots.flatMap((line) => [line, ...all.filter((child) => child.parentLineId === line.id)])
}

const cell = (at: Partial<CheckItem['cell']>): CheckItem['cell'] => ({ lineId: null, column: null, size: null, colourwayId: null, alternateId: null, stepId: null, ...at })

/** The check: W1's two findings of the draft (size 58 of the leather, the zip's colour for ANTR), or the W2b ones. */
function checkOf(kind: 'w1' | 'w2b' | 'none'): { blockers: CheckItem[]; warnings: CheckItem[] } {
  const bom = demoBom()
  const w1 = bom.issues.map((issue): CheckItem => ({ code: issue.code as CheckItem['code'], severity: 'BLOCKER', message: issue.message, cell: cell({ lineId: issue.lineId, column: issue.size ? 'sizes' : 'colours', size: issue.size, colourwayId: issue.colourwayId }) }))
  if (kind === 'none') return { blockers: [], warnings: [] }
  if (kind === 'w1') return { blockers: w1, warnings: [] }
  return {
    blockers: [
      { code: 'MATERIAL_BLOCKED', severity: 'BLOCKER', message: 'x', cell: cell({ lineId: STRUCTURE_ID(3), column: 'itemId' }) },
      { code: 'SUB_ASSEMBLY_CIRCLE', severity: 'BLOCKER', message: 'x', cell: cell({ lineId: STRUCTURE_ID(10), column: 'subAssembly' }) },
      { code: 'SUB_ASSEMBLY_NOT_RELEASED', severity: 'BLOCKER', message: 'x', cell: cell({ lineId: STRUCTURE_ID(10), column: 'subAssembly' }) },
      ...w1,
    ],
    warnings: [
      { code: 'PPE_MATERIAL_NOT_APPROVED', severity: 'WARNING', message: 'x', cell: cell({ lineId: STRUCTURE_ID(4), column: 'itemId' }) },
      { code: 'ALTERNATE_ARCHIVED', severity: 'WARNING', message: 'x', cell: cell({ lineId: STRUCTURE_ID(2), column: 'alternates', alternateId: uid('2412', 2) }) },
    ],
  }
}

export function demoStructure(options: { check?: 'w1' | 'w2b' | 'none'; released?: boolean; noTree?: boolean } = {}): BomStructureView {
  const rev = options.released ? REVISIONS[1]! : REVISIONS[0]!
  const liner = options.check === 'w2b' ? 'DRAFT' : 'RELEASED'
  const lines = structureLines(options.released ? demoBom({ revision: REVISIONS[1] }).lines : depthLines(), liner).map((line) => (options.noTree ? { ...line, subAssembly: null } : line))
  const sections = (['SHELL', 'LINING', 'INSULATION', 'PROTECTION', 'TRIMS', 'THREAD', 'LABELS', 'PACKAGING', 'OTHER'] as const).flatMap((section) => {
    const ids = lines.filter((line) => line.section === section).map((line) => line.id)
    return ids.length > 0 ? [{ section, lineIds: ids }] : []
  })
  const check = checkOf(options.released ? 'none' : (options.check ?? 'w1'))
  const tree: TreeNode[] =
    options.noTree || options.released
      ? []
      : [
          {
            level: 1,
            via: [],
            revisionId: rev.id,
            lineId: STRUCTURE_ID(10),
            seq: 100,
            item: { id: ITEM_ID(10), code: 'LNR-TERM', name: 'Fodera termica staccabile (demo)', kind: 'COMPONENT' },
            qty: '1',
            uom: 'PCS',
            subAssembly: linerRef(liner),
            lines: 4,
            subAssemblies: 1,
          },
          {
            level: 2,
            via: [STRUCTURE_ID(10)],
            revisionId: SUB.linerRev,
            lineId: uid('2413', 30),
            seq: 30,
            item: { id: uid('2413', 1), code: 'PAN-TERM', name: 'Pannello termico trapuntato (demo)', kind: 'COMPONENT' },
            qty: '2',
            uom: 'PCS',
            subAssembly: { style: { id: SUB.pad, code: 'DEMO-PAD-01', name: 'Pannello termico (demo)', status: 'ACTIVE' }, revision: { id: SUB.padRev, revision: 1, status: 'RELEASED' }, outputQuantity: 1, outputUom: 'PAIR' },
            lines: 3,
            subAssemblies: 0,
          },
        ]
  return {
    revision: { id: rev.id, styleId: STYLE_ID, revision: rev.revision, status: rev.status, version: rev.version },
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ACTIVE' },
    editable: rev.status === 'DRAFT',
    outputQuantity: 1,
    outputUom: 'PCS',
    lines,
    sections,
    tree,
    levels: tree.reduce((top, node) => Math.max(top, node.level), 0),
    check: {
      revision: { id: rev.id, styleId: STYLE_ID, revision: rev.revision, status: rev.status, version: rev.version },
      checked: rev.status === 'DRAFT',
      ...check,
      count: check.blockers.length + check.warnings.length,
      releasable: rev.status === 'DRAFT' && check.blockers.length === 0,
    },
  }
}

const material = (n: number, code: string, name: string, kind: DepthLine['item']['kind'], baseUom: DepthLine['item']['baseUom'], extra: Partial<DepthLine['item']> = {}): DepthLine['item'] => ({
  id: n < 100 ? ITEM_ID(n) : uid('2414', n),
  code,
  name,
  kind,
  status: 'ACTIVE',
  approval: 'APPROVED',
  isPpeComponent: kind === 'PROTECTOR',
  tracking: kind === 'LEATHER' ? 'HIDE' : 'NONE',
  baseUom,
  ...extra,
})

const alternate = (n: number, priority: number, item: DepthLine['item'], fields: Partial<Alternate>): Alternate => ({
  id: uid('2412', n),
  priority,
  item,
  itemColour: null,
  qty: null,
  allowedWhen: 'WITH_APPROVAL',
  certificateCheck: false,
  certificateRequired: false,
  certificate: null,
  needs: ['NEEDS_APPROVAL'],
  note: null,
  createdAt: at(26, 10),
  updatedAt: at(27, 11),
  ...fields,
})

export function demoDepth(options: { released?: boolean; archivedAlternate?: boolean } = {}): BomDepthView {
  const rev = options.released ? REVISIONS[1]! : REVISIONS[0]!
  const lines = options.released ? demoBom({ revision: REVISIONS[1] }).lines : depthLines()
  const brand = BRANDS[0]!
  const deep = lines.map((line): DepthLine => {
    const k = line.seq / 10
    const item = material(k, line.item.code, line.item.name, line.item.kind as DepthLine['item']['kind'], line.item.baseUom, k === 4 ? { approval: 'PENDING' } : {})
    const alternates: Alternate[] =
      k === 1
        ? [alternate(1, 1, material(101, 'PEL-BOV-14', 'Pelle bovina 1,3–1,5 mm (demo)', 'LEATHER', 'FT2'), { allowedWhen: 'ALWAYS', needs: [], qty: '7.6' })]
        : k === 2
          ? [alternate(2, 1, material(102, 'FOD-MESH-B', 'Fodera rete B (demo)', 'LINING', 'M', options.archivedAlternate ? { status: 'ARCHIVED' } : {}), { allowedWhen: 'WHEN_SHORT', needs: ['ONLY_WHEN_SHORT'], note: 'Stessa grammatura, colore unico nero.' })]
          : k === 4
            ? [alternate(3, 1, material(104, 'PROT-SPAL-L2B', 'Protezione spalla liv. 2, altro fornitore (demo)', 'PROTECTOR', 'PCS'), { certificateCheck: true, certificateRequired: true, needs: ['NEEDS_APPROVAL', 'NEEDS_CERTIFICATE_CHECK'] })]
            : []
    return {
      id: line.id,
      seq: line.seq,
      item,
      placement: line.placement,
      qty: line.qty,
      uom: line.uom,
      supplier: null,
      customerSupplied: k === 8 ? { id: brand.id, code: brand.code, name: brand.tradeName ?? brand.legalName } : null,
      issueToSubcontract: k === 1 || k === 2,
      kit: k === 1 ? 'CUT' : k === 2 ? 'KIT' : null,
      routingStep: null,
      subAssembly: k === 10,
      alternates,
    }
  })
  return {
    revision: { id: rev.id, styleId: STYLE_ID, revision: rev.revision, status: rev.status, version: rev.version },
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ACTIVE', ppe: true },
    editable: rev.status === 'DRAFT',
    output: { quantity: 1, uom: 'PCS' },
    lines: deep,
    kit: { from: 'BOM', lineIds: [STRUCTURE_ID(1), STRUCTURE_ID(2)], cutLineIds: [STRUCTURE_ID(1)] },
    customers: [{ party: { id: brand.id, code: brand.code, name: brand.tradeName ?? brand.legalName }, lineIds: [STRUCTURE_ID(8)] }],
    counts: { lines: deep.length, alternates: 3, customerSupplied: 1, forWorkshop: 2 },
  }
}

const names = (it: string, en: string) => ({ it, en })

export function demoOptions(): StyleOptionsView {
  const value = (id: string, code: string, it: string, en: string, seq: number) => ({ id, code, name: en, nameI18n: names(it, en), seq, freeText: false, outsideCertificate: false, status: 'ACTIVE' as const })
  const offer = (n: number, groupId: string, code: string, it: string, en: string, values: ReturnType<typeof value>[]) => ({
    id: uid('2415', n),
    group: { id: groupId, code, name: en, nameI18n: names(it, en), kind: 'SINGLE' as const, minPicks: 0, maxPicks: 1, status: 'ACTIVE' as const },
    seq: n * 10,
    minPicks: null,
    maxPicks: null,
    effective: { minPicks: 0, maxPicks: 1 },
    picks: names('0–1', '0–1'),
    defaultValueId: null,
    values,
    status: 'ACTIVE' as const,
    version: 1,
    updatedAt: at(25, 9),
  })
  const rev = REVISIONS[0]!
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ACTIVE' },
    offers: [
      offer(1, OPTION.termGroup, 'DEMO-OG-TERM', 'Fodera termica', 'Thermal liner', [value(OPTION.yes, 'YES', 'Sì', 'Yes', 10), value(OPTION.no, 'NO', 'No', 'No', 20)]),
      offer(2, OPTION.perfGroup, 'DEMO-OG-PERF', 'Perforazione', 'Perforation', [value(OPTION.full, 'FULL', 'Completa', 'Full', 10), value(OPTION.front, 'FRONT', 'Solo davanti', 'Front only', 20)]),
    ],
    lines: [{ revision: { id: rev.id, revision: rev.revision, status: rev.status }, lineId: STRUCTURE_ID(10), seq: 100, item: { id: ITEM_ID(10), code: 'LNR-TERM', name: 'Fodera termica staccabile (demo)' }, optionValueId: OPTION.yes, option: 'DEMO-OG-TERM: YES' }],
    steps: [],
    editable: true,
  }
}

export function demoUsedIn(none = false): UsedInView {
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', status: 'ACTIVE' },
    usedIn: none
      ? []
      : [
          {
            style: { id: SUB.set, code: 'DEMO-SET-01', name: 'Completo Touring giacca e pantalone (demo)', status: 'ACTIVE' },
            revision: { id: SUB.setRev, revision: 1, status: 'RELEASED' },
            lineId: uid('2416', 1),
            seq: 10,
            qty: '1',
            uom: 'PCS',
            takes: { id: REVISIONS[1]!.id, revision: 2, status: 'RELEASED' },
          },
        ],
  }
}

/** The BOM in depth, read: draft revision 3 with W1's findings (or the W2b ones), every part ready. */
export function demoDepthModel(overrides: Partial<BomDepthModel> & { check?: 'w1' | 'w2b' | 'none'; released?: boolean } = {}): BomDepthModel {
  const { check, released, ...rest } = overrides
  return {
    ...NO_BOM_DEPTH,
    structure: { status: 'ready', value: demoStructure({ check, released }) },
    depth: { status: 'ready', value: demoDepth({ released }) },
    options: { status: 'ready', value: demoOptions() },
    usedIn: { status: 'ready', value: demoUsedIn() },
    canManage: true,
    ...rest,
  }
}

/** For the line drawer's sub-assembly search: two open styles a component line may take. */
export const SUB_STYLES = [
  { id: SUB.liner, code: 'DEMO-LNR-01', name: 'Fodera termica (demo)' },
  { id: SUB.pad, code: 'DEMO-PAD-01', name: 'Pannello termico (demo)' },
]
export const SUB_IDS = SUB
export const OPTION_IDS = OPTION
export const LINE_IDS = { leather: STRUCTURE_ID(1), lining: STRUCTURE_ID(2), membrane: STRUCTURE_ID(3), shoulder: STRUCTURE_ID(4), label: STRUCTURE_ID(8), kit: STRUCTURE_ID(9), liner: STRUCTURE_ID(10) }

/** The alternates' materials (their colours fill the alternate's colour choice). */
export const ALT_MATERIALS: Record<string, MaterialView> = Object.fromEntries(
  ([
    [101, 1, 'PEL-BOV-14', 'Pelle bovina 1,3–1,5 mm (demo)'],
    [102, 2, 'FOD-MESH-B', 'Fodera rete B (demo)'],
    [104, 4, 'PROT-SPAL-L2B', 'Protezione spalla liv. 2, altro fornitore (demo)'],
  ] as const).map(([n, like, code, name]) => {
    const id = uid('2414', n)
    const base = lineMaterial(like)
    return [id, { ...base, id, code, name, colours: base.colours.map((colour, index) => ({ ...colour, id: uid('2417', n * 10 + index) })) }]
  }),
)
