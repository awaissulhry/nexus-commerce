import { createElement, type ReactNode } from 'react'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Acknowledgements, InstructionRecord, InstructionRow, StepView, VersionAnswer, VersionView } from '../api'
import { instructionsCan, type InstructionsCan } from '../model'

/**
 * Made-up work instructions for the design cases of SCR-141, SCR-285, SCR-285-preview and SCR-285-pdf (B-W2b-234): an
 * invented company, sites ("STAB-N", "STAB-S"), operations (DEMO-CUC-SPALLA …), styles (DEMO-JKT-01), office users ("Alex
 * Demo", "Bea Esempio", "Carla Prova") and workers ("Operatore Uno" …), and pictures drawn here (a garment and a seam: never
 * a face). Nothing here is a real company, person or number. Design-only: it exports no `designScreen`.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = DEMO_COMPANIES[0].id
export const ME = DEMO_USER.id
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
export const NOW = at(10, 9, 42)

const ALEX = { id: ME, name: 'Alex Demo' }
const BEA = { id: uid('3333', 2), name: 'Bea Esempio' }
const CARLA = { id: uid('3333', 3), name: 'Carla Prova' }

// ---- roles -----------------------------------------------------------------------------------------------------------------------

const templatePermissions = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The role cases of the review: the owner (everything), the production manager (writes and approves; no names), the floor
 * supervisor (writes, never approves), quality (approves, never writes), HR (counts and the training record by name), a
 * read-only person and a sales person (none of this page).
 */
