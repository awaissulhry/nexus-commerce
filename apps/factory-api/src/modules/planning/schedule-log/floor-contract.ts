import { z } from 'zod'
import { instant, output } from '@nexus/factory-domain/core/contracts'
import { FLOOR_STATES } from '@nexus/factory-domain/planning/schedule-log/floor-status'

/**
 * A bar's state on the floor (B-W2b-329; PLN-133; design planning.board "progress fill and colours (W2b): not started,
 * running, paused, done"; factory-domain planning/schedule-log/floor-status). Its own file: the board's contract (B-W2a-34's)
 * and this step's both use it, and neither imports the other. Per bar: no person, no money.
 */
export const floorStatusView = output({
  state: z.enum(FLOOR_STATES),
  /** Garments through it, of the work order's (a part: its garments); the progress fill. */
  done: z.number().int(),
  of: z.number().int(),
  pct: z.number().int(),
  /** Bundles being worked there now, and paused there now. */
  runningBundles: z.number().int(),
  pausedBundles: z.number().int(),
  /** RUNNING (a bundle worked now): since when; PAUSED: since the latest pause. */
  since: instant().nullable(),
  /** PAUSED: the latest pause's reason code (the PAUSE reason list's). */
  pauseReasonCode: z.string().nullable(),
  lastScanAt: instant().nullable(),
  words: z.string(),
})
export type FloorStatusView = z.infer<typeof floorStatusView>
