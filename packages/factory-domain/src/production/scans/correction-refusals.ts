/**
 * Why a team leader refuses a correction on the tablet (B-W2b-83; design floor.supervisor "Waiting for you": Reject needs a
 * reason tile; MES-096). The office keeps its free words (`POST /production/scans/corrections/:id/refuse`). The tile goes into
 * ScanCorrectionRequest.decisionNote as words, in English like every note the API writes (no column keeps a reason code);
 * OTHER asks for the lead's own words. No person, no figure.
 */

export const CORRECTION_REFUSAL_REASONS = ['RECORDED_RIGHT', 'COUNTS_WRONG', 'WRONG_REPORT', 'OTHER'] as const
export type CorrectionRefusalReason = (typeof CORRECTION_REFUSAL_REASONS)[number]

export interface CorrectionRefusalTile {
  readonly code: CorrectionRefusalReason
  readonly labelIt: string
  readonly labelEn: string
  readonly needsDetail: boolean
}

export const CORRECTION_REFUSAL_TILES: readonly CorrectionRefusalTile[] = Object.freeze([
  Object.freeze({ code: 'RECORDED_RIGHT', labelIt: 'Il conteggio registrato è giusto', labelEn: 'The recorded count is right', needsDetail: false }),
  Object.freeze({ code: 'COUNTS_WRONG', labelIt: 'I nuovi conteggi sono sbagliati', labelEn: 'The new counts are wrong', needsDetail: false }),
  Object.freeze({ code: 'WRONG_REPORT', labelIt: 'Non è la segnalazione da correggere', labelEn: 'This is not the report to correct', needsDetail: false }),
  Object.freeze({ code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', needsDetail: true }),
] as const satisfies readonly CorrectionRefusalTile[])

/** The tile asks for words and has none. */
export function correctionRefusalNeedsWords(reason: CorrectionRefusalReason, note: string | null): boolean {
  return CORRECTION_REFUSAL_TILES.find((tile) => tile.code === reason)!.needsDetail && !note?.trim()
}

/** What the request keeps as its decision note: the tile in words, then the lead's own. */
export function correctionRefusalNote(reason: CorrectionRefusalReason, note: string | null): string {
  const tile = CORRECTION_REFUSAL_TILES.find((entry) => entry.code === reason)!
  const words = note?.trim()
  return words ? `${tile.labelEn}: ${words}` : tile.labelEn
}
