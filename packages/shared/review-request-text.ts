/**
 * Reviews — a review-request rule's own e-mail text: a subject and a text per language for OUR review e-mail. ONE
 * source for the API (a save, a preview or a test with words the check refuses is refused in these words; the sender
 * renders the text with these parts) and the web (the rule editor checks the words as they are typed). Pure: no I/O.
 *
 * Who gets which e-mail (channel facts, Owner 2026-10-27):
 * - Shopify buyers (and any other own-shop buyer Nexus e-mails) get OUR review e-mail. A rule may give it its own subject
 *   and text per language; a language without its own text gets the standard text, exactly as before.
 * - Amazon buyers get Amazon's own standard e-mail (Solicitations API): Nexus cannot change its words.
 * - eBay buyers get no e-mail from Nexus: eBay asks them for feedback itself.
 *
 * The languages are the two the review e-mail has: Italian for buyers in Italy, English for every other market
 * (`requestTextLanguageFor`, the sender's own choice).
 *
 * The check (`checkRequestText`) refuses, with the reason in words:
 * - anything offered or promised for a review (a discount, a gift, a refund, a free product…);
 * - asking only happy buyers, or sending unhappy ones somewhere else first;
 * - asking for 5 stars or a positive review (an honest review only);
 * - a text without the review button `{review_button}` or the unsubscribe link `{unsubscribe_link}`;
 * - a part Nexus does not fill in, a part that belongs in the text put in the subject, an empty or too long text.
 * The standard texts pass it (review-request-text.vitest.test.ts).
 */

export const REQUEST_TEXT_LANGUAGES = ['it', 'en'] as const
export type RequestTextLanguage = (typeof REQUEST_TEXT_LANGUAGES)[number]

export const REQUEST_TEXT_LANGUAGE_NAMES: Record<RequestTextLanguage, string> = { it: 'Italian', en: 'English' }
/** Who reads each language (the sender's choice by market). */
export const REQUEST_TEXT_LANGUAGE_WHO: Record<RequestTextLanguage, string> = { it: 'buyers in Italy', en: 'buyers in every other market' }

/** The language of the review e-mail for an order's market: Italian for Italy, English for every other market. */
export function requestTextLanguageFor(market: string | null | undefined): RequestTextLanguage {
  return (market ?? 'IT').trim().toUpperCase() === 'IT' ? 'it' : 'en'
}

export interface RequestText {
  subject: string
  body: string
}

/** A rule's own texts, by language; a missing language uses the standard text. */
export type RuleEmailText = Partial<Record<RequestTextLanguage, RequestText>>

export const SUBJECT_MAX = 150
export const BODY_MAX = 3000

export type RequestTextPartKey = 'first_name' | 'product' | 'aspects' | 'review_button' | 'unsubscribe_link'

export interface RequestTextPart {
  key: RequestTextPartKey
  token: string
  words: string
  /** Must be in the text (never removed). */
  required: boolean
  /** Only in the text, never in the subject. */
  textOnly: boolean
}

/** The parts Nexus fills in for each buyer. */
export const REQUEST_TEXT_PARTS: readonly RequestTextPart[] = [
  { key: 'first_name', token: '{first_name}', words: 'the buyer’s first name', required: false, textOnly: false },
  { key: 'product', token: '{product}', words: 'the product bought', required: false, textOnly: false },
  { key: 'aspects', token: '{aspects}', words: 'what a buyer can judge for that product, like “the fit and protection of the jacket”', required: false, textOnly: false },
  { key: 'review_button', token: '{review_button}', words: 'the button to the review page', required: true, textOnly: true },
  { key: 'unsubscribe_link', token: '{unsubscribe_link}', words: 'the link to stop these e-mails', required: true, textOnly: true },
]

const PART_BY_TOKEN = new Map(REQUEST_TEXT_PARTS.map((p) => [p.token, p]))

/**
 * Today's standard e-mail in the parts' words — what the editor shows and starts a rule's own text from. A language
 * without its own text is still sent by the standard renderer, unchanged (review-request-email.service.ts).
 */
