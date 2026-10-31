import { describe, expect, it } from 'vitest'
import { canTransition } from '../../state/machine'
import {
  answerRefusal,
  approvedBaseOf,
  holdsLabel,
  isWaiting,
  kindOfMaterial,
  kindsOf,
  labelHoldWords,
  openRefusal,
  readChanges,
  reasonRefusal,
  reviewMachine,
  thicknessText,
  typeChanges,
  type TypeMaterial,
  type TypeSnapshot,
} from './rules'

const material = (id: string, kind: string, extra: Partial<TypeMaterial> = {}): TypeMaterial => ({ id, code: id.toUpperCase(), name: `${kind.toLowerCase()} ${id}`, kind, isPpeComponent: false, thicknessMinMm: null, thicknessMaxMm: null, ...extra })
const LEATHER = material('lea-1', 'LEATHER', { thicknessMinMm: '1.10', thicknessMaxMm: '1.30' })
const LEATHER_THIN = material('lea-2', 'LEATHER', { thicknessMinMm: '1.00', thicknessMaxMm: '1.20' })
const LEATHER_SAME = material('lea-3', 'LEATHER', { thicknessMinMm: '1.1', thicknessMaxMm: '1.3' })
const LINING = material('lin-1', 'LINING')
const LINING_2 = material('lin-2', 'LINING')
const PROTECTOR = material('pro-1', 'PROTECTOR')
const PROTECTOR_2 = material('pro-2', 'PROTECTOR')
const THREAD = material('thr-1', 'THREAD')
const THREAD_2 = material('thr-2', 'THREAD')
const ZIP = material('zip-1', 'TRIM')
const ZIP_2 = material('zip-2', 'TRIM')
const INSERT = material('ins-1', 'COMPONENT', { isPpeComponent: true })

const snapshot = (...items: TypeMaterial[]): TypeSnapshot => ({
  lines: items.map((item, index) => ({ id: `line-${item.id}-${index}`, itemId: item.id, placement: null })),
  materials: Object.fromEntries(items.map((item) => [item.id, item])),
})

