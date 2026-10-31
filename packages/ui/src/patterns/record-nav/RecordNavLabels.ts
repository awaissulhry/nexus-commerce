import { DETAIL_MODAL_LABELS, type DetailModalLabels } from '../DetailModalLabels'

/**
 * `RecordNav`'s words (B-W2b-09, D13): the same words as `DetailModal`'s Prev / Next — one rule, one set of words — so
 * a host passes the same translations to both (`labels={ds.detail}` fits). English by default.
 */
export type RecordNavLabels = Pick<DetailModalLabels, 'noun' | 'previous' | 'next' | 'moveBetween' | 'position' | 'notInTable' | 'first' | 'last'>

export const RECORD_NAV_LABELS: RecordNavLabels = {
  noun: DETAIL_MODAL_LABELS.noun,
  previous: DETAIL_MODAL_LABELS.previous,
  next: DETAIL_MODAL_LABELS.next,
  moveBetween: DETAIL_MODAL_LABELS.moveBetween,
  position: DETAIL_MODAL_LABELS.position,
  notInTable: DETAIL_MODAL_LABELS.notInTable,
  first: DETAIL_MODAL_LABELS.first,
  last: DETAIL_MODAL_LABELS.last,
}
