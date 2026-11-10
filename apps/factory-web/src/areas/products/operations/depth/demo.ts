import { at, COMPANY_ID, PREFIX, uid } from '../../library/demo'
import type { LibrarySettings, OperationMinutesView, TimeVersionView, WaitingEntry } from './api'
import { smvCanOf, type MinutesModel, type SettingsModel } from './model'
import { ROLE_PERMISSIONS, type RoleCase } from '../../library/demo'

/**
 * B-W2b-235 design data for Operations in depth (SCR-049 and SCR-049-operation `w2b-235-*` cases) — made-up only: the shoulder
 * seam DEMO-CUC-SPALLA governed since version 1 (5.8 min, from 1 Oct), version 2 in force (6.2 = 5.5 min + 5 % + 4.5 % +
 * 3.2273 %, from 20 Oct), version 4 proposed by another person (6.5 min from 12 Nov), a rejected one and a replaced one; the
 * routing steps and piece rates it reaches; the SMV changes waiting; the machine settings. Every person, figure and day is
 * invented. The proposer is "Demo Planner", the reader "Demo Manager".
 */

const words = (it: string, en: string) => ({ it, en })
export const READER_ID = uid('4705', 1)
const PLANNER = { id: uid('4705', 2), name: 'Demo Planner' }
const MANAGER = { id: READER_ID, name: 'Demo Manager' }
const OPERATION_ID = uid('4901', 2)

const version = (n: number, fields: Partial<TimeVersionView>): TimeVersionView => ({
  id: uid('4950', n),
  number: n,
  status: 'APPROVED',
  basicMinutes: '5.5',
  personalPct: '5',
  fatiguePct: '4.5',
  delayPct: '3.2273',
  standardMinutes: '6.2',
  source: 'TIME_STUDY',
  effectiveFrom: '2026-10-20',
  reason: 'Rilievo tempi sulla linea 2 dopo il cambio di macchina.',
  proposedBy: PLANNER,
  proposedAt: at(14, 10),
  decidedBy: MANAGER,
  decidedAt: at(15, 9),
  decisionNote: null,
  inForce: false,
  waiting: false,
  version: 2,
  ...fields,
})

export const VERSIONS: TimeVersionView[] = [
  version(4, { status: 'PROPOSED', standardMinutes: '6.5', basicMinutes: '5.8', personalPct: '5', fatiguePct: '4.5', delayPct: '2.569', effectiveFrom: '2026-11-12', reason: 'Nuova pelle più spessa: la cucitura richiede un passaggio in più.', proposedAt: at(28, 16), decidedBy: null, decidedAt: null, version: 1 }),
  version(3, { status: 'REJECTED', standardMinutes: '5.9', basicMinutes: '5.2', delayPct: '3.958', effectiveFrom: '2026-10-25', reason: 'Prova con piedino a rullo.', proposedAt: at(22, 11), decidedAt: at(23, 9), decisionNote: 'Il rilievo copre solo 6 capi: ripetere su un turno intero.' }),
  version(2, { inForce: true, decisionNote: 'Rilievo su 40 capi, accettato.' }),
  version(1, { status: 'SUPERSEDED', standardMinutes: '5.8', basicMinutes: '5.2', personalPct: '5', fatiguePct: '4', delayPct: '2.5385', source: 'ESTIMATE', effectiveFrom: '2026-10-01', reason: 'Prima versione dalla stima del reparto.', proposedAt: at(1, 9), decidedAt: at(1, 15) }),
]

export function demoMinutes(options: { pending?: boolean; governed?: boolean; may?: { propose: boolean; decide: boolean } } = {}): OperationMinutesView {
  const governed = options.governed ?? true
  const versions = governed ? (options.pending === false ? VERSIONS.slice(1) : VERSIONS) : []
  return {
    operation: { id: OPERATION_ID, code: 'DEMO-CUC-SPALLA', name: 'Cucitura spalla', companyId: COMPANY_ID, workCentreKind: 'SEWING', status: 'ACTIVE', version: 6 },
    current: governed ? { standardMinutes: '6.2', basicMinutes: '5.5', personalPct: '5', fatiguePct: '4.5', delayPct: '3.2273' } : { standardMinutes: '6.2', basicMinutes: null, personalPct: null, fatiguePct: null, delayPct: null },
    governed,
    today: '2026-10-29',
    inForce: governed ? { standardMinutes: '6.2', versionId: uid('4950', 2), number: 2, effectiveFrom: '2026-10-20' } : { standardMinutes: '6.2', versionId: null, number: null, effectiveFrom: null },
    pendingId: governed && options.pending !== false ? uid('4950', 4) : null,
    versions,
    impact: {
      routings: [
        { style: { id: uid('4101', 1), code: 'DEMO-JKT-01', name: 'Giacca Touring Demo' }, revision: { id: uid('4102', 3), revision: 3, status: 'DRAFT' }, stepId: uid('4903', 1), seq: 30, standardMinutes: '6.2', runFrom: 'VERSION', timeVersionNumber: 2 },
        { style: { id: uid('4101', 1), code: 'DEMO-JKT-01', name: 'Giacca Touring Demo' }, revision: { id: uid('4102', 2), revision: 2, status: 'RELEASED' }, stepId: uid('4903', 2), seq: 30, standardMinutes: '6.6', runFrom: 'TYPED', timeVersionNumber: null },
        { style: { id: uid('4101', 2), code: 'DEMO-JKT-02', name: 'Giacca Racing Demo' }, revision: { id: uid('4102', 5), revision: 1, status: 'RELEASED' }, stepId: uid('4903', 3), seq: 20, standardMinutes: '6.2', runFrom: 'VERSION', timeVersionNumber: 2 },
        { style: { id: uid('4101', 3), code: 'DEMO-VST-01', name: 'Gilet Demo' }, revision: { id: uid('4102', 7), revision: 1, status: 'DRAFT' }, stepId: uid('4903', 4), seq: 20, standardMinutes: '6.4', runFrom: 'ALLOWANCES', timeVersionNumber: null },
      ],
      pieceRates: {
        count: 2,
        rows: [
          { table: { id: uid('4960', 1), code: 'DEMO-CUC', name: 'Cucito giacche' }, versionId: uid('4961', 1), versionNo: 3, status: 'PUBLISHED', effectiveFrom: '2026-10-20', sizeBand: 'ALL', standardMinutes: '6.2' },
          { table: { id: uid('4960', 1), code: 'DEMO-CUC', name: 'Cucito giacche' }, versionId: uid('4961', 2), versionNo: 4, status: 'DRAFT', effectiveFrom: '2026-11-12', sizeBand: 'ALL', standardMinutes: '6.2' },
        ],
      },
    },
    may: options.may ?? { propose: true, decide: true },
  }
}