export const STANDARD_REQUEST_TEXT: Record<RequestTextLanguage, RequestText> = {
  it: {
    subject: 'Come ti trovi con {product}? Lascia una recensione sincera',
    body: [
      'Ciao {first_name},',
      'Grazie per il tuo acquisto! Speriamo tu abbia avuto il tempo di provare {product}.',
      'Se ti va, condividi la tua opinione sincera lasciando una recensione (per esempio su questi aspetti: {aspects}). La tua esperienza aiuta altri motociclisti a scegliere.',
      '{review_button}',
      'Non vuoi più ricevere queste email? {unsubscribe_link}',
    ].join('\n\n'),
  },
  en: {
    subject: 'How is your {product}? Share your honest review',
    body: [
      'Hi {first_name},',
      "Thank you for your purchase! We hope you've had the chance to try your {product}.",
      'Feel free to share your honest feedback by leaving a review (for example about {aspects}). Your experience helps other riders choose.',
      '{review_button}',
      'Don’t want these e-mails? {unsubscribe_link}',
    ].join('\n\n'),
  },
}

// ── The check ────────────────────────────────────────────────────────────────────────────────────────────────────

export type RequestTextIssueCode =
  | 'empty_subject'
  | 'empty_body'
  | 'subject_too_long'
  | 'body_too_long'
  | 'unknown_part'
  | 'part_in_subject'
  | 'missing_review_button'
  | 'missing_unsubscribe_link'
  | 'incentive'
  | 'happy_only'
  | 'five_stars'

export interface RequestTextIssue {
  code: RequestTextIssueCode
  /** Where it is: the subject or the text. */
  where: 'subject' | 'body'
  /** Why it is refused, in words a person reads. */
  words: string
  /** The words that matched, when there are any. */
  match?: string
}

