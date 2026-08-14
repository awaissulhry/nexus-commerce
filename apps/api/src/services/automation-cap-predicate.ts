/**
 * CAP — the daily-cap counter's exclusion predicate, in ONE place.
 *
 * 🔴 This module exists because a second implementation of a predicate is where drift lives.
 *
 * `automation-rule.service.ts` counts today's executions to enforce `maxExecutionsPerDay`, and it
 * must exclude cap refusals — including the ~693k pre-ADX.1 rows still on prod — without excluding
 * the real work, which carries a NULL `errorMessage`. Prisma's `NOT: { errorMessage: 'X' }` compiles
 * to `NOT (errorMessage = 'X')`, and in SQL's three-valued logic that is **NULL, not TRUE**, when the
 * column is null. So the bare form matched **0 of 956,629** rows in 60 days and no cap bound anything
 * between 2026-08-04 and 2026-08-14.
 *
 * The Negative Targeting page reported on that defect by hard-coding its own copy of the bare clause
 * and measuring it — which meant the panel was measuring **SQL**, not the engine, and could never
 * report the fix. When the engine was repaired on 2026-08-14 the page went on saying "the daily-cap
 * counter is broken" about a counter that was, at that moment, holding on production.
 *
 * So: the engine and every surface that reports on the engine import this. A surface that wants to
 * show the blind spot compares `notCapRefusal()` against `BARE_NOT_FORM_DO_NOT_USE` — which is kept
 * here, named to be unusable by accident, precisely so nobody writes a fresh copy of it.
 */

export const CAP_REFUSAL_MESSAGE = 'DAILY_CAP_EXCEEDED'

/**
 * "errorMessage is not the cap refusal, INCLUDING when it is null."
 * The null branch is not optional: without it this matches nothing at all.
 */
export function notCapRefusal(): {
  OR: [{ errorMessage: null }, { errorMessage: { not: string } }]
} {
  return { OR: [{ errorMessage: null }, { errorMessage: { not: CAP_REFUSAL_MESSAGE } }] }
}

/**
 * The broken form, retained ONLY so a surface can measure the blind spot it opens rather than
 * assert it. Never use this to filter real work — it drops every null-error row.
 */
export function bareNotFormDoNotUse(): { NOT: { errorMessage: string } } {
  return { NOT: { errorMessage: CAP_REFUSAL_MESSAGE } }
}
