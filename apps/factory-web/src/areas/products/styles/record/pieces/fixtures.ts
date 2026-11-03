import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { demoBom, demoLines, demoStyle, newStyle, recordModel, REV, REVISIONS, SIZES, STYLE_ID } from '../../demo/fixtures'
import type { StyleRecordViewModel } from '../record-model'
import { StyleRecordView } from '../view/StyleRecordView'
import type { Piece, PiecesView } from './api'
import { draftOf, markKey, NO_PIECES, type PiecesModel } from './pieces-model'

/**
 * SCR-271 (new id, B-W2b-95) — Style › Files & patterns of DEMO-JKT-01, section Pattern pieces (PRD-219, MES-055) — made-up
 * data only: revision 3 (draft) cut from the demo BOM's lines (10 the cowhide, leather; 20 the mesh lining; 30 the
 * membrane), ten pieces with the lowest hide grade each may be cut from (A for the fronts and the collar, B for the back
 * and the sleeves, C for the facings, any for the under-collar), the grain and the sizes.
 */

const uid = (n: number) => `0190f0e2-4545-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()
const LINE = { leather: '0190f0e2-4444-7000-8000-000000000001', lining: '0190f0e2-4444-7000-8000-000000000002', membrane: '0190f0e2-4444-7000-8000-000000000003' }
const GRADE = { A: uid(901), B: uid(902), C: uid(903), D: uid(904) }

type Revision = (typeof REVISIONS)[number]

const piece = (n: number, name: string, quantity: number, line: string | null, grade: string | null, grain: Piece['grain'], sizes: string[] = [], note: string | null = null): Piece => ({
  id: uid(n),
  seq: n * 10,
  name,
  quantity,
  bomLineId: line,
  minGradeId: grade,
  grain,
  sizes,
  note,
  version: 2,
  createdAt: at(20, 9),
  updatedAt: at(27, 15),
})

const PIECES: Piece[] = [
  piece(1, 'Davanti sinistro', 1, LINE.leather, GRADE.A, 'ALONG'),
  piece(2, 'Davanti destro', 1, LINE.leather, GRADE.A, 'ALONG'),
  piece(3, 'Dietro', 1, LINE.leather, GRADE.B, 'ALONG'),
  piece(4, 'Manica', 2, LINE.leather, GRADE.B, 'ALONG'),
  piece(5, 'Collo', 1, LINE.leather, GRADE.A, 'ACROSS'),
  piece(6, 'Paramontura', 2, LINE.leather, GRADE.C, 'ANY', [], 'Non si vede: va bene una scelta bassa.'),
  piece(7, 'Sottocollo', 1, LINE.leather, null, 'ANY'),
  piece(8, 'Toppa gomito', 2, LINE.leather, GRADE.B, 'BIAS', ['54', '56', '58'], 'Solo le taglie grandi hanno la toppa.'),
  piece(9, 'Fodera corpo', 1, LINE.lining, null, 'ANY'),
  piece(10, 'Membrana busto', 1, LINE.membrane, null, 'ANY', ['50', '54']),
]

export function demoPieces(options: { revision?: Revision; empty?: boolean; issues?: boolean } = {}): PiecesView {
  const rev = options.revision ?? REVISIONS[0]!
  const lines = demoLines(true).slice(0, 4)
  const pieces = options.empty ? [] : options.issues ? [...PIECES.slice(0, 7), { ...PIECES[7]!, sizes: ['56', '58', '60'] }, { ...PIECES[8]!, minGradeId: GRADE.D }] : PIECES
  const draft = rev.status === 'DRAFT'
  return {
    revision: { id: rev.id, styleId: STYLE_ID, revision: rev.revision, status: rev.status, changeNote: rev.changeNote, plannedHideYieldPct: '82', labelTemplateId: rev.labelTemplateId, releasedAt: rev.releasedAt, releasedById: rev.releasedById, version: rev.version, createdAt: rev.createdAt, updatedAt: rev.updatedAt },
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ACTIVE' },
    sizes: SIZES.map((code) => ({ code, label: code })),
    pieces,
    lines: lines.map((line) => ({ id: line.id, seq: line.seq, itemId: line.item.id, code: line.item.code, name: line.item.name, placement: line.placement, leather: line.item.kind === 'LEATHER' })),
    grades: [
      { id: GRADE.A, code: 'A', labelIt: 'Prima scelta', labelEn: 'First choice', sortOrder: 1, active: true },
      { id: GRADE.B, code: 'B', labelIt: 'Seconda scelta', labelEn: 'Second choice', sortOrder: 2, active: true },
      { id: GRADE.C, code: 'C', labelIt: 'Terza scelta', labelEn: 'Third choice', sortOrder: 3, active: true },
      ...(options.issues ? [{ id: GRADE.D, code: 'D', labelIt: 'Quarta scelta', labelEn: 'Fourth choice', sortOrder: 4, active: false }] : []),
    ],
    issues:
      draft && options.issues
        ? [
            { code: 'SIZE_NOT_IN_RANGE', pieceId: PIECES[7]!.id, lineId: null, message: 'x' },
            { code: 'GRADE_NOT_LEATHER', pieceId: PIECES[8]!.id, lineId: LINE.lining, message: 'x' },
            { code: 'GRADE_RETIRED', pieceId: PIECES[8]!.id, lineId: null, message: 'x' },
          ]
        : draft && options.empty
          ? [{ code: 'LEATHER_LINE_NO_PIECES', pieceId: null, lineId: LINE.leather, message: 'x' }]
          : [],
    editable: draft,
  }
}

const ready = (view: PiecesView, extra: Partial<PiecesModel> = {}): PiecesModel => ({ ...NO_PIECES, part: { status: 'ready', value: view }, ...extra })

const files = (pieces: PiecesModel, overrides: Partial<StyleRecordViewModel> = {}, role: 'owner' | 'production' | 'sales' | 'product' = 'owner') => recordModel(role, { tab: 'files', pieces, ...overrides })
const released = { style: { status: 'ready' as const, value: demoStyle() }, revisionId: REV.r2, bom: { status: 'ready' as const, value: demoBom({ revision: REVISIONS[1] }) } }

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-271',
  title: 'Style studio: Files & patterns (pattern pieces)',
  view: StyleRecordView,
  cases: [
    { id: 'owner', label: 'Pattern pieces (draft revision 3)', model: files(ready(demoPieces())), note: 'Ten pieces, 13 per garment; each cell saves by itself; the grade only on the leather line ("Not leather: no grade" on the lining and the membrane); sizes "All sizes", "54–58", "50, 54".' },
    {
      id: 'saving',
      label: 'Cells saving and refused',
      model: files(ready(demoPieces(), { marks: { [markKey(PIECES[3]!.id, 'quantity')]: { state: 'saving', value: '2' }, [markKey(PIECES[4]!.id, 'name')]: { state: 'refused', value: 'Manica', problem: 'pieces.problem.nameTaken' }, [markKey(PIECES[5]!.id, 'minGradeId')]: { state: 'saving', value: GRADE.B } } })),
      note: 'The quantity of Manica saving (↻), Collo refused with "!" and our words (the old value stays), Paramontura moving to grade B.',
    },
    {
      id: 'offline',
      label: 'Offline: changes wait',
      model: files(ready(demoPieces(), { offline: true, marks: { [markKey(PIECES[2]!.id, 'grain')]: { state: 'waiting', value: 'ACROSS' }, [markKey(PIECES[6]!.id, 'note')]: { state: 'waiting', value: 'Fodera a vista sul collo' } } })),
      note: 'Two changes wait on this page (…) and are sent when the connection is back; nothing else is queued.',
    },
    { id: 'issues', label: 'Things to look at', model: files(ready(demoPieces({ issues: true }))), note: 'A size no longer in the range (60), a grade on the lining, a retired grade D: in words, never blocking.' },
    { id: 'selected', label: 'Rows selected: bulk actions', model: files(ready(demoPieces(), { selected: [PIECES[0]!.id, PIECES[1]!.id, PIECES[4]!.id] })), note: '"Minimum grade for 3…" and "Remove 3" in the toolbar.' },
    { id: 'selected-held', label: 'Selection with a lining piece: grade held', model: files(ready(demoPieces(), { selected: [PIECES[3]!.id, PIECES[8]!.id] })), note: 'Minimum grade… is held: "Not on a leather line: Fodera corpo".' },
    { id: 'bulk-grade', label: 'Minimum grade for the selection', model: files(ready(demoPieces(), { selected: [PIECES[0]!.id, PIECES[1]!.id, PIECES[4]!.id], dialog: { kind: 'grade', ids: [PIECES[0]!.id, PIECES[1]!.id, PIECES[4]!.id] } })) },
    { id: 'add', label: 'Add a piece', model: files(ready(demoPieces(), { dialog: { kind: 'piece', pieceId: null } })), note: 'n opens it; name, pieces per garment, line, grade (only on leather), grain, sizes, note; ⌘↵ adds.' },
    {
      id: 'add-filled',
      label: 'Add a piece, filled in',
      model: files(ready(demoPieces(), { dialog: { kind: 'piece', pieceId: null }, draft: { ...draftOf(null), name: 'Taschino', quantity: '2', bomLineId: LINE.leather, minGradeId: GRADE.B, grain: 'ALONG', sizes: ['50', '52'] } })),
    },
    { id: 'add-taken', label: 'Add a piece: name taken', model: files(ready(demoPieces(), { dialog: { kind: 'piece', pieceId: null }, draft: { ...draftOf(null), name: 'manica' } })), note: 'Held: "Another piece of this revision has this name."' },
    { id: 'edit', label: 'Open a piece (Enter, or a card on a phone)', model: files(ready(demoPieces(), { dialog: { kind: 'piece', pieceId: PIECES[7]!.id } })) },
    { id: 'sizes', label: 'Sizes of a piece', model: files(ready(demoPieces(), { dialog: { kind: 'sizes', pieceId: PIECES[7]!.id } })), note: 'Every size (follows the range) or only the sizes ticked.' },
    { id: 'remove', label: 'Remove two pieces', model: files(ready(demoPieces(), { dialog: { kind: 'remove', ids: [PIECES[8]!.id, PIECES[9]!.id] } })) },
    { id: 'released', label: 'Released revision 2 (frozen)', model: files(ready(demoPieces({ revision: REVISIONS[1] })), released), note: 'Cells drawn as text; the band says "Rev 2 is released and frozen · Go to Rev 3 (draft)".' },
    {
      id: 'no-permission',
      label: 'No edit right (viewer)',
      model: recordModel('owner', { tab: 'files', pieces: ready(demoPieces()), can: { ...recordModel('owner').can, bomManage: false } }),
      note: 'Read only: "your role can view the pattern pieces, not change them"; Add piece held with why.',
    },
    { id: 'sales', label: '(sales has no BOM: tab absent)', model: recordModel('sales', { tab: 'files' }), note: 'Sales does not read BOMs: Files & patterns is absent, Overview opens.' },
    {
      id: 'empty',
      label: 'No pieces yet',
      model: files(ready(demoPieces({ empty: true }))),
      note: '"No pieces listed" + Add piece; the leather line no piece names is pointed out.',
    },
    { id: 'empty-new', label: 'A new style (no pieces, revision 1)', model: recordModel('owner', { tab: 'files', style: { status: 'ready', value: newStyle() }, revisionId: REV.r1, pieces: ready(demoPieces({ revision: { ...REVISIONS[2]!, status: 'DRAFT' }, empty: true })) }) },
    { id: 'loading', label: 'Loading', model: files({ ...NO_PIECES, part: { status: 'loading' } }) },
    { id: 'error', label: 'Could not load', model: files({ ...NO_PIECES, part: { status: 'error', problem: 'problem.read.unavailable' } }), note: 'The rest of the record stays usable.' },
  ],
})
