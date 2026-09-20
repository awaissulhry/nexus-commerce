/**
 * P3.2 (docs/channel-connections/FINAL-PLAN.md section 6, row P3.2) — WHICH attribute a
 * channel is complaining about, read from the channel's own words when the channel does
 * not name one in a field of its own.
 *
 * ONE accessor, deliberately. P3.1 added `attribute` to the gateway vocabulary by reading
 * Amazon's `issue.attributeNames[0]`; the flat-file feed parser had its own private
 * `extractFields`. Two names for one fact is the shape of every drift defect in this
 * programme, so both now call in here.
 *
 * ## What was measured (2026-09-20)
 *
 * The 25 stored `AmazonFlatFileFeedJob` rows hold **140 real rejections on 48 real SKUs**.
 * On every one of them `attributeNames` is `[]` and the derived `fields` is empty — 140
 * of 140 — for two independent reasons:
 *
 *  1. the parser guarded the fallback with `Array.isArray(attributeNames)`, which is TRUE
 *     for the `[]` Amazon actually sends, so the fallback never ran; and
 *  2. the old `extractFields` matched only English phrasings ("attribute - x",
 *     "attribute 'x'") with straight quotes. Every stored rejection is **Italian** and
 *     uses typographic quotes: `“outer” è obbligatorio ma mancante.`
 *
 * That mattered more than a missing label. `ListingIssue`'s identity is
 * `code + sorted attributeNames`, so with no attribute all five "X is required but
 * missing" issues on one SKU share one fingerprint: mirroring the real population would
 * have collapsed **140 issues into 60 rows and silently dropped 80**, and shown the
 * operator "closure is missing" on a listing that is in fact missing five attributes.
 *
 * ## The rule
 *
 * Do not parse the sentence — the sentence is in the seller's language and Amazon
 * localises it. Parse the *names*. Amazon attribute names are lower-snake ASCII
 * identifiers, and they survive translation verbatim, so tokenising the message and
 * keeping the snake_case tokens is both locale-proof and quote-style-proof.
 *
 * The fallback for single-word attributes (`outer`, `inner`, `rise`, `closure` — real,
 * and all of them 90220) needs a quote to be safe: an unquoted bare lowercase word is
 * just a word. It runs only when no snake_case token was found, so a quoted *value*
 * sitting beside a real attribute can never displace it.
 */

/** Amazon attribute names are lower-snake ASCII: `item_name`, `bottoms_size`, `rise`. */
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

/** A single lowercase word, the shape of `outer` / `inner` / `rise` / `closure`. */
const BARE_WORD = /^[a-z][a-z0-9]*$/

/**
 * Only the unambiguous paired quotes. `'` and `’` are excluded on purpose: Italian
 * writes `l'attributo` and `l’attributo`, and treating an apostrophe as an opening
 * quote pairs it with the next one and swallows half the sentence.
 */
const QUOTED = /[“"„«]([^“”"„«»]{1,64})[”"»]/g

/** Anything that is not part of an identifier ends a token. */
const TOKEN_SPLIT = /[^A-Za-z0-9_]+/

/** More than this on one issue is a runaway match, not a list of attributes. */
const MAX_ATTRIBUTES = 12

/** Longer than this is a sentence, not an attribute name. */
const MAX_LENGTH = 64

/**
 * The attribute names named inside a channel's own message, in the order first seen.
 *
 * Locale-independent by construction: it reads identifiers, never words. Returns `[]`
 * when the message names none — which is a real answer, not a failure.
 */
export function attributeNamesFromMessage(message: string | null | undefined): string[] {
  const text = String(message ?? '')
  if (!text) return []

  const found: string[] = []
  const seen = new Set<string>()
  const add = (raw: string): void => {
    const name = raw.trim()
    if (!name || name.length > MAX_LENGTH || seen.has(name)) return
    seen.add(name)
    found.push(name)
  }

  // Pass 1 — every snake_case identifier anywhere in the message. Splitting on `.`,
  // `#` and `[` too means a path like `bottoms_size#?.size_system` yields BOTH the
  // container and the field, which is what the operator has to fill in.
  for (const token of text.split(TOKEN_SPLIT)) {
    if (SNAKE_CASE.test(token)) add(token)
    if (found.length >= MAX_ATTRIBUTES) return found
  }
  if (found.length > 0) return found

  // Pass 2 — nothing snake_case, so fall back to QUOTED single words. Amazon's 90220
  // ("X is required but missing") names a one-word attribute and quotes it every time.
  for (const match of text.matchAll(QUOTED)) {
    // Amazon sometimes double-quotes inside its own quotes: `“"size"”`.
    const inner = match[1].replace(/^["'“”]+|["'“”]+$/g, '')
    if (BARE_WORD.test(inner)) add(inner)
    if (found.length >= MAX_ATTRIBUTES) break
  }
  return found
}

/**
 * The attribute names for one channel issue: what the channel named itself, and only
 * when it named nothing, what its message says.
 *
 * `Array.isArray` is NOT the test — Amazon sends `attributeNames: []` on every real
 * rejection we hold, and an `isArray` guard reads that as "the channel told us" and
 * suppresses the fallback. The test is whether there is a name in there.
 */
export function resolveIssueAttributes(
  attributeNames: unknown,
  message: string | null | undefined,
): string[] {
  const named = Array.isArray(attributeNames)
    ? attributeNames.map((a) => String(a ?? '').trim()).filter(Boolean)
    : []
  if (named.length > 0) return named.slice(0, MAX_ATTRIBUTES)
  return attributeNamesFromMessage(message)
}
