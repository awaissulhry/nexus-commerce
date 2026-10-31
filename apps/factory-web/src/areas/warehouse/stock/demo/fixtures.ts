import { standardReasonsOf } from '@nexus/factory-domain/reasons/standard'
import type { ReasonList } from '@nexus/factory-domain/reasons/lists'
import type { PickerReason } from '../../../_shared/reasons/api'
import { at, SITE, uid } from '../../../_shared/stock/fixtures'
import type { HoldRow } from '../daily/api'

/**
 * Made-up every-day data (B-W2a-64) for the Stock and Movements design cases: the standard HOLD and WRITE_OFF reasons
 * (the words every factory starts from) and quality holds of invented lots and hides. Design-only (fixtures and tests
 * import it); it exports no `designScreen`.
 */

export function pickerOf(list: ReasonList): PickerReason[] {
  return standardReasonsOf(list).map((reason, index) => ({
    id: uid('7474', (list === 'HOLD' ? 100 : 200) + index),
    list,
    code: reason.code,
    labelIt: reason.labelIt,
    labelEn: reason.labelEn,
    labelI18n: {},
    icon: reason.icon,
    colour: reason.colour,
    needsDetail: reason.needsDetail,
    sortOrder: (index + 1) * 10,
  }))
}

export const HOLD_REASONS = pickerOf('HOLD')
export const WRITE_OFF_REASONS = pickerOf('WRITE_OFF')

/** An ACTIVE quality hold of some lots (or hides) at the demo site. */
export function holdOf(n: number, subjectType: 'Lot' | 'Hide', subjects: readonly { id: string; code: string }[], reasonCode = 'QUALITY_CHECK', placedDay = 28): HoldRow {
  return {
    id: uid('7575', n),
    siteId: SITE.id,
    status: 'ACTIVE',
    subjectType,
    subjects: subjects.map((subject) => ({ id: subject.id, label: subject.code, state: subjectType === 'Lot' ? 'RELEASED' : 'FULL' })),
    quantity: null,
    reasonCode,
    reasonNote: null,
    sourceType: null,
    placedAt: at(placedDay, 11, 15),
    overdue: false,
    ageDays: 2,
    ncrId: null,
    releasedAt: null,
    closedAt: null,
    version: 1,
  }
}
