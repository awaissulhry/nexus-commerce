/**
 * What a person reads before an Archive on the ad screens. An archive is Amazon's delete operation and it is final:
 * Amazon cannot switch an archived campaign, ad group, keyword, target or product ad on again, and Undo cannot put it
 * back (apps/api ads-api-client.ts SP_V3_ARCHIVE, rollback.service.ts). Pure.
 */

/** The one sentence every archive confirm says. */
export const ARCHIVE_IS_PERMANENT = 'Archive is permanent at Amazon: it cannot be undone.'

/** The confirm's title, sentence and button, with how many it archives (`noun`: singular, plural). */
export function archiveConfirmWords(count: number, noun: readonly [string, string]): { title: string; sentence: string; confirm: string } {
  const what = `${count} ${count === 1 ? noun[0] : noun[1]}`
  return { title: `Archive ${what}?`, sentence: ARCHIVE_IS_PERMANENT, confirm: `Archive ${what}` }
}
