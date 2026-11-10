import { describe, expect, it } from 'vitest'
import { addPlacementBody, updatePlacementBody } from './contracts'
import {
  coveredSizes,
  fieldProblems,
  levelServes,
  movedOrder,
  overlapProblems,
  overlaps,
  placementFindings,
  placementWords,
  protectorProblems,
  standardFamily,
  type FindingInput,
  type PlacementFacts,
  type ProtectorFacts,
} from './rules'

const RANGE = ['50', '52', '54']
const P300 = 'pro-300'
const P330 = 'pro-330'
const P320 = 'pro-320'
const protector = (id: string, code: string, standard: string | null, level: string | null, approval: ProtectorFacts['approval'] = 'APPROVED'): ProtectorFacts => ({ id, code, name: code, kind: 'PROTECTOR', approval, standard, level })
const PROTECTORS = new Map([
  [P300, protector(P300, 'PRO-300', 'EN 1621-1:2012', '2')],
  [P330, protector(P330, 'PRO-330', null, null)],
  [P320, protector(P320, 'PRO-320', 'EN 1621-2:2014', '1')],
])
const placement = (id: string, seq: number, pocket: PlacementFacts['pocket'], itemId: string, standard: string, level: string, sizes: string[] = []): PlacementFacts => ({ id, seq, pocket, protectorItemId: itemId, standard, level, sizes })
const SHOULDER = placement('s', 1, 'SHOULDER', P300, 'EN 1621-1:2012', '2', ['50', '52'])
const ELBOW = placement('e', 2, 'ELBOW', P330, 'EN 1621-1:2012', '1')
const BACK = placement('b', 3, 'BACK', P320, 'EN 1621-2:2014', '1')

const input = (overrides: Partial<FindingInput> = {}): FindingInput => ({
  range: RANGE,
  placements: [SHOULDER, ELBOW, BACK],
  protectors: PROTECTORS,
  bomLines: [{ seq: 30, itemId: P300, sizeDependent: false, qty: '2.0000', sizes: [] }],
  itemCertificates: new Map([[P300, [{ number: 'CERT-2', standard: 'EN 1621-1:2012', ppeClass: '2', performanceLevels: null, sizes: [] }]]]),
  styleCertificates: [{ number: 'CERT-1', standard: 'EN 17092-3:2020', ppeClass: 'AA', performanceLevels: null, sizes: [] }],
  ...overrides,
})

describe('protector placement: the words of a standard and a level (PRD-074)', () => {
  it('reads a standard without its edition and a level that serves', () => {
    expect(standardFamily('en  1621-1:2012')).toBe('EN 1621-1')
    expect(levelServes('2', '1')).toBe(true)
    expect(levelServes('1', '2')).toBe(false)
    expect(levelServes(null, '1')).toBe(false)
    expect(coveredSizes([], RANGE)).toEqual(RANGE)
    expect(coveredSizes(['54', '50'], RANGE)).toEqual(['50', '54'])
  })
})

describe('refused on write', () => {
  it('a field out of shape, a size not in the range or twice', () => {
    expect(fieldProblems({ pocket: 'ELBOW', standard: 'EN 1621-1:2012', level: '1', sizes: ['50'], positionNote: 'Left and right' }, RANGE)).toEqual([])
    const bad = fieldProblems({ pocket: 'ELBOW', standard: ' ', level: '3', sizes: ['50', '50', '58'], positionNote: '' }, RANGE)
    expect(bad.map((issue) => issue.path)).toEqual(['standard', 'level', 'positionNote', 'sizes/1', 'sizes/2'])
    expect(bad[4]!.message).toBe("Size 58 is not one of the style's sizes (50, 52, 54).")
  })

  it('a material that is not a protector or is blocked', () => {
    expect(protectorProblems(PROTECTORS.get(P300)!)).toEqual([])
    expect(protectorProblems({ ...PROTECTORS.get(P300)!, kind: 'LEATHER' })[0]!.message).toBe('PRO-300 is not a protector: a pocket takes a PROTECTOR material.')
    expect(protectorProblems({ ...PROTECTORS.get(P300)!, approval: 'BLOCKED' })[0]!.path).toBe('protectorItemId')
    expect(protectorProblems(null)[0]!.message).toBe('No such material.')
  })

  it('two placements of one pocket on one size', () => {
    const second = placement('s2', 4, 'SHOULDER', P330, 'EN 1621-1:2012', '1', ['52', '54'])
    expect(overlaps([SHOULDER, ELBOW, second], RANGE)).toEqual([{ a: SHOULDER, b: second, sizes: ['52'] }])
    expect(overlapProblems([SHOULDER, ELBOW, second], 's2', RANGE)).toEqual([
      { path: 'sizes', message: 'The shoulder pocket already takes placement 1 for size 52: one protector per pocket and size. Give the sizes to one placement or the other.' },
    ])
    expect(overlapProblems([SHOULDER, ELBOW, { ...second, sizes: ['54'] }], 's2', RANGE)).toEqual([])
    // Every size (none named) meets every other placement of the pocket.
    expect(overlapProblems([ELBOW, placement('e2', 5, 'ELBOW', P300, 'EN 1621-1:2012', '2', ['54'])], 'e2', RANGE)[0]!.message).toMatch(/elbow pocket already takes placement 2 for size 54/)
  })
})

