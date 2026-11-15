import { describe, expect, it } from 'vitest'
import { collectionProblems, collectorOf, incotermFit, leaveRefusal, missingParts, plateOf, recordRefusal } from './rules'

const complete = { status: 'PACKED' as const, transportBy: 'RECIPIENT' as const, collectedByName: 'Made-up Driver', vehiclePlate: 'AB 123 CD', signatureFileId: '0190b3c4-0000-7000-8000-000000000001' }

describe("the customer's own carrier collects (LOG-053)", () => {
  it('keeps the plate in capitals and the name on one line', () => {
    expect(plateOf('  ab  123 cd ')).toBe('AB 123 CD')
    expect(collectorOf('  Made-up   Driver ')).toBe('Made-up Driver')
    expect(collectionProblems({ collectedByName: 'Made-up Driver', vehiclePlate: 'ab-123-cd' })).toEqual([])
    expect(collectionProblems({ collectedByName: 'a\nb', vehiclePlate: 'AB/123' }).map((problem) => problem.path)).toEqual(['body/collectedByName', 'body/vehiclePlate'])
    expect(collectionProblems({ collectedByName: '   ', vehiclePlate: 'A'.repeat(21) }).map((problem) => problem.path)).toEqual(['body/collectedByName', 'body/vehiclePlate'])
    expect(collectionProblems({ collectedByName: null, vehiclePlate: undefined })).toEqual([])
  })

  it('is recorded while the goods wait packed for the customer’s carrier', () => {
    expect(recordRefusal(complete)).toBeNull()
    expect(recordRefusal({ ...complete, status: 'DRAFT' })?.code).toBe('NOT_PACKED')
    expect(recordRefusal({ ...complete, transportBy: 'CARRIER' })?.code).toBe('NOT_COLLECTED')
    expect(recordRefusal({ ...complete, status: 'SHIPPED' })?.code).toBe('LEFT')
    expect(recordRefusal({ ...complete, status: 'CANCELLED' })?.code).toBe('CANCELLED')
  })

  it('lets the goods leave only with who collected, the plate and the signed DDT', () => {
    expect(leaveRefusal(complete)).toBeNull()
    expect(missingParts({ collectedByName: null, vehiclePlate: null, signatureFileId: null })).toEqual(['NAME', 'PLATE', 'SIGNATURE'])
    const refusal = leaveRefusal({ ...complete, vehiclePlate: null, signatureFileId: null })
    expect(refusal?.code).toBe('INCOMPLETE')
    expect(refusal?.message).toMatch(/Still missing: the vehicle's plate, the DDT signed by the driver\.$/)
    expect(leaveRefusal({ ...complete, transportBy: 'CARRIER', collectedByName: null })).toBeNull()
  })

  it('reads the Incoterms rule: EXW and FCA fit, another rule or none is a warning', () => {
    expect(incotermFit('EXW')).toEqual({ fits: true, warning: null })
    expect(incotermFit('FCA')).toEqual({ fits: true, warning: null })
    expect(incotermFit('DAP')).toMatchObject({ fits: false, warning: expect.stringMatching(/^The order's terms are DAP/) })
    expect(incotermFit(null)).toMatchObject({ fits: false, warning: expect.stringMatching(/names no Incoterms rule/) })
  })
})