export function minutesModel(role: RoleCase, overrides: Partial<MinutesModel> = {}, options: Parameters<typeof demoMinutes>[0] = {}): MinutesModel {
  const can = smvCanOf(ROLE_PERMISSIONS[role])
  return {
    part: { status: 'ready', value: demoMinutes({ ...options, may: options.may ?? { propose: can.propose, decide: can.approve } }) },
    dialog: null,
    busy: false,
    refused: null,
    notice: null,
    userId: READER_ID,
    can,
    // B-W2b-274: Changes & versions is built: its SMV changes for a role that reads them.
    connections: { pieceRates: can.pieceRates ? { kind: 'page', href: `${PREFIX}/people/piecerates` } : { kind: 'noRight' }, changes: (ROLE_PERMISSIONS[role] as readonly string[]).includes('product.changes.view') ? { kind: 'page', href: `${PREFIX}/products/changes?kind=smv` } : { kind: 'noRight' } },
    ...overrides,
  }
}

export const WAITING: WaitingEntry[] = [
  { operation: { id: OPERATION_ID, code: 'DEMO-CUC-SPALLA', name: 'Cucitura spalla', companyId: COMPANY_ID, standardMinutes: '6.2' }, proposal: VERSIONS[0]!, mayDecide: true },
  {
    operation: { id: uid('4901', 1), code: 'DEMO-TAG-PELLE', name: 'Taglio pelle a mano', companyId: COMPANY_ID, standardMinutes: '18.5' },
    proposal: version(7, { id: uid('4950', 7), number: 2, status: 'PROPOSED', standardMinutes: '17.8', basicMinutes: '16', personalPct: '5', fatiguePct: '4', delayPct: '2.25', effectiveFrom: '2026-11-03', reason: 'Nuovo tavolo di taglio con aspirazione.', proposedBy: MANAGER, proposedAt: at(27, 11), decidedBy: null, decidedAt: null, version: 1 }),
    mayDecide: false,
  },
  {
    operation: { id: uid('4901', 6), code: 'DEMO-CQ-FINALE', name: 'Controllo finale capo', companyId: COMPANY_ID, standardMinutes: '5.5' },
    proposal: version(8, { id: uid('4950', 8), number: 1, status: 'PROPOSED', standardMinutes: '6', basicMinutes: '5.5', personalPct: '5', fatiguePct: '2', delayPct: '2.0909', effectiveFrom: '2026-10-29', reason: 'Controllo cuciture aggiunto al finale.', proposedAt: at(29, 8), decidedBy: null, decidedAt: null, version: 1 }),
    mayDecide: true,
  },
]

export const LIBRARY_SETTINGS: LibrarySettings = {
  operation: { id: OPERATION_ID, code: 'DEMO-CUC-SPALLA', name: 'Cucitura spalla', companyId: COMPANY_ID, status: 'ACTIVE', version: 6 },
  settings: [
    {
      id: uid('4970', 1),
      seq: 1,
      machineClass: { id: uid('4971', 1), code: 'DEMO-PIA', label: words('Piana 1 ago', 'Flatbed single needle'), active: true },
      stitchType: '301',
      needle: '134 LR Nm 110',
      thread: 'Tkt 40',
      stitchesPerCm: '3.5',
      tension: 'Media',
      foot: 'Piedino a rullo',
      notes: null,
      line: words('Piana 1 ago · 301 · 134 LR Nm 110 · Tkt 40 · 3,5 per cm · Piedino a rullo', 'Flatbed single needle · 301 · 134 LR Nm 110 · Tkt 40 · 3.5 per cm · Piedino a rullo'),
    },
    {
      id: uid('4970', 2),
      seq: 2,
      machineClass: null,
      stitchType: '301',
      needle: '134 Nm 90',
      thread: 'Tkt 60',
      stitchesPerCm: '4',
      tension: null,
      foot: null,
      notes: 'Ribattitura a 6 mm dal bordo.',
      line: words('301 · 134 Nm 90 · Tkt 60 · 4 per cm', '301 · 134 Nm 90 · Tkt 60 · 4 per cm'),
    },
  ],
  draftStepsWithout: 2,
  may: { manage: true },
}

export const CLASSES = [
  { id: uid('4971', 1), code: 'DEMO-PIA', labelIt: 'Piana 1 ago', labelEn: 'Flatbed single needle' },
  { id: uid('4971', 2), code: 'DEMO-COL', labelIt: 'Colonna', labelEn: 'Post-bed' },
]

export function settingsModel(overrides: Partial<SettingsModel> = {}, manage = true): SettingsModel {
  return { part: { status: 'ready', value: { ...LIBRARY_SETTINGS, may: { manage } } }, classes: CLASSES, busy: false, refused: null, notice: null, ...overrides }
}
