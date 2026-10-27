/**
 * Reviews N3 (2026-10-27) — a review-request rule's own e-mail text, on the way into the database: what a save, an
 * import or a copy writes to `ReviewRule.emailText`. The words are checked by the ONE check the rule editor runs while
 * a person types (@nexus/shared/review-request-text): a text that offers something for a review, asks only happy
 * buyers, asks for 5 stars, or lost the review button or the unsubscribe link is refused with the reason in words,
 * and nothing is saved. A language equal to the standard text is not stored (it IS the standard text).
 */
import { Prisma } from '@prisma/client'
import { REQUEST_TEXT_LANGUAGES, readRuleEmailText, ruleEmailTextRefusal, type RuleEmailText } from '@nexus/shared/review-request-text'

/** A refused text, in words (the routes answer 400). */
export class RuleTextError extends Error {
  readonly statusCode = 400
}

/**
 * The value a save writes for `emailText`: undefined when the body does not send it (left as it is), the database's
 * NULL for "standard text in every language", else the rule's own texts. Throws RuleTextError with the reason.
 */
export function emailTextForSave(raw: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return Prisma.DbNull
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RuleTextError('The e-mail text must be a subject and a text per language (it, en).')
  for (const [lang, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(REQUEST_TEXT_LANGUAGES as readonly string[]).includes(lang)) {
      throw new RuleTextError(`A rule has its own text only in Italian (it) and English (en) — the languages of the review e-mail, not “${lang}”.`)
    }
    if (value == null) continue
    const v = value as { subject?: unknown; body?: unknown }
    if (typeof value !== 'object' || typeof v.subject !== 'string' || typeof v.body !== 'string') {
      throw new RuleTextError('Each language needs a subject and a text.')
    }
  }
  const text = readRuleEmailText(raw)
  const refusal = ruleEmailTextRefusal(text)
  if (refusal) throw new RuleTextError(refusal)
  return text ? (text as Prisma.InputJsonValue) : Prisma.DbNull
}

/** The rule's own texts as stored (null = standard in every language), for answers, copies and exports. */
export function storedEmailText(raw: unknown): RuleEmailText | null {
  return readRuleEmailText(raw)
}
