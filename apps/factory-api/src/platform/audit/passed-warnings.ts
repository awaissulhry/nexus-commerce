import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { ORDER_WARNING_KINDS, ORDER_WARNING_WORDS, type OrderWarningKind } from '@nexus/factory-domain/sales/warnings/kinds'

/**
 * Warn, don't stop — the audit helper (owb- order workflow, base settle 11; S2 ask 22:27). A command finds its warnings (pure,
 * in its own module), then:
 *
 *   const passed = checkWarnings(found, body.overrides)           // 409 in words with the list, until every one is passed on
 *   … the work …
 *   tools.audit({ action, recordType, recordId, after: { …, ...passedWarningsAfter(passed, body.reason) } })
 *
 * The warnings a person went on with are kept on the command's OWN audit row (`after.passedWarnings`, + `after.reason` when
 * one was given) — never a row of their own (pattern: modules/production/cutting contract.ts `overrides`, cut.ts). No caller
 * in the base: S3 (ss1, ship with payment due) and S2 (of2) call it. S2 owns this file after the base.
 */

/** The issue path of a warning in the 409 (the web finds its words by the kind). */
export const warningIssuePath = (kind: OrderWarningKind): string => `warning/${kind}`

/**
 * The warnings found, passed on or refused: every found warning must be in `overrides`, else a 409 (code `conflict`) whose
 * issues list each one not passed on (path `warning/<KIND>`, its words). Returns the warnings passed on (in the kinds' order),
 * for `passedWarningsAfter`.
 */
export function checkWarnings(found: readonly OrderWarningKind[], overrides: readonly OrderWarningKind[] | null | undefined): OrderWarningKind[] {
  const seen = ORDER_WARNING_KINDS.filter((kind) => found.includes(kind))
  const open = seen.filter((kind) => !(overrides ?? []).includes(kind))
  if (open.length > 0) {
    const issues: Issue[] = open.map((kind) => ({ path: warningIssuePath(kind), message: ORDER_WARNING_WORDS[kind].en }))
    const list = open.map((kind) => ORDER_WARNING_WORDS[kind].en).join(' ')
    throw new DomainError('conflict', `Check before you go on: ${list} Go on only if you mean it.`, issues)
  }
  return seen
}

/** What the command adds to its own audit row's `after`: the warnings passed on and the reason; nothing when none was passed. */
export function passedWarningsAfter(passed: readonly OrderWarningKind[], reason?: string | null): { passedWarnings?: OrderWarningKind[]; reason?: string | null } {
  if (passed.length === 0) return {}
  const words = reason?.trim() ? reason.trim() : null
  return { passedWarnings: [...passed], reason: words }
}
