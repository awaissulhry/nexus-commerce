/**
 * AI-3.1 — outbound prompt sanitizer.
 *
 * Every prompt the API ships to a vendor LLM passes through this
 * function. Patterns that look like fiscal / personal data get
 * replaced with a typed placeholder so the operator sees that
 * something was redacted (vs the data silently disappearing into
 * the vendor's training pipeline).
 *
 * Scoped specifically to the data shapes we plausibly see leak in
 * from product master fields:
 *
 *   - Italian codice fiscale  — natural-person tax ID, 16 alnum
 *   - Italian partita IVA     — 11-digit business VAT number
 *   - IBAN                    — bank acct, varies by country (15-34
 *                                chars, country letters then digits)
 *   - email
 *   - phone (E.164-ish)
 *   - long digit strings (≥10 contiguous) — card-like
 *
 * Why redact instead of refuse:
 *   - operators sometimes paste a raw description that incidentally
 *     mentions a customer email; refusing the entire generate would
 *     be more disruptive than dropping the email
 *   - AiUsageLog.metadata.redactions captures what got hit so audits
 *     can flag operators / surfaces leaking sensitive data
 *
 * Shape: { sanitized, redactions: { kind, count }[] }. Sanitised text
 * is what gets sent to the vendor; redactions[] gets logged.
 *
 * Failure mode: if a regex misfires (e.g. matches a legitimate brand
 * SKU like "AIRMESH2024XL"), the sanitiser drops the SKU. The output
 * is still grammatically usable for content generation; the operator
 * can tweak a missed match by editing the master product. Better a
 * slightly degraded prompt than a silent fiscal data leak.
 */

export type RedactionKind =
  | 'codice_fiscale'
  | 'partita_iva'
  | 'iban'
  | 'email'
  | 'phone'
  | 'long_digits'

export interface RedactionCount {
  kind: RedactionKind
  count: number
}

export interface SanitizeResult {
  sanitized: string
  redactions: RedactionCount[]
}

// Italian codice fiscale: 6 letters + 2 digits + 1 letter + 2 digits +
// 1 letter + 3 alnum + 1 letter. Matches as a word boundary on both
// sides so it doesn't gobble subsequences inside SKUs.
//
// Reality check: real-world CF strings can also include 'O' for
// digits per the legacy substitution table; allowing letters in the
// digit positions would over-match (e.g. ROADMAPS1A01H501Z would hit).
// Sticking to the strict shape — false negatives are acceptable, false
// positives that nuke product titles aren't.
const CF_RE = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi

// Italian partita IVA: 11 contiguous digits. Anchored on word
// boundaries so we don't hit the middle of an EAN-13.
//
// Caveat: an EAN-13 also lives as 13 contiguous digits, so we
// require EXACTLY 11 with non-digit boundaries on each side. Phone
// numbers can also be 11 digits (mobile + country); the order
// matters — phone redaction runs first, leaving partita IVA to
// catch the residue.
const PIVA_RE = /(?<![\d])\d{11}(?![\d])/g

// IBAN: country code (2 letters) + 2 check digits + 11-30 alnum.
// Total length 15-34 between word boundaries.
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g

// Email: liberal — anything resembling local@domain.tld.
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g

// Phone: + then 6-15 digits, OR 10-15 contiguous digits. We catch
// both formal E.164 and the loose 10-digit local format.
const PHONE_RE = /\+\d{6,15}|\b\d{10,15}\b/g

// Long digit run — final catch-all for cards / order numbers /
// account numbers we didn't classify above. Must be ≥13 to avoid
// capturing legitimate 10-12 digit codes; cards are 13-19 digits.
const LONG_DIGITS_RE = /\b\d{13,}\b/g

interface RuleDef {
  kind: RedactionKind
  re: RegExp
  /** Token used in the placeholder. */
  label: string
}

// Order matters: more specific patterns run first so the catch-all
// LONG_DIGITS_RE only fires on residue. Phone runs before PIVA so an
// 11-digit phone gets tagged 'phone' rather than 'partita_iva'.
//
// CF runs before EMAIL — both are case-insensitive enough that the
// order doesn't really matter, but documenting intent for future
// edits.
const RULES: RuleDef[] = [
  { kind: 'codice_fiscale', re: CF_RE, label: 'CF' },
  { kind: 'iban', re: IBAN_RE, label: 'IBAN' },
  { kind: 'email', re: EMAIL_RE, label: 'EMAIL' },
  { kind: 'phone', re: PHONE_RE, label: 'PHONE' },
  { kind: 'partita_iva', re: PIVA_RE, label: 'PIVA' },
  { kind: 'long_digits', re: LONG_DIGITS_RE, label: 'NUM' },
]

/**
 * Sanitize a single prompt string. Returns the redacted text + a
 * tally per redaction kind. Empty redactions[] when the prompt is
 * clean.
 *
 * The placeholder shape is `[REDACTED:KIND]` — visible enough that
 * the LLM treats it as "this slot exists but the value is hidden"
 * rather than ignoring it. Empirically Gemini and Claude both leave
 * the placeholder intact in their outputs and route around it
 * (e.g. "the product is available from [REDACTED:EMAIL]" → "the
 * product is available from our authorised retailer").
 */
export function sanitizeOutboundPrompt(prompt: string): SanitizeResult {
  if (!prompt) return { sanitized: prompt, redactions: [] }
  let out = prompt
  const counts = new Map<RedactionKind, number>()
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    const placeholder = `[REDACTED:${rule.label}]`
    let matchCount = 0
    out = out.replace(re, () => {
      matchCount += 1
      return placeholder
    })
    if (matchCount > 0) counts.set(rule.kind, matchCount)
  }
  const redactions: RedactionCount[] = Array.from(counts.entries()).map(
    ([kind, count]) => ({ kind, count }),
  )
  return { sanitized: out, redactions }
}

/**
 * Convenience: total redaction count across all kinds. Used by
 * AiUsageLog metadata for "how many things did we redact?" rollups
 * without forcing readers to sum the array client-side.
 */
export function totalRedactions(redactions: RedactionCount[]): number {
  return redactions.reduce((sum, r) => sum + r.count, 0)
}