describe('things to look at (the BOM, the protector, the certificates)', () => {
  it('the seed jacket: protectors not in the BOM, uncertified, a BOM protector without its pocket for 54', () => {
    const findings = placementFindings(input())
    expect(findings.map((finding) => [finding.code, finding.params.item ?? '', finding.sizes.join(',')])).toEqual([
      ['NOT_IN_BOM', 'PRO-330', '50,52,54'],
      ['NO_ITEM_CERTIFICATE', 'PRO-330', '50,52,54'],
      ['NOT_IN_BOM', 'PRO-320', '50,52,54'],
      ['NO_ITEM_CERTIFICATE', 'PRO-320', '50,52,54'],
      ['BOM_NOT_PLACED', 'PRO-300', '54'],
    ])
    expect(findings[4]!.message).toBe('PRO-300 is in the BOM for size 54, but no pocket places it there.')
  })

  it('all in agreement: nothing to look at', () => {
    const bom = [P300, P330, P320].map((itemId, index) => ({ seq: 30 + index, itemId, sizeDependent: false, qty: '2', sizes: [] }))
    const cert = (standard: string, level: string) => [{ number: `C-${standard}`, standard, ppeClass: level, performanceLevels: null, sizes: [] }]
    const findings = placementFindings(
      input({
        placements: [{ ...SHOULDER, sizes: [] }, ELBOW, BACK],
        bomLines: bom,
        itemCertificates: new Map([
          [P300, cert('EN 1621-1:2012', '2')],
          [P330, cert('EN 1621-1:2012', '1')],
          [P320, cert('EN 1621-2:2014', '2')],
        ]),
      }),
    )
    expect(findings).toEqual([])
    expect(placementWords([SHOULDER, ELBOW, BACK], findings)).toBe('3 placement(s) in 3 pocket(s) · nothing to look at')
  })

  it('a pocket standard, the protector’s own standard and level, a certificate below the level', () => {
    const findings = placementFindings(
      input({
        placements: [placement('x', 1, 'BACK', P300, 'EN 1621-1:2012', '2'), placement('y', 2, 'ELBOW', P320, 'EN 1621-1:2012', '2')],
        bomLines: [],
        itemCertificates: new Map([
          [P300, [{ number: 'C-1', standard: 'EN 1621-1:2012', ppeClass: '1', performanceLevels: null, sizes: [] }]],
          [P320, [{ number: 'C-2', standard: 'EN 1621-2:2014', ppeClass: '1', performanceLevels: null, sizes: [] }]],
        ]),
      }),
    )
    const codes = findings.map((finding) => `${finding.placementId}:${finding.code}`)
    expect(codes).toContain('x:POCKET_STANDARD')
    expect(codes).toContain('x:ITEM_CERTIFICATE_LEVEL')
    expect(codes).toContain('y:ITEM_STANDARD')
    expect(codes).toContain('y:ITEM_LEVEL')
    expect(findings.find((finding) => finding.code === 'ITEM_LEVEL')!.message).toBe('PRO-320 is a level 1 protector; the elbow pocket asks level 2.')
    expect(findings.find((finding) => finding.code === 'POCKET_STANDARD')!.message).toBe('The back pocket takes a protector tested to EN 1621-2; placement 1 names EN 1621-1:2012.')
  })

  it('a size-dependent BOM line without the sizes the pocket places it in', () => {
    const findings = placementFindings(input({ placements: [SHOULDER], bomLines: [{ seq: 30, itemId: P300, sizeDependent: true, qty: '0', sizes: [{ size: '50', qty: '2' }, { size: '52', qty: '0' }] }] }))
    expect(findings.map((finding) => [finding.code, finding.sizes.join(',')])).toEqual([['NOT_IN_BOM_SIZES', '52']])
  })

  it("the style's certificate: a pocket granted at level 2 placed at 1, a granted pocket with no placement", () => {
    const findings = placementFindings(
      input({
        placements: [{ ...SHOULDER, level: '1', sizes: [] }],
        bomLines: [{ seq: 30, itemId: P300, sizeDependent: false, qty: '2', sizes: [] }],
        styleCertificates: [{ number: 'CERT-1', standard: 'EN 17092-3:2020', ppeClass: 'AA', performanceLevels: { Shoulder: '2', back: '1', class: 'AA' }, sizes: [] }],
      }),
    )
    const style = findings.filter((finding) => finding.code.startsWith('STYLE_'))
    expect(style.map((finding) => finding.message)).toEqual([
      'Certificate CERT-1 was granted with a level 2 shoulder protector; placement 1 asks level 1.',
      'Certificate CERT-1 was granted with a back protector (level 1); no pocket places one.',
    ])
  })
})

describe('bodies and the order', () => {
  it('defaults a new placement to every size and no note', () => {
    expect(addPlacementBody.parse({ pocket: 'KNEE', protectorItemId: '0190f0e2-0000-7000-8000-000000000001' })).toEqual({ pocket: 'KNEE', protectorItemId: '0190f0e2-0000-7000-8000-000000000001', sizes: [], positionNote: null })
    expect(updatePlacementBody.safeParse({ version: 1, level: '3' }).success).toBe(false)
    expect(updatePlacementBody.safeParse({ version: 1, positionNote: null }).success).toBe(true)
  })

  it('moves one up or down, never past an end', () => {
    expect(movedOrder([SHOULDER, ELBOW, BACK], 'e', -1)).toEqual(['e', 's', 'b'])
    expect(movedOrder([SHOULDER, ELBOW, BACK], 's', -1)).toBeNull()
    expect(movedOrder([SHOULDER, ELBOW, BACK], 'b', 1)).toBeNull()
  })
})
