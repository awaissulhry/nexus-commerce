/**
 * The refusals of the requests and jobs in depth (B-W2b-96; QHS-179, QHS-180, QHS-181, QHS-183, QHS-189, QHS-190), beside
 * W2a's PLANT_REFUSALS (plant/rules.ts, whose list the Office screens mirror word for word): the API answers each as a 409
 * with the issues `refusal/<CODE>` (the words) and `fix` (the one thing to do), as every plant refusal. The screens of
 * B-W2b-102 and B-W2b-140 add their words for these codes (`refusal.<CODE>`).
 */

export const DEPTH_REFUSALS = [
  // progress (QHS-180)
  'ALREADY_ACKNOWLEDGED',
  'ON_THE_WAY_ALREADY',
  'NOT_ON_THE_WAY_NOW',
  'NOT_FIXED_YET',
  'WORKS_CONFIRMED',
  'CLOSED_WITHOUT_JOB',
  // the lock (QHS-183)
  'H1_HELD',
  'LOCK_NOT_ALLOWED',
  'LOCKED_ALREADY',
  // merge (QHS-181)
  'MERGE_NOTHING',
  // the one-screen close (QHS-190)
  'NOT_HANDED_BACK',
  'LEAD_CONFIRMED',
  // files (QHS-189)
  'FILES_CLOSED',
  // routing (QHS-179)
  'ORDER_INCOMPLETE',
] as const
export type DepthRefusalCode = (typeof DEPTH_REFUSALS)[number]

export interface DepthRefusal {
  readonly code: DepthRefusalCode
  /** What happened and why, in words (never a worker's name). */
  readonly message: string
  /** The one thing to do about it. */
  readonly fix: string
}

export const depthRefusal = (code: DepthRefusalCode, message: string, fix: string): DepthRefusal => ({ code, message, fix })