export const ROLE_PERMISSIONS = {
  owner: FACTORY_PERMISSIONS.assignable.map((definition) => definition.name),
  manager: templatePermissions('production_manager'),
  supervisor: templatePermissions('floor_supervisor'),
  quality: templatePermissions('quality_inspector'),
  hr: templatePermissions('hr'),
  readOnly: templatePermissions('read_only'),
  sales: templatePermissions('sales'),
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS
export const canFor = (role: RoleCase): InstructionsCan => instructionsCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: RoleCase = 'manager'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLE_PERMISSIONS[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- pictures (drawn here: a garment and a seam, never a face) ---------------------------------------------------------------------

function picture(kind: 'jacket' | 'seam' | 'zip' | 'pocket', tone: string): string {
  const shapes: Record<typeof kind, string> = {
    jacket: `<path d="M120 60 L200 40 L280 60 L340 120 L310 150 L280 130 L280 260 L120 260 L120 130 L90 150 L60 120 Z" fill="${tone}" stroke="#1f2933" stroke-width="4"/><path d="M200 40 L200 260" stroke="#f5f7fa" stroke-width="3" stroke-dasharray="8 6"/>`,
    seam: `<rect x="40" y="90" width="320" height="120" rx="10" fill="${tone}"/><path d="M40 150 H360" stroke="#f5f7fa" stroke-width="4" stroke-dasharray="12 8"/><circle cx="210" cy="150" r="14" fill="none" stroke="#e4572e" stroke-width="5"/>`,
    zip: `<rect x="150" y="30" width="100" height="240" rx="8" fill="${tone}"/><path d="M200 40 V260" stroke="#cbd2d9" stroke-width="10" stroke-dasharray="6 6"/><rect x="180" y="120" width="40" height="40" rx="6" fill="#52606d"/>`,
    pocket: `<rect x="60" y="50" width="280" height="200" rx="14" fill="${tone}"/><rect x="120" y="110" width="160" height="110" rx="8" fill="none" stroke="#f5f7fa" stroke-width="4" stroke-dasharray="10 6"/>`,
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e4e7eb"/>${shapes[kind]}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export const FILES = { jacket: uid('4141', 1), seam: uid('4141', 2), zip: uid('4141', 3), pocket: uid('4141', 4), clip: uid('4141', 5), uploading: uid('4141', 6) }
export const MEDIA_SRC: Readonly<Record<string, string | null>> = {
  [FILES.jacket]: picture('jacket', '#3e4c59'),
  [FILES.seam]: picture('seam', '#7b8794'),
  [FILES.zip]: picture('zip', '#323f4b'),
  [FILES.pocket]: picture('pocket', '#616e7c'),
  [FILES.clip]: null,
}

const file = (name: string, type: string, size: number, status = 'AVAILABLE') => ({ originalName: name, contentType: type, sizeBytes: size, status })

// ---- an instruction: the shoulder seam, for every style ------------------------------------------------------------------------------

const OPERATION = { id: uid('4901', 2), code: 'DEMO-CUC-SPALLA', name: 'Cucitura spalla' }
const STYLE = { id: uid('7777', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo', revisionId: uid('7878', 3), revision: 3, revisionStatus: 'RELEASED' }
export const INSTRUCTION_ID = uid('5401', 7)
const V1 = uid('5402', 1)
const V2 = uid('5402', 2)
const V3 = uid('5402', 3)

const version = (id: string, number: number, status: VersionView['status'], extra: Partial<VersionView> = {}): VersionView => ({
  id,
  number,
  status,
  changeNote: null,
  acknowledgementRequired: true,
  author: BEA,
  approvedBy: null,
  publishedAt: null,
  supersededAt: null,
  createdAt: at(1),
  steps: 4,
  media: 3,
  seen: 0,
  version: 2,
  ...extra,
})

export const VERSIONS: VersionView[] = [
  version(V3, 3, 'DRAFT', { changeNote: 'Il margine di cucitura passa da 10 a 12 mm; nuovo passo per il controllo del rinforzo.', author: BEA, createdAt: at(9, 14), steps: 5, media: 4 }),
  version(V2, 2, 'PUBLISHED', { changeNote: 'Foto nuova del punto di partenza; nota di sicurezza sul piedino.', author: CARLA, approvedBy: ALEX, publishedAt: at(3, 10), createdAt: at(2, 16), steps: 4, media: 3, seen: 12 }),
  version(V1, 1, 'SUPERSEDED', { author: CARLA, approvedBy: ALEX, publishedAt: at(1, 11), supersededAt: at(3, 10), createdAt: at(1, 8), steps: 3, media: 1, seen: 14 }),
]

export const RECORD: InstructionRecord = {
  instruction: { id: INSTRUCTION_ID, number: 'WI-2026-0007', companyId: COMPANY_ID, status: 'ACTIVE', version: 5, operation: OPERATION, style: null, createdAt: at(1, 8), updatedAt: at(9, 14) },
  versions: VERSIONS,
  currentVersionId: V2,
  draftVersionId: V3,
  settings: [{ seq: 1, machineClass: { code: 'LOCK', labelIt: 'Piana 1 ago', labelEn: 'Single-needle lockstitch' }, stitchType: '301', needle: '110/18 LR', thread: 'Poliestere 30', stitchesPerCm: '3,5', tension: 'media', foot: 'Piedino a rullo', notes: null }],
  floorLanguages: ['it', 'en', 'ro'],
  usedIn: [
    { revisionId: STYLE.revisionId, styleId: STYLE.id, styleCode: STYLE.code, styleName: STYLE.name, revision: 3, status: 'RELEASED' },
    { revisionId: uid('7878', 9), styleId: uid('7777', 2), styleCode: 'DEMO-JKT-02', styleName: 'Giacca tessuto demo', revision: 1, status: 'RELEASED' },
  ],
  rights: { canManage: true, canApprove: true, canSeePeople: false, approveHeld: null },
}

const step = (n: number, code: string, text: Record<string, string>, extra: Partial<StepView> = {}): StepView => ({
  id: uid('5403', n),
  code,
  sortOrder: n,
  text,
  critical: false,
  safety: null,
  icon: null,
  requiredTick: false,
  missingLanguages: ['it', 'en', 'ro'].filter((language) => !text[language]),
  media: [],
  ...extra,
})

const medium = (n: number, fileId: string, kind: 'PHOTO' | 'VIDEO', facts: ReturnType<typeof file>, caption: Record<string, string> | null = null) => ({ id: uid('5404', n), fileId, kind, sortOrder: n, caption, file: facts })

export const STEPS_V2: StepView[] = [
  step(1, 'ALIGN_PANELS', { it: 'Allinea davanti e dietro sulle tacche della spalla.', en: 'Line up front and back on the shoulder notches.', ro: 'Aliniază fața și spatele pe crestăturile umărului.' }, { icon: 'layers', media: [medium(1, FILES.jacket, 'PHOTO', file('allinea.jpg', 'image/jpeg', 412_000), { it: 'Le tacche combaciano', en: 'Notches meet' })] }),
  step(2, 'SEAM_ALLOWANCE', { it: 'Cuci a 10 mm dal bordo, punto 3,5 per cm.', en: 'Sew 10 mm from the edge, 3.5 stitches per cm.' }, { icon: 'needle', critical: true, requiredTick: true, safety: { it: 'Tieni le dita fuori dal piedino.', en: 'Keep your fingers clear of the foot.' }, media: [medium(2, FILES.seam, 'PHOTO', file('margine.jpg', 'image/jpeg', 380_000), { it: 'Margine 10 mm', en: '10 mm allowance' })] }),
  step(3, 'PRESS_OPEN', { it: 'Apri la cucitura e stira a bassa temperatura.', en: 'Open the seam and press at low heat.' }, { icon: 'iron', safety: { it: 'Pelle: mai oltre 110 °C.', en: 'Leather: never above 110 °C.' } }),
  step(4, 'CHECK_SEAM', { it: 'Controlla che la cucitura sia dritta e senza salti.', en: 'Check the seam is straight with no skipped stitches.', ro: 'Verifică dacă cusătura este dreaptă, fără sărituri.' }, { icon: 'eye', requiredTick: true, media: [medium(3, FILES.clip, 'VIDEO', file('controllo.mp4', 'video/mp4', 6_400_000))] }),
]

export const STEPS_V3: StepView[] = [
  STEPS_V2[0]!,
  { ...STEPS_V2[1]!, text: { it: 'Cuci a 12 mm dal bordo, punto 3,5 per cm.', en: 'Sew 12 mm from the edge, 3.5 stitches per cm.' } },
  STEPS_V2[2]!,
  step(5, 'CHECK_TAPE', { it: 'Controlla che il nastro di rinforzo sia preso nella cucitura.', en: 'Check the reinforcing tape is caught in the seam.' }, { icon: 'tape', requiredTick: true, media: [medium(4, FILES.zip, 'PHOTO', file('nastro.jpg', 'image/jpeg', 298_000))] }),
  { ...STEPS_V2[3]!, sortOrder: 6 },
]

export const ANSWER_V2: VersionAnswer = { version: VERSIONS[1]!, steps: STEPS_V2, comparedWith: { id: V1, number: 1, added: ['CHECK_SEAM'], removed: [], changed: ['SEAM_ALLOWANCE'] } }
export const ANSWER_V3: VersionAnswer = { version: VERSIONS[0]!, steps: STEPS_V3, comparedWith: { id: V2, number: 2, added: ['CHECK_TAPE'], removed: [], changed: ['SEAM_ALLOWANCE'] } }
export const ANSWER_V1: VersionAnswer = { version: VERSIONS[2]!, steps: STEPS_V2.slice(0, 3).map((entry) => ({ ...entry, media: entry.media.slice(0, entry.code === 'ALIGN_PANELS' ? 1 : 0) })), comparedWith: null }

// ---- acknowledgements --------------------------------------------------------------------------------------------------------------

const SITE_N = { id: uid('2222', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
const SITE_S = { id: uid('2222', 2), code: 'STAB-S', name: 'Stabilimento Demo Sud' }

export const ACKS_COUNTS: Acknowledgements = {
  versions: [
    { versionId: V3, number: 3, status: 'DRAFT', seen: 0 },
    { versionId: V2, number: 2, status: 'PUBLISHED', seen: 12 },
    { versionId: V1, number: 1, status: 'SUPERSEDED', seen: 14 },
  ],
  current: { versionId: V2, number: 2, acknowledgementRequired: true, perSite: [{ siteId: SITE_N.id, code: SITE_N.code, name: SITE_N.name, seen: 9, of: 11 }, { siteId: SITE_S.id, code: SITE_S.code, name: SITE_S.name, seen: 3, of: 3 }] },
  people: null,
  canSeePeople: false,
}

const worker = (n: number, name: string) => ({ id: uid('6161', n), name })
export const ACKS_HR: Acknowledgements = {
  ...ACKS_COUNTS,
  canSeePeople: true,
  people: {
    rows: [
      { worker: worker(1, 'Operatore Uno'), workerHidden: false, site: { id: SITE_N.id, code: SITE_N.code }, holdsSkill: true, lastSeen: { versionNumber: 2, at: at(4, 7, 58), locale: 'it', way: 'FLOOR' }, seenCurrent: true },
      { worker: worker(2, 'Operatrice Due'), workerHidden: false, site: { id: SITE_N.id, code: SITE_N.code }, holdsSkill: true, lastSeen: { versionNumber: 1, at: at(1, 14, 5), locale: 'ro', way: 'FLOOR' }, seenCurrent: false },
      { worker: worker(3, 'Operatore Tre'), workerHidden: false, site: { id: SITE_N.id, code: SITE_N.code }, holdsSkill: true, lastSeen: null, seenCurrent: false },
      { worker: worker(4, 'Operatrice Quattro'), workerHidden: false, site: { id: SITE_N.id, code: SITE_N.code }, holdsSkill: false, lastSeen: { versionNumber: 2, at: at(5, 9, 12), locale: 'en', way: 'PAPER' }, seenCurrent: true },
      { worker: null, workerHidden: true, site: { id: SITE_S.id, code: SITE_S.code }, holdsSkill: true, lastSeen: { versionNumber: 2, at: at(6, 8, 30), locale: 'it', way: 'FLOOR' }, seenCurrent: true },
      { worker: null, workerHidden: true, site: { id: SITE_S.id, code: SITE_S.code }, holdsSkill: true, lastSeen: { versionNumber: 2, at: at(6, 8, 41), locale: 'it', way: 'FLOOR' }, seenCurrent: true },
    ],
  },
}

// ---- the list --------------------------------------------------------------------------------------------------------------------------

const listRow = (n: number, operation: { code: string; name: string }, extra: Partial<InstructionRow> = {}): InstructionRow => ({
  id: uid('5401', n),
  number: `WI-2026-${String(n).padStart(4, '0')}`,
  companyId: COMPANY_ID,
  status: 'ACTIVE',
  operation: { id: uid('4901', n), ...operation },
  style: null,
  current: { versionId: uid('5402', 10 + n), number: 1, publishedAt: at(2), steps: 4, media: 2, languages: ['en', 'it', 'ro'], missingLanguages: [], seen: 8 },
  draft: null,
  usedIn: 3,
  updatedAt: at(4),
  ...extra,
})

export const ROWS: InstructionRow[] = [
  { ...listRow(7, OPERATION), id: INSTRUCTION_ID, current: { versionId: V2, number: 2, publishedAt: at(3, 10), steps: 4, media: 3, languages: ['en', 'it', 'ro'], missingLanguages: [], seen: 12 }, draft: { versionId: V3, number: 3 }, usedIn: 2, updatedAt: at(9, 14) },
  listRow(1, { code: 'DEMO-TAG-PELLE', name: 'Taglio pelle a mano' }, { current: { versionId: uid('5402', 11), number: 4, publishedAt: at(1), steps: 6, media: 5, languages: ['en', 'it'], missingLanguages: ['ro'], seen: 6 }, usedIn: 4 }),
  listRow(3, { code: 'DEMO-CUC-ZIP', name: 'Montaggio zip anteriore' }, { style: STYLE, usedIn: 1, current: { versionId: uid('5402', 13), number: 2, publishedAt: at(6), steps: 5, media: 4, languages: ['en', 'it', 'ro'], missingLanguages: [], seen: 3 } }),
  listRow(4, { code: 'DEMO-PROT-SPALLA', name: 'Inserimento protezione spalla' }, { current: null, draft: { versionId: uid('5402', 24), number: 1 }, usedIn: 5, updatedAt: at(8) }),
  listRow(6, { code: 'DEMO-CQ-FINALE', name: 'Controllo finale capo' }, { current: { versionId: uid('5402', 16), number: 1, publishedAt: at(2), steps: 9, media: 0, languages: ['it'], missingLanguages: ['en', 'ro'], seen: 2 }, usedIn: 6 }),
  listRow(8, { code: 'DEMO-IMB', name: 'Imballo capo' }, { current: { versionId: uid('5402', 18), number: 3, publishedAt: at(7), steps: 3, media: 3, languages: ['en', 'it', 'ro'], missingLanguages: [], seen: 0 }, usedIn: 2 }),
]

export const ARCHIVED_ROWS: InstructionRow[] = [listRow(9, { code: 'DEMO-CUC-OLD', name: 'Cucitura tasca vecchia' }, { status: 'ARCHIVED', usedIn: 0, updatedAt: at(1) })]
