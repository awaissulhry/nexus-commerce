import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../../../lib/api/client'
import { ApiError } from '../../../../../lib/api/errors'
import { resultCode, resultType } from '../../../../scan/scan-model'
import { lookupCarton } from './api'
import { cartonState, isCartonMarks, opensAtBench } from './model'

/** A carton on Scan anything (B-W2b-387; design floor.scan "Carton (W2b)"). */

const fakeApi = (answer: unknown): ApiClient => ({ get: async () => answer }) as unknown as ApiClient

describe("a carton's marks code", () => {
  it('is something, a hyphen and the carton number (1 to 99)', () => {
    expect(['SH-00012-2', ' sh-00012-12 ', 'SEED-SH-0002-1'].map(isCartonMarks)).toEqual([true, true, true])
    expect(['SH-00012', 'SH-00012-0', 'SH-00012-100', '-2', 'NOCODE'].map(isCartonMarks)).toEqual([false, false, false, false, false])
  })
})

describe("the carton's card", () => {
  it('reads the state: a carrier label, open, closed with its marks current, or marks to print again', () => {
    expect(cartonState({ closed: true, labelled: true, marksCurrent: true })).toBe('labelled')
    expect(cartonState({ closed: false, labelled: false, marksCurrent: false })).toBe('open')
    expect(cartonState({ closed: true, labelled: false, marksCurrent: true })).toBe('closed')
    expect(cartonState({ closed: true, labelled: false, marksCurrent: false })).toBe('marksDue')
  })

  it("maps the API's floor view: n of N, contents by colour and size with the batch, the hold's reason; never money", async () => {
    const card = await lookupCarton(
      fakeApi({
        carton: {
          shipmentId: 'sh',
          shipmentNumber: 'SH-00012',
          shipmentStatus: 'PACKED',
          hold: { reason: 'QUALITY' },
          id: 'p2',
          seq: 2,
          closed: true,
          cartonNumber: 2,
          cartonCount: 3,
          cartons: 3,
          marksCurrent: true,
          labelled: false,
          packagingType: { name: 'Big', kind: 'CARTON' },
          grossWeightKg: '4.2500',
          netWeightKg: '3.4500',
          garments: 3,
          contents: [{ styleCode: 'GIA', styleName: 'Giacca', colourwayCode: 'NERO', colourwayName: 'Nero', size: '52', quantity: 3, batchNumber: 'BT-41', serials: 0 }],
        },
      }),
      ' SH-00012-2 ',
    )
    expect(card).toEqual({
      kind: 'carton',
      code: 'SH-00012-2',
      shipmentNumber: 'SH-00012',
      shipmentStatus: 'PACKED',
      hold: 'QUALITY',
      seq: 2,
      numbered: { n: 2, of: 3 },
      cartons: 3,
      state: 'closed',
      packaging: { name: 'Big', kind: 'CARTON' },
      grossKg: '4.2500',
      netKg: '3.4500',
      garments: 3,
      contents: [{ label: 'GIA NERO 52', quantity: 3, batch: 'BT-41', serials: 0 }],
    })
    expect([resultType(card!), resultCode(card!), opensAtBench(card!)]).toEqual(['carton', 'SH-00012-2', true])
    expect(opensAtBench({ shipmentStatus: 'SHIPPED' })).toBe(false)
  })

  it('no carton with the code: none (Scan anything says nothing of this factory answers)', async () => {
    const missing = { get: async () => Promise.reject(new ApiError('not_found', 404, 'not_found', 'No carton has this code.')) } as unknown as ApiClient
    expect(await lookupCarton(missing, 'SH-9-1')).toBeNull()
  })
})
