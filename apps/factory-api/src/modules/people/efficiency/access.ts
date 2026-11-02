import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { addDays } from '@nexus/factory-domain/production/labour/rules'
import { STANDARD_REVIEW } from '@nexus/factory-domain/people/efficiency/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
import { refusePersonKeys } from '../privacy/groups'
import type { DayRange, SiteLines } from './store'

/**
 * What every efficiency read asks first. A person key never reaches a figures read (Owner answer W1; Statuto dei Lavoratori
 * art. 4): 400 in words. A line of another site is not found.
 */

export interface PersonKeys {
  readonly employeeId?: string | undefined
  readonly workerId?: string | undefined
  readonly groupBy?: string | undefined
}

export function refuseAnyPerson(query: PersonKeys): void {
  refusePersonKeys({ filters: [...(query.employeeId !== undefined ? ['employeeId'] : []), ...(query.workerId !== undefined ? ['workerId'] : [])], groupBy: query.groupBy ? [query.groupBy] : [] })
}

export function requireLine(setup: SiteLines, lineId: string | undefined): void {
  if (lineId !== undefined && !setup.lines.has(lineId)) throw new NotFoundError('Line not found.')
}

/** The days the standard review looks at, up to today in the site's zone. */
export function reviewWindow(timeZone: string, now: Date): DayRange {
  const to = businessDate(now, timeZone)
  return { from: addDays(to, 1 - STANDARD_REVIEW.windowDays), to }
}
