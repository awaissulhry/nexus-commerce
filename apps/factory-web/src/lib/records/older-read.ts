/**
 * fx-10 / fx-11 (end check): true when `next` is the record the page holds at an OLDER version — a read that left before a
 * write and answered after it. A record page never goes back to it: the next write would send that older version and be
 * refused as changed (409), though nobody else changed anything. Another record, or no record held yet, is never older.
 *
 * Every record page whose live re-read answers the record with its version applies it where that read lands
 * (`lib/records/older-read.vitest.test.ts` lists them): the write's own answer is newer, and its event reads the record again.
 */
export function olderRead(held: { id: string; version: number } | null | undefined, next: { id: string; version: number }): boolean {
  return held != null && held.id === next.id && next.version < held.version
}