// Letters on both sides, so "regalo" is caught but "regalone" too, and accented letters count (Italian).
const W = (core: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${core})(?![\\p{L}\\p{N}])`, 'iu')

const INCENTIVE = W([
  'discounts?', 'discounted', 'coupons?', 'vouchers?', 'promo(?:tion(?:al)?)? codes?', 'gift(?:s| cards?)?', 'rewards?', 'rewarded',
  'incentives?', 'cash ?back', 'rebates?', 'refunds?', 'prizes?', 'giveaways?', 'free(?! to)', '\\d+ ?% off', 'in (?:exchange|return) for',
  'sconti', 'sconto', 'scontat[oaie]', 'codice (?:sconto|promozionale)', 'buon[oi] (?:sconto|regalo|acquisto)', 'omaggi(?:o)?', 'regal[oi]',
  'gratis', 'gratuit[oaie]', 'rimbors[oi]', 'premio', 'in cambio',
].join('|'))
/** "Feel free to share…" is no offer: the word "free" only counts outside that phrase. */
const FEEL_FREE = /feel\s+free/giu

const HAPPY_ONLY = W([
  'if (?:you are|you\'re|you’re|you were) (?:happy|satisfied|pleased|delighted|not happy|not satisfied|unhappy|dissatisfied)',
  'if you (?:liked|loved|enjoyed|like|love|enjoy) (?:it|them|your|the)', 'happy customers', 'satisfied customers',
  'before (?:leaving|you leave|writing|you write) (?:a|your) review', 'contact us (?:first|before)',
  'se (?:sei|sei stat[oa]|non sei) (?:soddisfatt[oa]|content[oa]|felice)', 'se ti (?:è|e\'|sono) piaciut[oaie]', 'se ti piace',
  'clienti soddisfatti', 'prima di (?:lasciare|scrivere) (?:una|la) recensione', 'contattaci prima',
].join('|'))

const FIVE_STARS = W([
  '5[ -]?stars?', 'five[ -]?stars?', '5 ?/ ?5', 'full marks', '(?:top|highest|maximum|best) rating', '(?:positive|good|great|glowing|nice) review',
  '5 stelle', 'cinque stelle', 'recensione (?:positiva|a 5 stelle|a cinque stelle)', '(?:buona|bella|ottima) recensione', 'valutazione massima', 'massimo dei voti',
].join('|')) // plus the stars themselves, below
const STAR_SIGNS = /★{4,}|⭐{4,}/u

const PART_TOKEN = /\{[^{}\n]{0,40}\}/g

function firstMatch(re: RegExp, text: string): string | null {
  const m = re.exec(text)
  return m ? m[0] : null
}

function wordIssues(text: string, where: 'subject' | 'body'): RequestTextIssue[] {
  const issues: RequestTextIssue[] = []
  const incentive = firstMatch(INCENTIVE, text.replace(FEEL_FREE, 'feel _'))
  if (incentive) {
    issues.push({
      code: 'incentive', where, match: incentive,
      words: 'It offers something for a review. Nothing may be given or promised for a review — no discount, gift, refund or free product.',
    })
  }
  const happy = firstMatch(HAPPY_ONLY, text)
  if (happy) {
    issues.push({
      code: 'happy_only', where, match: happy,
      words: 'It asks only happy buyers, or sends unhappy ones elsewhere first. Ask every buyer the same way, whether they liked it or not.',
    })
  }
  const stars = firstMatch(FIVE_STARS, text) ?? firstMatch(STAR_SIGNS, text)
  if (stars) {
    issues.push({ code: 'five_stars', where, match: stars, words: 'It asks for 5 stars or a positive review. Ask for an honest review only.' })
  }
  return issues
}

const KNOWN_TOKENS = REQUEST_TEXT_PARTS.map((p) => p.token).join(', ')

/** Every reason one language's text is refused (none = it may be saved and sent). */
export function checkRequestText(text: RequestText): RequestTextIssue[] {
  const subject = text.subject ?? ''
  const body = text.body ?? ''
  const issues: RequestTextIssue[] = []
  if (!subject.trim()) issues.push({ code: 'empty_subject', where: 'subject', words: 'The subject is empty.' })
  if (!body.trim()) issues.push({ code: 'empty_body', where: 'body', words: 'The text is empty.' })
  if (subject.length > SUBJECT_MAX) issues.push({ code: 'subject_too_long', where: 'subject', words: `The subject is ${subject.length} characters; it can be ${SUBJECT_MAX} at most.` })
  if (body.length > BODY_MAX) issues.push({ code: 'body_too_long', where: 'body', words: `The text is ${body.length} characters; it can be ${BODY_MAX.toLocaleString('en-IE')} at most.` })
  for (const [where, value] of [['subject', subject], ['body', body]] as const) {
    for (const token of new Set(value.match(PART_TOKEN) ?? [])) {
      const part = PART_BY_TOKEN.get(token)
      if (!part) {
        issues.push({ code: 'unknown_part', where, match: token, words: `“${token}” is not a part Nexus fills in. Use ${KNOWN_TOKENS}.` })
      } else if (where === 'subject' && part.textOnly) {
        issues.push({ code: 'part_in_subject', where, match: token, words: `${part.token} (${part.words}) belongs in the text, not in the subject.` })
      }
    }
  }
  if (body.trim() && !body.includes('{review_button}')) {
    issues.push({ code: 'missing_review_button', where: 'body', words: 'The review button is missing: put {review_button} back. Without it the buyer has nowhere to leave the review.' })
  }
  if (body.trim() && !body.includes('{unsubscribe_link}')) {
    issues.push({ code: 'missing_unsubscribe_link', where: 'body', words: 'The unsubscribe link is missing: put {unsubscribe_link} back. Every review e-mail must let the buyer stop them.' })
  }
  issues.push(...wordIssues(subject, 'subject'), ...wordIssues(body, 'body'))
  return issues
}

/** "Italian text: …" — the first reason a rule's texts are refused, or null. */
export function ruleEmailTextRefusal(text: RuleEmailText | null | undefined): string | null {
  for (const lang of REQUEST_TEXT_LANGUAGES) {
    const t = text?.[lang]
    if (!t) continue
    const issue = checkRequestText(t)[0]
    if (issue) return `${REQUEST_TEXT_LANGUAGE_NAMES[lang]} ${issue.where === 'subject' ? 'subject' : 'text'}: ${issue.words}${issue.match && !issue.words.includes(issue.match) ? ` (“${issue.match}”)` : ''}`
  }
  return null
}

// ── Reading and comparing ────────────────────────────────────────────────────────────────────────────────────────

/** Line ends and the outer spaces a text box adds, removed. */
export function cleanRequestText(text: RequestText): RequestText {
  const clean = (v: string) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
  return { subject: clean(text.subject).replace(/\s*\n\s*/g, ' '), body: clean(text.body) }
}

/** True when the text is today's standard text of that language (so nothing of the rule's own is needed). */
export function isStandardRequestText(lang: RequestTextLanguage, text: RequestText): boolean {
  const a = cleanRequestText(text)
  const b = STANDARD_REQUEST_TEXT[lang]
  return a.subject === b.subject && a.body === b.body
}

/**
 * A rule's texts as sent or stored, read leniently: only languages with a subject and a text, cleaned; a language equal
 * to the standard text is left out (it IS the standard). Null when nothing of its own is left. The check is separate.
 */
export function readRuleEmailText(raw: unknown): RuleEmailText | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: RuleEmailText = {}
  for (const lang of REQUEST_TEXT_LANGUAGES) {
    const v = (raw as Record<string, unknown>)[lang]
    if (!v || typeof v !== 'object') continue
    const { subject, body } = v as { subject?: unknown; body?: unknown }
    if (typeof subject !== 'string' || typeof body !== 'string') continue
    const text = cleanRequestText({ subject, body })
    if (!text.subject && !text.body) continue
    if (isStandardRequestText(lang, text)) continue
    out[lang] = text
  }
  return Object.keys(out).length ? out : null
}

/** The own text a buyer of this language gets from this rule, only when it passes the check; null = the standard text. */
export function ruleTextFor(raw: unknown, lang: RequestTextLanguage): RequestText | null {
  const text = readRuleEmailText(raw)?.[lang] ?? null
  return text && checkRequestText(text).length === 0 ? text : null
}

/** Do two rules' texts say the same (both standard counts as the same)? */
export function sameRuleEmailText(a: unknown, b: unknown): boolean {
  return JSON.stringify(readRuleEmailText(a)) === JSON.stringify(readRuleEmailText(b))
}

/** "Own text" / "Standard text" per language, for a side of an A/B split or a summary. */
export function ruleEmailTextWords(raw: unknown): string {
  const own = readRuleEmailText(raw)
  if (!own) return 'standard e-mail text'
  return REQUEST_TEXT_LANGUAGES.filter((l) => own[l]).map((l) => `own ${REQUEST_TEXT_LANGUAGE_NAMES[l]} text`).join(' · ')
}

// ── Filling the parts (the sender and the preview) ───────────────────────────────────────────────────────────────

export type RequestTextSegment =
  | { kind: 'paragraph'; pieces: Array<{ kind: 'text'; text: string } | { kind: 'unsubscribe' }>; footer: boolean }
  | { kind: 'button' }

/**
 * The text cut into what the e-mail shows, in order: paragraphs (split at blank lines; a paragraph holding the
 * unsubscribe link is a footer line) and the review button on its own. The words still hold {first_name}, {product} and
 * {aspects}; the renderer fills and escapes them.
 */
export function requestTextSegments(body: string): RequestTextSegment[] {
  const out: RequestTextSegment[] = []
  const paragraphs = cleanRequestText({ subject: '', body }).body.split(/\n\s*\n/)
  for (const paragraph of paragraphs) {
    const parts = paragraph.split('{review_button}')
    parts.forEach((part, i) => {
      if (i > 0) out.push({ kind: 'button' })
      const text = part.trim()
      if (!text) return
      const pieces: Array<{ kind: 'text'; text: string } | { kind: 'unsubscribe' }> = []
      text.split('{unsubscribe_link}').forEach((t, j) => {
        if (j > 0) pieces.push({ kind: 'unsubscribe' })
        if (t) pieces.push({ kind: 'text', text: t })
      })
      out.push({ kind: 'paragraph', pieces, footer: text.includes('{unsubscribe_link}') })
    })
  }
  return out
}

/** Fills {first_name}, {product} and {aspects} (plain text: the caller escapes for HTML). */
export function fillRequestText(text: string, values: { firstName: string; product: string; aspects: string }): string {
  return text.replaceAll('{first_name}', values.firstName).replaceAll('{product}', values.product).replaceAll('{aspects}', values.aspects)
}
