import { describe, expect, it } from 'vitest'
import { mapError } from '../../../core/errors'
import { adapterFor, adapterOf } from '../../../platform/approvals-out/records'
import { DecisionRefusedError } from './store'

/** Sample decisions on the wire (B-W2b-252): a refusal is a 409 in words; the brand is asked on a round or a swatch. */

describe('sample decisions', () => {
  it('a refusal is a 409 with its code as the issue', () => {
    const mapped = mapError(new DecisionRefusedError({ code: 'BRAND_ASKED', message: 'Sample round SR-2026-0001 waits for the brand\'s answer (by 2026-11-20): withdraw the request first, then record the decision.' }))
    expect(mapped).toMatchObject({ status: 409, code: 'conflict', issues: [{ path: 'refusal/BRAND_ASKED' }] })
  })

  it('registers a sample round (SAMPLE) and a swatch (COLOUR, LEATHER) with the approvals engine, and nothing else on them', () => {
    expect(adapterOf('SAMPLE', 'SampleRound')).toMatchObject({ recordType: 'SampleRound', view: 'sales.samples.view', ask: 'sales.samples.decide' })
    expect(adapterOf('COLOUR', 'SampleRound')).toBeUndefined()
    expect(adapterOf('COLOUR', 'SampleSwatch')).toBe(adapterFor('SampleSwatch'))
    expect(adapterOf('LEATHER', 'SampleSwatch')?.ask).toBe('sales.samples.decide')
    expect(adapterOf('ARTWORK', 'SampleSwatch')).toBeUndefined()
    expect(adapterOf('SAMPLE', 'SampleSwatch')).toBeUndefined()
  })
})
