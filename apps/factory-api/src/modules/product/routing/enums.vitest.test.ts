import { describe, expect, it } from 'vitest'
import { MasterStatus, WorkCentreKind } from '@nexus/factory-db'
import { OPERATION_STATUSES, WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'

/** factory-domain is pure (no Prisma), so its closed lists are checked against the schema's enums here. */
describe('the routing lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...WORK_CENTRE_KINDS].sort()).toEqual(Object.values(WorkCentreKind).sort())
    expect([...OPERATION_STATUSES].sort()).toEqual(Object.values(MasterStatus).sort())
  })
})
