import { describe, expect, it } from 'vitest'
import { labelJobKind, marksCode, reprintReasonOf, reprintRefusal, type ReprintFacts } from './rules'

const T0 = new Date('2026-11-14T08:00:00Z')
const LATER = new Date('2026-11-14T09:00:00Z')

const carrier: ReprintFacts = {
  shipmentStatus: 'PACKED',
  payloadKind: 'ZPL',
  kind: 'CARRIER',
  job: { scanId: 'TRACK-0001', createdAt: LATER },
  parcel: { seq: 1, trackingNumber: 'TRACK-0001', labelledAt: T0, cartonNumber: 1, marksPrintedAt: T0, marksCurrent: true },
}

describe('reprint a label with a reason (LOG-027)', () => {
  it('keeps a reason of 3 to 200 characters on one line, trimmed', () => {
    expect(reprintReasonOf('  torn at the dock ')).toEqual({ reason: 'torn at the dock' })
    expect(reprintReasonOf('no')).toEqual({ problem: 'Say why the label is printed again, in 3 to 200 characters.' })
    expect(reprintReasonOf('x'.repeat(201))).toHaveProperty('problem')
    expect(reprintReasonOf('torn\nat the dock')).toEqual({ problem: 'Say why on one line.' })
  })

  it("tells the carton's marks from a carrier label and any other label", () => {
    expect(labelJobKind({ scanId: marksCode('SH-00001', 2), labelKind: 'CARTON' }, 'SH-00001')).toBe('MARKS')
    expect(labelJobKind({ scanId: 'TRACK-0001', labelKind: 'CARTON' }, 'SH-00001')).toBe('CARRIER')
    expect(labelJobKind({ scanId: '003123456789012345', labelKind: 'SSCC' }, 'SH-00001')).toBe('OTHER')
  })

  it('prints the current carrier label again, never a voided one', () => {
    expect(reprintRefusal(carrier)).toBeNull()
    expect(reprintRefusal({ ...carrier, parcel: { ...carrier.parcel, trackingNumber: 'TRACK-0009' } })?.code).toBe('LABEL_VOIDED')
    expect(reprintRefusal({ ...carrier, parcel: { ...carrier.parcel, trackingNumber: null, labelledAt: null } })?.code).toBe('LABEL_VOIDED')
    expect(reprintRefusal({ ...carrier, job: { ...carrier.job, createdAt: new Date('2026-11-13T08:00:00Z') } })?.code).toBe('LABEL_VOIDED')
  })

  it('prints current marks again, never marks a carton outgrew', () => {
    const marks: ReprintFacts = { ...carrier, kind: 'MARKS', job: { scanId: 'SH-00001-1', createdAt: T0 } }
    expect(reprintRefusal(marks)).toBeNull()
    expect(reprintRefusal({ ...marks, parcel: { ...marks.parcel, marksCurrent: false } })?.code).toBe('MARKS_CHANGED')
    expect(reprintRefusal({ ...marks, job: { ...marks.job, createdAt: new Date('2026-11-14T07:00:00Z') } })?.code).toBe('MARKS_CHANGED')
  })

  it('prints no document, and nothing once the goods are delivered, back or the shipment cancelled', () => {
    expect(reprintRefusal({ ...carrier, payloadKind: 'PDF' })?.code).toBe('NOT_A_LABEL')
    for (const status of ['DELIVERED', 'RETURNED', 'CANCELLED'] as const) expect(reprintRefusal({ ...carrier, shipmentStatus: status })?.code).toBe('GOODS_GONE')
    expect(reprintRefusal({ ...carrier, shipmentStatus: 'SHIPPED' })).toBeNull()
  })
})
