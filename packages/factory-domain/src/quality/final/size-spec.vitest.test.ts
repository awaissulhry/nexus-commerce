import { describe, expect, it } from 'vitest'
import { bandOf } from '../../product/measures/rules'
import { gradedPointOf, measurementPass, resolveMeasurements, type GradedSpec, type PlanCheck } from './plan'

/**
 * B-W2b-224 (SZ1:01): the final inspection's size check reads the approved graded spec of the work order's revision — a
 * size chart check (no nominal of its own) and a point measured outside the plan take the spec's nominal ± tolerance of
 * the point and size; a plan check with its own nominal still binds; a made-to-measure unit is checked against the
 * rider's profile.
 */

const check = (code: string, extra: Partial<PlanCheck> = {}): PlanCheck => ({
  id: `00000000-0000-4000-8000-${code.padStart(12, '0').slice(-12).replace(/[^0-9]/g, '0')}`,
  code,
  labelIt: code,
  labelEn: code,
  type: 'MEASUREMENT',
  checkClass: 'MAJOR',
  mandatory: true,
  photoRequired: false,
  nominal: null,
  tolerance: null,
  uom: null,
  choices: [],
  ...extra,
})

const CHEST = check('CHEST_W')
const BACK = check('BACK_LEN', { nominal: '70.000', tolerance: '1.000', uom: 'CM' })
const band = bandOf('60', '1', '1.5')
const spec: GradedSpec = {
  revision: 3,
  points: [
    { code: 'CHEST_W', name: 'Chest width', size: '52', nominal: '58.000', tolerance: '1.000', uom: 'CM', words: '58 ± 1 cm' },
    { code: 'CHEST_W', name: 'Chest width', size: '54', nominal: band.nominal, tolerance: band.tolerance, uom: 'CM', words: '60 −1/+1.5 cm' },
    { code: 'BACK_LEN', name: 'Back length', size: '52', nominal: '72.000', tolerance: '1.000', uom: 'CM', words: '72 ± 1 cm' },
    { code: 'SLEEVE_LEN', name: 'Sleeve', size: '52', nominal: '64.000', tolerance: '0.500', uom: 'CM', words: '64 ± 0.5 cm' },
  ],
}
const context = { checks: [CHEST, BACK], sampleSize: 3, sizes: ['52', '54'], mtm: null, spec }

describe('the size check against the graded spec (SZ1:01)', () => {
  it('a size chart check and a free point take the spec of their size; a plan nominal still binds', () => {
    const { rows, problems } = resolveMeasurements(
      [
        { checkCode: 'CHEST_W', size: '52', measured: '58.9' },
        { checkCode: 'CHEST_W', size: '54', measured: '61.4' },
        { pointCode: 'sleeve_len', size: '52', measured: '64.6' },
        { checkCode: 'BACK_LEN', size: '52', measured: '70.5' },
      ],
      context,
    )
    expect(problems).toEqual([])
    expect(rows.map((row) => [row.pointCode, row.size, row.value?.nominal, row.value?.tolerance, row.value?.source])).toEqual([
      ['CHEST_W', '52', '58.000', '1.000', 'SPEC'],
      ['CHEST_W', '54', '60.250', '1.250', 'SPEC'],
      ['sleeve_len', '52', '64.000', '0.500', 'SPEC'],
      ['BACK_LEN', '52', '70.000', '1.000', 'PLAN'],
    ])
    // The asymmetric band 59 … 61.5 is kept exactly: 61.4 passes, 61.6 does not, 58.9 does not.
    expect(measurementPass('61.4', band.nominal, band.tolerance)).toBe(true)
    expect(measurementPass('61.6', band.nominal, band.tolerance)).toBe(false)
    expect(measurementPass('58.9', band.nominal, band.tolerance)).toBe(false)
    expect(rows[2]!.value?.uom).toBe('CM')
  })

  it('refuses a typed nominal the spec sets otherwise, and types a size the spec has no value for', () => {
    const { problems } = resolveMeasurements([{ checkCode: 'CHEST_W', size: '52', measured: '58', nominal: '57', tolerance: '1' }], context)
    expect(problems).toEqual([{ path: 'measurements/0/nominal', message: 'The measurement spec of revision 3 sets CHEST_W of size 52 at 58 ± 1 cm: nothing else is typed.' }])
    const same = resolveMeasurements([{ checkCode: 'CHEST_W', size: '52', measured: '58', nominal: '58', tolerance: '1' }], context)
    expect(same.problems).toEqual([])
    const unknown = resolveMeasurements([{ pointCode: 'SLEEVE_LEN', size: '54', measured: '65' }], context)
    expect(unknown.problems.map((problem) => problem.path)).toEqual(['measurements/0/nominal', 'measurements/0/tolerance'])
  })

  it('finds a cell whatever the letter case of the code, never another size', () => {
    expect(gradedPointOf(spec, 'chest_w', '54')?.words).toBe('60 −1/+1.5 cm')
    expect(gradedPointOf(spec, 'CHEST_W', '50')).toBeUndefined()
    expect(gradedPointOf(null, 'CHEST_W', '52')).toBeUndefined()
  })
})
