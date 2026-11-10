import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { CAN, recordModel, REV, REVISIONS, SIZES, STYLE_ID } from '../../demo/fixtures'
import { demoPieces } from '../pieces/fixtures'
import { NO_PIECES } from '../pieces/pieces-model'
import type { StyleRecordViewModel } from '../record-model'
import { StyleRecordView } from '../view/StyleRecordView'
import type { PatternFilesView, PatternFileView } from './api'
import { NO_PATTERNS, type PatternsModel } from './patterns-model'

/**
 * SCR-304-patterns (B-W2b-236) — Style › Files & patterns › Pattern files per revision and size range of DEMO-JKT-01 (design
 * products.styles rec:Style style.files.files "Pattern files per revision and size range (Lectra, Gerber, DXF-AAMA; W2b)";
 * PRD-218), made-up data only: the draft revision 3's graded DXF pattern in its second version, a Lectra marker for 46–50 and
 * a CAD drawing; the released revision 2's frozen pattern with a marker added for production. Cases: the product office, a
 * released revision, Add (sending), details, a new version, the versions, remove two, a viewer, the edit rule, empty, loading,
 * a failed read. The pattern pieces follow below on the same tab.
 */

const uid = (n: number) => `0190f0e2-3050-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 10, day, hour)).toISOString()
const DRAFT = { id: REV.r3, revision: 3, status: 'DRAFT' as const }
const RELEASED = { id: REV.r2, revision: 2, status: 'RELEASED' as const }
const FROZEN = 'frozen'

function file(n: number, name: string, kind: PatternFileView['kind'], format: PatternFileView['format'], sizes: string[], note: string | null, versions = 1, extra: Partial<PatternFileView> = {}): PatternFileView {
  const series = Array.from({ length: versions }, (_, index) => ({ fileId: uid(100 + n * 10 + index), versionNo: versions - index, name: index === 0 ? name : name.replace(/(\.\w+)$/, ` v${versions - index}$1`), sizeBytes: 380_000 + index * 1000, status: 'AVAILABLE', createdAt: at(2 + n + (versions - index), 10), current: index === 0 }))
  return {
    id: uid(n),
    version: 3,
    kind,
    format,
    sizes,
    note,
    file: { id: series[0]!.fileId, name, contentType: name.endsWith('.pdf') ? 'application/pdf' : 'application/dxf', sizeBytes: 380_000, status: 'AVAILABLE', versionNo: versions },
    versions: series,
    frozen: null,
    createdAt: at(2 + n, 10),
    updatedAt: at(6 + n, 15),
    ...extra,
  }
}

function draftView(extra: Partial<PatternFilesView> = {}): PatternFilesView {
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ACTIVE', sizes: SIZES },
    revision: DRAFT,
    files: [
      file(1, 'DEMO-JKT-01 r3 graded.dxf', 'PATTERN', 'DXF_AAMA', [], 'Gradato 46–58, margini cucitura 10 mm', 2),
      file(2, 'DEMO-JKT-01 r3 piazzamento 46-50.dxf', 'MARKER', 'LECTRA', ['46', '48', '50'], 'Pelle intera, resa 82 %'),
      file(3, 'DEMO-JKT-01 r3 disegno tecnico.pdf', 'CAD', 'PDF', [], null),
    ],
    refusal: null,
    kinds: { PATTERN: null, MARKER: null, CAD: null, OTHER: null },
    at: at(10, 9),
    ...extra,
  }
}

function releasedView(): PatternFilesView {
  const frozen = 'Revision 2 is released: its pattern files are its specification and do not change.'
  return {
    ...draftView(),
    revision: RELEASED,
    files: [
      file(4, 'DEMO-JKT-01 r2 pattern.dxf', 'PATTERN', 'DXF_AAMA', [], null, 1, { frozen: FROZEN }),
      file(5, 'DEMO-JKT-01 r2 marker 52-54.plt', 'MARKER', 'GERBER', ['52', '54'], 'Per il lotto di novembre'),
    ],
    kinds: { PATTERN: frozen, MARKER: null, CAD: frozen, OTHER: null },
  }
}

const ready = (value: PatternFilesView = draftView(), extra: Partial<PatternsModel> = {}): PatternsModel => ({ ...NO_PATTERNS, canManage: true, canEdit: true, part: { status: 'ready', value }, ...extra })
const pieces = { ...NO_PIECES, part: { status: 'ready' as const, value: demoPieces() } }
const files = (patternFiles: PatternsModel, role: 'owner' | 'production' | 'sales' | 'product' = 'owner', extra: Partial<StyleRecordViewModel> = {}): StyleRecordViewModel => recordModel(role, { tab: 'files', patternFiles, pieces, ...extra })

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-304-patterns',
  title: 'Style studio: Files & patterns › Pattern files per revision and size range',
  view: StyleRecordView,
  cases: [
    { id: 'owner', label: 'Pattern files of draft revision 3', model: files(ready()), note: 'The DXF pattern is in its second version (the files platform’s series); the marker is for 46–50; the CAD drawing is a PDF.' },
    { id: 'released', label: 'Released revision 2: the pattern frozen, a marker added', model: files(ready(releasedView()), 'owner', { revisionId: REV.r2 }), note: 'Remove N and ⋯ say why a frozen row does not change; a new marker can still be added.' },
    { id: 'add', label: 'Add a pattern file (DXF sent in parts)', model: files(ready(draftView(), { dialog: { kind: 'add' } })) },
    { id: 'add-sending', label: 'Add: sending the file', model: files(ready(draftView(), { dialog: { kind: 'add' }, sending: { state: 'sending', problem: null } })) },
    { id: 'add-type', label: 'Add: a native file refused in words', model: files(ready(draftView(), { notice: { key: 'patterns.add.wrongType', tone: 'danger' } })) },
    { id: 'edit', label: 'Details: kind, format, sizes, note', model: files(ready(draftView(), { dialog: { kind: 'edit', id: uid(2) } })) },
    { id: 'new-version', label: 'New version of the pattern', model: files(ready(draftView(), { dialog: { kind: 'version', id: uid(1) } })) },
    { id: 'versions', label: 'The versions of the pattern', model: files(ready(draftView(), { dialog: { kind: 'versions', id: uid(1) } })) },
    { id: 'selected', label: 'Two selected: Remove 2', model: files(ready(draftView(), { selected: [uid(2), uid(3)] })) },
    { id: 'remove', label: 'Remove two files?', model: files(ready(draftView(), { selected: [uid(2), uid(3)], dialog: { kind: 'remove', ids: [uid(2), uid(3)] } })) },
    { id: 'viewer', label: 'A role that reads the BOM, not changes it', model: files(ready(draftView(), { canManage: false, canEdit: false }), 'owner', { can: CAN.viewer }) },
    { id: 'rule', label: 'The style’s edit rule holds changes', model: files(ready(draftView({ refusal: 'Style DEMO-JKT-01 is discontinued: nothing of it changes in this state.' }))) },
    { id: 'offline', label: 'Offline', model: files(ready(draftView(), { offline: true })) },
    { id: 'empty', label: 'No pattern files yet', model: files(ready(draftView({ files: [] }))) },
    { id: 'loading', label: 'Loading', model: files({ ...NO_PATTERNS, part: { status: 'loading' } }) },
    { id: 'error', label: 'The pattern files could not be read', model: files({ ...NO_PATTERNS, part: { status: 'error', problem: 'patterns.problem.read' } }) },
    { id: 'no-revision', label: 'No revision yet', model: files({ ...NO_PATTERNS, part: { status: 'idle' } }, 'owner', { revisionId: null }), note: `The tab of a style without revisions (${REVISIONS.length} demo revisions otherwise).` },
  ],
})
