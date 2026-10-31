/**
 * `MarginMeter`'s words (B-W2b-09). English by default; a host passes the words it translates. The percentages come in
 * already written (the meter's `format`, the person's language): "18.2 %".
 */
export interface MarginMeterLabels {
  /** The meter's name when the app gives none. */
  label: string
  /** Under the floor: "18.2 % — under the 20 % floor". */
  underFloor: (value: string, floor: string) => string
  /** At or over the floor, under the target: "24.0 % — under the 30 % target". */
  underTarget: (value: string, target: string) => string
  /** At or over the target: "31.5 % — at or above the 30 % target". */
  onTarget: (value: string, target: string) => string
  /** At or over the floor, no target: "22.0 % — above the 20 % floor". */
  overFloor: (value: string, floor: string) => string
  /** No floor or target to compare with. */
  plain: (value: string) => string
  /** The margin is not known (no price or no cost yet). */
  unknown: string
  /** The floor mark's name: "Floor 20 %". */
  floorMark: (floor: string) => string
  /** The target mark's name: "Target 30 %". */
  targetMark: (target: string) => string
}

export const MARGIN_METER_LABELS: MarginMeterLabels = {
  label: 'Margin',
  underFloor: (value, floor) => `${value} — under the ${floor} floor`,
  underTarget: (value, target) => `${value} — under the ${target} target`,
  onTarget: (value, target) => `${value} — at or above the ${target} target`,
  overFloor: (value, floor) => `${value} — above the ${floor} floor`,
  plain: (value) => value,
  unknown: 'Margin not known',
  floorMark: (floor) => `Floor ${floor}`,
  targetMark: (target) => `Target ${target}`,
}
