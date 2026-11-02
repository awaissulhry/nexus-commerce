import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ATTENDED_MINUTES_TAGS, PERSON_DENOMINATOR } from '@nexus/factory-domain/people/efficiency/rules'
import { purposeUseProblems } from '@nexus/factory-domain/people/privacy/purposes'
// The ownership files are no package export: a test reads them where they live (as privacy's purposes test does).
import { readOwnershipFolder } from '../../../../../../packages/factory-db/src/ownership'

/**
 * One person's efficiency may not stand on attended minutes while AttendanceDay.presentMinutes is kept for ATTENDANCE alone
 * (GDPR art. 5(1)(b); B-W2b-27: a new use needs a new purpose, decided by a person). The constant in the rules is checked
 * against the ownership file: when a person widens the tag this test fails, and the choice of denominator is made again.
 */

const OWNERSHIP = fileURLToPath(new URL('../../../../../../packages/factory-db/ownership', import.meta.url))

describe('what one person\'s efficiency stands on', () => {
  it('attended minutes are tagged as the rules say, and that tag does not allow a figure about one person\'s work', () => {
    const time = readOwnershipFolder(OWNERSHIP).find(({ file }) => file.endsWith('time.json'))
    const models = (time?.data as { models: Record<string, { personal: { columns: Record<string, string[]> } }> }).models
    expect(models.AttendanceDay!.personal.columns.presentMinutes).toEqual([...ATTENDED_MINUTES_TAGS])
    expect(purposeUseProblems(ATTENDED_MINUTES_TAGS, 'PERFORMANCE')).not.toEqual([])
    expect(PERSON_DENOMINATOR).toBe('TIMED_MINUTES')
  })
})