describe('changes to an approved type (B-W2a-66; PRD-285, Annex V 7.2)', () => {
  it('knows which materials the approved type depends on', () => {
    expect(kindOfMaterial(LEATHER)).toBe('OUTER_LEATHER')
    expect(kindOfMaterial(LINING)).toBe('LINING')
    expect(kindOfMaterial(PROTECTOR)).toBe('PROTECTOR')
    expect(kindOfMaterial(INSERT)).toBe('PROTECTOR')
    expect(kindOfMaterial(THREAD)).toBe('SEAMS')
    expect(kindOfMaterial(ZIP)).toBeNull()
    expect(thicknessText(LEATHER)).toBe('1.1–1.3 mm')
    expect(thicknessText(material('x', 'LEATHER', { thicknessMinMm: '1.2', thicknessMaxMm: null }))).toBe('1.2 mm')
    expect(thicknessText(LINING)).toBeNull()
  })

  it('finds nothing when only a trim, a quantity or a line order changed', () => {
    const base = snapshot(LEATHER, LINING, PROTECTOR, THREAD, ZIP)
    expect(typeChanges(base, snapshot(THREAD, PROTECTOR, LINING, LEATHER, ZIP_2))).toEqual([])
    expect(typeChanges(base, snapshot(LEATHER, LEATHER, LINING, PROTECTOR, THREAD))).toEqual([])
  })

  it('finds a changed outer leather with its thickness, a lining, a protector model and the seams’ thread', () => {
    const base = snapshot(LEATHER, LINING, PROTECTOR, THREAD)
    const next = snapshot(LEATHER_THIN, LINING_2, PROTECTOR_2, THREAD_2)
    const changes = typeChanges(base, next)
    expect(kindsOf(changes)).toEqual(['OUTER_LEATHER', 'THICKNESS', 'PROTECTOR', 'SEAMS', 'LINING'])
    const leather = changes.find((change) => change.kind === 'OUTER_LEATHER')!
    expect(leather.before).toBe('LEA-1 leather lea-1 1.1–1.3 mm')
    expect(leather.after).toBe('LEA-2 leather lea-2 1–1.2 mm')
    expect(leather.bomLineId).toBe(next.lines[0]!.id)
    expect(changes.find((change) => change.kind === 'THICKNESS')).toMatchObject({ before: '1.1–1.3 mm', after: '1–1.2 mm' })
  })

  it('a leather of the same thickness changes the leather, not the thickness; an added protector is a change', () => {
    expect(kindsOf(typeChanges(snapshot(LEATHER), snapshot(LEATHER_SAME)))).toEqual(['OUTER_LEATHER'])
    const added = typeChanges(snapshot(LEATHER), snapshot(LEATHER, PROTECTOR))
    expect(added).toEqual([{ kind: 'PROTECTOR', what: 'Protector model', before: '—', after: 'PRO-1 protector pro-1', bomLineId: 'line-pro-1-1' }])
  })

  it('compares with the revision released before, or with the base of its review that still holds the label', () => {
    expect(approvedBaseOf(null, [])).toBeNull()
    expect(approvedBaseOf('r1', [])).toBe('r1')
    expect(approvedBaseOf('r2', [{ status: 'APPROVED', comparedRevisionId: 'r1' }])).toBe('r2')
    expect(approvedBaseOf('r2', [{ status: 'NOT_NEEDED', comparedRevisionId: 'r1' }])).toBe('r2')
    expect(approvedBaseOf('r2', [{ status: 'OPEN', comparedRevisionId: 'r1' }])).toBe('r1')
    expect(approvedBaseOf('r2', [{ status: 'REFUSED', comparedRevisionId: 'r1' }])).toBe('r1')
    expect(approvedBaseOf('r2', [{ status: 'NOTIFIED', comparedRevisionId: null }])).toBe('r2')
  })

  it('moves OPEN → NOTIFIED | NOT_NEEDED, NOTIFIED → APPROVED | REFUSED; the label is held until an approval or not needed', () => {
    expect(canTransition(reviewMachine, 'OPEN', 'NOTIFIED').ok).toBe(true)
    expect(canTransition(reviewMachine, 'OPEN', 'NOT_NEEDED').ok).toBe(true)
    expect(canTransition(reviewMachine, 'OPEN', 'APPROVED').ok).toBe(false)
    expect(canTransition(reviewMachine, 'NOTIFIED', 'APPROVED').ok).toBe(true)
    expect(canTransition(reviewMachine, 'NOTIFIED', 'NOT_NEEDED').ok).toBe(false)
    expect(canTransition(reviewMachine, 'REFUSED', 'APPROVED').ok).toBe(false)
    expect(['OPEN', 'NOTIFIED', 'REFUSED'].every(holdsLabel)).toBe(true)
    expect(['APPROVED', 'NOT_NEEDED'].some(holdsLabel)).toBe(false)
    expect(['OPEN', 'NOTIFIED'].every(isWaiting)).toBe(true)
    expect(isWaiting('REFUSED')).toBe(false)
  })

  it('says why a label is held, in words naming the revision, the certificate and what changed', () => {
    expect(labelHoldWords([])).toBeNull()
    expect(labelHoldWords([{ id: 'v', status: 'APPROVED', revision: 2, certificateNumber: 'CERT-A', kinds: ['LINING'] }])).toBeNull()
    expect(labelHoldWords([{ id: 'v', status: 'OPEN', revision: 2, certificateNumber: 'CERT-A', kinds: ['LINING', 'THICKNESS'] }])).toBe(
      'Revision 2 changes the type certificate CERT-A approved (lining, leather thickness): compliance has not decided whether the notified body must be told, so its class label is held (Reg. (EU) 2016/425 Annex V 7.2).',
    )
    expect(labelHoldWords([{ id: 'v', status: 'REFUSED', revision: 3, certificateNumber: 'CERT-A', kinds: [] }])).toContain('a new type examination is needed')
  })

  it('checks a decision: open only, a reason for not needed, the answer on file on a day between telling and today', () => {
    expect(openRefusal('OPEN')).toBeNull()
    expect(openRefusal('NOTIFIED')?.code).toBe('NOT_OPEN')
    expect(reasonRefusal(' ')?.code).toBe('REASON')
    expect(reasonRefusal('x'.repeat(1001))?.code).toBe('REASON')
    expect(reasonRefusal('Same leather, another tannery batch.')).toBeNull()
    const ok = { status: 'NOTIFIED', hasAnswerFile: true, answeredOn: '2026-10-20', notifiedOn: '2026-10-01', today: '2026-10-30' }
    expect(answerRefusal(ok)).toBeNull()
    expect(answerRefusal({ ...ok, status: 'OPEN' })?.code).toBe('NOT_NOTIFIED')
    expect(answerRefusal({ ...ok, hasAnswerFile: false })?.code).toBe('ANSWER_FILE')
    expect(answerRefusal({ ...ok, answeredOn: '2026-10-31' })?.code).toBe('ANSWER_DAY')
    expect(answerRefusal({ ...ok, answeredOn: '2026-09-30' })?.code).toBe('ANSWER_DAY')
  })

  it('reads stored changes back, an unknown kind as OTHER', () => {
    expect(readChanges(null)).toEqual([])
    expect(readChanges([{ kind: 'LINING', what: 'Body lining', before: 'a', after: 'b', bomLineId: 'l' }, { kind: 'GLUE', before: 'x' }, 'junk'])).toEqual([
      { kind: 'LINING', what: 'Body lining', before: 'a', after: 'b', bomLineId: 'l' },
      { kind: 'OTHER', what: 'Other construction', before: 'x', after: '', bomLineId: null },
    ])
  })
})
