import type { FloorRulesStatus } from '../production/settings/monitoring'

/**
 * The privacy gate of the floor (B-W1-36; PLAN §2.8; design admin.privacy "Floor badge scans stay off until the DPIA is
 * stored and the worker notice is acknowledged"; GDPR arts. 13 and 35; Statuto dei Lavoratori art. 4 c.3; GAP-004,
 * PLT-208): pure. Real floor work (badge sign-ins and scans that record people) waits, per company, for
 *   - a stored, signed DPIA (art. 35: before the processing starts), and
 *   - a published worker notice (art. 13; art. 4 c.3: before anything is recorded);
 * and, per worker, for that worker's acknowledgement of the version in force (the scan gate and the database's rule).
 * `floorReadiness` joins this with the site's floor rules (B-W1-37's floorRulesStatus: a site that names workers needs
 * its legal basis on record) into one answer in plain words.
 */

export interface FloorPrivacyFacts {
  /** The company's stored DPIA, or null. */
  readonly dpia: { readonly versionNo: number; readonly reviewDueOn: string | null } | null
  /** The company's worker notice in force, or null. */
  readonly workerNotice: { readonly label: string } | null
  /** Today in the company's time zone (YYYY-MM-DD), for the DPIA's review day. */
  readonly today: string
}

export interface FloorPrivacyStatus {
  readonly ready: boolean
  readonly dpiaStored: boolean
  readonly workerNoticePublished: boolean
  readonly notes: string[]
}

export const NO_DPIA_NOTE =
  'No signed DPIA is stored for this company (GDPR art. 35): badge sign-ins and scans that record workers stay off until it is (Admin › Privacy & notices).'
export const NO_WORKER_NOTICE_NOTE =
  'No worker notice is published for this company (L. 300/1970 art. 4 c.3; GDPR art. 13): floor work that records workers stays off until one is, and each worker acknowledges it before their first scan.'

export function floorPrivacyStatus(facts: FloorPrivacyFacts): FloorPrivacyStatus {
  const notes: string[] = []
  if (!facts.dpia) notes.push(NO_DPIA_NOTE)
  else if (facts.dpia.reviewDueOn !== null && facts.dpia.reviewDueOn <= facts.today) {
    notes.push(`The DPIA's review was due on ${facts.dpia.reviewDueOn}: review it and store the new version (GDPR art. 35(11)). The floor stays open meanwhile.`)
  }
  if (!facts.workerNotice) notes.push(NO_WORKER_NOTICE_NOTE)
  else notes.push(`Worker notice ${facts.workerNotice.label} is in force: each worker acknowledges it on the tablet before their first scan.`)
  const ready = facts.dpia !== null && facts.workerNotice !== null
  return { ready, dpiaStored: facts.dpia !== null, workerNoticePublished: facts.workerNotice !== null, notes }
}

/** The floor of one site may start real work: its privacy gate (the company's) and its floor rules, in one answer. */
export interface FloorReadiness {
  readonly readyForFloor: boolean
  /** The privacy gate's notes first, then the floor rules'. */
  readonly notes: string[]
  readonly privacy: FloorPrivacyStatus
  readonly rules: FloorRulesStatus
}

export function floorReadiness(privacy: FloorPrivacyStatus, rules: FloorRulesStatus): FloorReadiness {
  return { readyForFloor: privacy.ready && rules.readyForFloor, notes: [...privacy.notes, ...rules.notes], privacy, rules }
}
