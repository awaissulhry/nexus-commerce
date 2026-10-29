import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import type { CommandTools } from '../../../core/command'

/**
 * Garment serial numbers (MES-076, Q31 (b)) — ONE seam.
 *
 * A serial is the tenant's SERIAL scannable id (`SN-<tag>-<ref>-<check>`, factory-domain production/serials serialText),
 * unique in the tenant and never reused, also when voided. Its reference must come from a number series, never from
 * "the highest serial + 1" (a floor device sees only its own site's serials). The series is the floor-numbering schema
 * step's: NumberKind GARMENT_SERIAL, ONE tenant-wide series (scan ids are unique per tenant), with per-tablet blocks for
 * offline labels. Until it lands, no serial can be given: `take` refuses in words (409 NO_SERIAL_SERIES) inside the
 * printing command, which rolls back whole, and `missing()` says the same for the label screen. A BATCH style's labels
 * are not affected.
 *
 * When the kind lands, only this file changes: `take` calls the numbering platform's allocation for GARMENT_SERIAL
 * inside the command (its exact call comes with that step) and returns the references in order. Tests swap the seam
 * with `useSerialNumbers`.
 */

export interface SerialNumbers {
  /** Why serials cannot be given now (null: they can). */
  missing(): string | null
  /** The next `count` references for the serials of `recordIds` (in order), inside the printing command. */
  take(tools: CommandTools, input: { readonly companyId: string; readonly siteId: string; readonly recordIds: readonly string[] }): Promise<number[]>
}

export const NO_SERIAL_SERIES =
  'Garment serials cannot be given yet: this factory has no serial number series (it comes with the floor numbering step). Nothing was printed.'

/** The refusal of a serial print without a series: a 409 with `refusal/NO_SERIAL_SERIES`. */
export class NoSerialSeriesError extends ConflictError {
  override name = 'NoSerialSeriesError'
  override readonly issues: readonly Issue[] = [
    { path: 'refusal/NO_SERIAL_SERIES', message: NO_SERIAL_SERIES },
    { path: 'fix', message: 'Tell the office: serial-tracked styles wait for the serial series.' },
  ]
  constructor() {
    super(NO_SERIAL_SERIES)
  }
}

/** Until the GARMENT_SERIAL number kind exists: no serial, in words. */
const withoutSeries: SerialNumbers = {
  missing: () => NO_SERIAL_SERIES,
  async take() {
    throw new NoSerialSeriesError()
  },
}

let current: SerialNumbers = withoutSeries

export function serialNumbers(): SerialNumbers {
  return current
}

/** Tests: a stand-in series (null: back to the real one). */
export function useSerialNumbers(numbers: SerialNumbers | null): void {
  current = numbers ?? withoutSeries
}
