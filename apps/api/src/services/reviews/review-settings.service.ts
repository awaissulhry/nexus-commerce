/**
 * Reviews › Settings (2026-10-26, build spec §3.6 / B15, PR D) — how this business replies to reviews (its VOICE),
 * who hears about what (its review ALERTS), its saved reply TEMPLATES, the SENDER its review e-mails carry, and the
 * on/off switch of each review automation.
 *
 *   ReviewSettings       one row per business; no row = the defaults below, which are today's behaviour: replies in
 *                        the buyer's language, neutral, no sign-off; "New negative review" in Nexus to the business's
 *                        owners; the daily digest to the address it uses today; "Rating drop" and "Complaint spike"
 *                        off until switched on.
 *   ReviewReplyTemplate  saved replies, one text per language; the Inbox reply box offers them and the AI drafts follow
 *                        them (review-reply.service.ts).
 *
 * The sender is NOT kept here (build spec ruling 4, one edit path): it is the business identity every buyer e-mail
 * carries (business-identity.service.ts), shown read-only with a link to Settings › Company.
 *
 * Shape: pure parts (defaults, validation, the prompt lines, the reply language) are exported and tested in
 * review-settings.vitest.test.ts; the readers and writers below them run in the business the request runs in.
 */
import { EBAY_REPLY_LIMIT } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, workspaceIdForQuery } from '../../lib/workspace-context.js'
import { resolveBusinessIdentity } from '../business-identity.service.js'
import { defaultFrom } from '../email/transport.js'
import { REVIEW_TEMPLATES } from './review-templates.js'
import { RATING_DROP_RULE, type RatingDropRule } from './rating-drop-math.js'
import { COMPLAINT_SPIKE_RULE, type ComplaintSpikeRule } from './complaint-spike-math.js'
import { readShopReviewPage, shopReviewHeld } from './review-links.service.js'

// ── Vocabulary ────────────────────────────────────────────────────────────────────────────────────────────────────

export const TONES = ['WARM', 'NEUTRAL', 'FORMAL'] as const
export type Tone = (typeof TONES)[number]

export const REPLY_LOCALES = ['it', 'de', 'fr', 'es', 'en'] as const
export type ReplyLocale = (typeof REPLY_LOCALES)[number]

/** 'buyer' = the buyer's own language (the review's, else the market's). */
export const REPLY_LANGUAGES = ['buyer', ...REPLY_LOCALES] as const
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number]

export const ALERT_KEYS = ['negative', 'digest', 'ratingDrop', 'complaintSpike'] as const
export type AlertKey = (typeof ALERT_KEYS)[number]

export const ALERT_VIAS = ['app', 'email'] as const
export type AlertVia = (typeof ALERT_VIAS)[number]

export const TEMPLATE_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number]

export interface VoiceSettings {
  tone: Tone
  languages: ReplyLanguage[]
  signOff: string | null
  avoidWords: string[]
}

export interface AlertSetting {
  key: AlertKey
  on: boolean
  /** User ids; empty = the fallback (owners for "New negative review", today's address for the digest). */
  recipients: string[]
  via: AlertVia[]
}

export const SIGN_OFF_MAX = 80
export const AVOID_WORD_MAX = 40
export const AVOID_WORDS_MAX = 30
export const RECIPIENTS_MAX = 20
export const TEMPLATE_NAME_MAX = 80
export const TEMPLATE_BODY_MAX = 2000
export const TEMPLATES_IN_PROMPT = 5

export const DEFAULT_VOICE: VoiceSettings = { tone: 'NEUTRAL', languages: ['buyer'], signOff: null, avoidWords: [] }

export const DEFAULT_ALERTS: readonly AlertSetting[] = [
  { key: 'negative', on: true, recipients: [], via: ['app'] },
  { key: 'digest', on: true, recipients: [], via: ['email'] },
  // Off until a person switches it on (Phase 3): the hourly check opens nothing while it is off.
  { key: 'ratingDrop', on: false, recipients: [], via: ['app'] },
  // Off until a person switches it on: the hourly spike check opens its alerts in Insights › Alerts either way; on, the
  // people picked hear about each new one (spike-detector.service.ts).
  { key: 'complaintSpike', on: false, recipients: [], via: ['app'] },
]

const LANGUAGE_NAME: Record<ReplyLocale, string> = { it: 'Italian', de: 'German', fr: 'French', es: 'Spanish', en: 'English' }
const ALERT_NAME: Record<AlertKey, string> = { negative: 'New negative review', digest: 'Daily digest', ratingDrop: 'Rating drop', complaintSpike: 'Complaint spike' }

type Problem = { ok: false; words: string }
const problem = (words: string): Problem => ({ ok: false, words })
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const uniq = <T>(values: T[]): T[] => [...new Set(values)]

// ── Reading what is saved (never throws on an odd row: a field that does not read is its default) ──────────────

/** The voice a saved row holds, or the defaults. */
export function voiceFromRow(row: { tone?: unknown; languages?: unknown; signOff?: unknown; avoidWords?: unknown } | null | undefined): VoiceSettings {
  if (!row) return { ...DEFAULT_VOICE, languages: [...DEFAULT_VOICE.languages] }
  const tone = TONES.includes(row.tone as Tone) ? (row.tone as Tone) : DEFAULT_VOICE.tone
  const languages = Array.isArray(row.languages) ? uniq(row.languages.filter((l): l is ReplyLanguage => REPLY_LANGUAGES.includes(l as ReplyLanguage))) : []
  const avoidWords = Array.isArray(row.avoidWords) ? row.avoidWords.map(text).filter(Boolean) : []
  return { tone, languages: languages.length ? languages : ['buyer'], signOff: text(row.signOff) || null, avoidWords }
}

/** The alerts a saved JSON holds, one per key in ALERT_KEYS order; a key it lacks is its default. */
export function alertsFromJson(json: unknown): AlertSetting[] {
  const saved = Array.isArray(json) ? json.filter(isRecord) : []
  return ALERT_KEYS.map((key) => {
    const fallback = DEFAULT_ALERTS.find((a) => a.key === key)!
    const row = saved.find((a) => a.key === key)
    if (!row) return { ...fallback, recipients: [], via: [...fallback.via] }
    const via = Array.isArray(row.via) ? uniq(row.via.filter((v): v is AlertVia => ALERT_VIAS.includes(v as AlertVia))) : fallback.via
    return {
      key,
      on: typeof row.on === 'boolean' ? row.on : fallback.on,
      recipients: Array.isArray(row.recipients) ? uniq(row.recipients.map(text).filter(Boolean)) : [],
      via: key === 'digest' ? ['email'] : via,
    }
  })
}

// ── Validation of a save ─────────────────────────────────────────────────────────────────────────────────────────

export interface SettingsSave {
  voice: VoiceSettings
  alerts: AlertSetting[]
  /** What the save changes: the PUT may send either part alone. */
  changed: { voice: boolean; alerts: boolean }
}

function validVoice(input: unknown, current: VoiceSettings): { ok: true; voice: VoiceSettings } | Problem {
  if (!isRecord(input)) return problem('The reply voice did not arrive in a form Nexus can read. Reload, then try again.')
  const tone = input.tone === undefined ? current.tone : input.tone
  if (!TONES.includes(tone as Tone)) return problem('Pick a tone: Warm, Neutral or Formal.')
  let languages = current.languages
  if (input.languages !== undefined) {
    if (!Array.isArray(input.languages)) return problem('Pick at least one reply language.')
    const unknown = input.languages.find((l) => !REPLY_LANGUAGES.includes(l as ReplyLanguage))
    if (unknown !== undefined) return problem('Nexus writes replies in the buyer’s language, Italian, German, French, Spanish and English only.')
    languages = uniq(input.languages as ReplyLanguage[])
  }
  if (languages.length === 0) return problem('Pick at least one reply language.')
  let signOff = current.signOff
  if (input.signOff !== undefined) {
    if (input.signOff !== null && typeof input.signOff !== 'string') return problem('The sign-off must be text.')
    signOff = text(input.signOff) || null
  }
  if (signOff && signOff.length > SIGN_OFF_MAX) return problem(`Keep the sign-off to ${SIGN_OFF_MAX} characters (it has ${signOff.length}).`)
  let avoidWords = current.avoidWords
  if (input.avoidWords !== undefined) {
    if (!Array.isArray(input.avoidWords) || input.avoidWords.some((w) => typeof w !== 'string')) return problem('Words to avoid must be a list of words.')
    const seen = new Set<string>()
    avoidWords = []
    for (const word of (input.avoidWords as string[]).map(text).filter(Boolean)) {
      const k = word.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      avoidWords.push(word)
    }
  }
  const long = avoidWords.find((w) => w.length > AVOID_WORD_MAX)
  if (long) return problem(`A word to avoid is at most ${AVOID_WORD_MAX} characters: shorten “${long.slice(0, 24)}…”.`)
  if (avoidWords.length > AVOID_WORDS_MAX) return problem(`Keep the list to ${AVOID_WORDS_MAX} words to avoid (it has ${avoidWords.length}).`)
  return { ok: true, voice: { tone: tone as Tone, languages, signOff, avoidWords } }
}

function validAlerts(input: unknown, current: AlertSetting[], teamIds: ReadonlySet<string>): { ok: true; alerts: AlertSetting[] } | Problem {
  if (!Array.isArray(input)) return problem('The alerts did not arrive in a form Nexus can read. Reload, then try again.')
  const next = current.map((a) => ({ ...a, recipients: [...a.recipients], via: [...a.via] }))
  for (const raw of input) {
    if (!isRecord(raw) || !ALERT_KEYS.includes(raw.key as AlertKey)) return problem('Nexus has no such review alert. Reload, then try again.')
    const alert = next.find((a) => a.key === raw.key)!
    const name = ALERT_NAME[alert.key]
    if (raw.on !== undefined) {
      if (typeof raw.on !== 'boolean') return problem(`Say whether “${name}” is on or off.`)
      alert.on = raw.on
    }
    if (raw.recipients !== undefined) {
      if (!Array.isArray(raw.recipients)) return problem(`Pick the people who get “${name}”.`)
      const ids = uniq(raw.recipients.map(text).filter(Boolean))
      if (ids.some((id) => !teamIds.has(id))) return problem(`Someone picked for “${name}” is no longer a member of this business. Reload, then try again.`)
      if (ids.length > RECIPIENTS_MAX) return problem(`“${name}” goes to at most ${RECIPIENTS_MAX} people.`)
      alert.recipients = ids
    }
    if (raw.via !== undefined && alert.key !== 'digest') {
      if (!Array.isArray(raw.via) || raw.via.some((v) => !ALERT_VIAS.includes(v as AlertVia))) return problem(`“${name}” arrives in Nexus, by e-mail or both.`)
      alert.via = uniq(raw.via as AlertVia[])
    }
    if (alert.on && alert.via.length === 0) return problem(`Choose how “${name}” arrives: in Nexus, by e-mail or both.`)
  }
  return { ok: true, alerts: next }
}

/** A PUT body ({ voice?, alerts? }) checked against what is saved and who is in the business. */
export function validateSettingsInput(
  body: unknown,
  ctx: { voice: VoiceSettings; alerts: AlertSetting[]; teamIds: ReadonlySet<string> },
): ({ ok: true } & SettingsSave) | Problem {
  if (!isRecord(body) || (body.voice === undefined && body.alerts === undefined)) return problem('There is nothing to save.')
  let voice = ctx.voice
  let alerts = ctx.alerts
  if (body.voice !== undefined) {
    const v = validVoice(body.voice, ctx.voice)
    if (v.ok === false) return v
    voice = v.voice
  }
  if (body.alerts !== undefined) {
    const a = validAlerts(body.alerts, ctx.alerts, ctx.teamIds)
    if (a.ok === false) return a
    alerts = a.alerts
  }
  return { ok: true, voice, alerts, changed: { voice: body.voice !== undefined, alerts: body.alerts !== undefined } }
}

// ── The voice in a reply ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The language a reply is written in: the buyer's when the business replies in the buyer's language (or lists it),
 * else the first language it lists.
 */
export function replyLocale(languages: readonly ReplyLanguage[], buyer: ReplyLocale): ReplyLocale {
  if (languages.length === 0 || languages.includes('buyer') || languages.includes(buyer)) return buyer
  return (languages.find((l) => l !== 'buyer') as ReplyLocale | undefined) ?? buyer
}

export interface PromptTemplate {
  name: string
  bodies: Partial<Record<ReplyLocale, string>>
}

/** A template's text in a language: that language's, else English, else the first it has. */
export function templateBodyFor(bodies: Partial<Record<ReplyLocale, string>>, locale: ReplyLocale): string | null {
  const own = text(bodies[locale])
  if (own) return own
  const english = text(bodies.en)
  if (english) return english
  for (const l of REPLY_LOCALES) if (text(bodies[l])) return text(bodies[l])
  return null
}

const TONE_RULE: Record<Tone, string> = {
  WARM: 'Voice: warm and personal — short sentences, thank the buyer first; a first name is fine when the review shows one.',
  NEUTRAL: 'Voice: plain and polite, no small talk.',
  FORMAL: 'Voice: formal — the polite form of address (Lei in Italian, Sie in German, vous in French, usted in Spanish), no first names.',
}

/** The lines the AI reply prompt gains from the business's voice and its saved replies for the channel. */
export function voicePromptLines(voice: VoiceSettings, templates: readonly PromptTemplate[], locale: ReplyLocale): string[] {
  const lines = [TONE_RULE[voice.tone]]
  if (voice.avoidWords.length) lines.push(`Never use these words: ${voice.avoidWords.map((w) => `"${w}"`).join(', ')}.`)
  if (voice.signOff) lines.push(`End with this sign-off on its own line: ${voice.signOff}`)
  const examples = templates
    .map((t) => ({ name: t.name, body: templateBodyFor(t.bodies, locale) }))
    .filter((t): t is { name: string; body: string } => !!t.body)
    .slice(0, TEMPLATES_IN_PROMPT)
  if (examples.length) {
    lines.push("The team's saved replies — follow their wording and facts where one fits this review; never copy one that does not:")
    for (const e of examples) lines.push(`- ${e.name}: ${e.body.replace(/\s+/g, ' ').slice(0, 400)}`)
  }
  return lines
}

/** The reply with the sign-off on its own last line — only when it is not there yet and the channel's limit allows. */
export function withSignOff(reply: string, signOff: string | null, limit: number | null): string {
  if (!signOff) return reply
  const body = reply.trimEnd()
  if (body.endsWith(signOff)) return body
  const next = `${body}\n${signOff}`
  return limit != null && next.length > limit ? body : next
}

// ── Templates: validation ────────────────────────────────────────────────────────────────────────────────────────

export interface TemplateInput {
  name?: string
  channel?: TemplateChannel | null
  bodies?: Partial<Record<ReplyLocale, string>>
}

/** A POST (whole) or PATCH (partial) body for a template. */
export function validateTemplateInput(body: unknown, opts: { partial: boolean }): { ok: true; value: TemplateInput } | Problem {
  if (!isRecord(body)) return problem('The template did not arrive in a form Nexus can read.')
  const value: TemplateInput = {}
  if (body.name !== undefined || !opts.partial) {
    const name = text(body.name)
    if (!name) return problem('Give the template a name.')
    if (name.length > TEMPLATE_NAME_MAX) return problem(`Keep the name to ${TEMPLATE_NAME_MAX} characters (it has ${name.length}).`)
    value.name = name
  }
  if (body.channel !== undefined || !opts.partial) {
    const raw = text(body.channel).toUpperCase()
    if (!raw || raw === 'ALL') value.channel = null
    else if (TEMPLATE_CHANNELS.includes(raw as TemplateChannel)) value.channel = raw as TemplateChannel
    else return problem('Pick a channel: Amazon, eBay, Shopify, Etsy or every channel.')
  }
  if (body.bodies !== undefined || !opts.partial) {
    if (!isRecord(body.bodies)) return problem('Write the reply in at least one language.')
    const bodies: Partial<Record<ReplyLocale, string>> = {}
    for (const [locale, raw] of Object.entries(body.bodies)) {
      if (!REPLY_LOCALES.includes(locale as ReplyLocale)) return problem('Templates hold Italian, German, French, Spanish and English texts only.')
      if (raw != null && typeof raw !== 'string') return problem('A reply text must be text.')
      const t = text(raw)
      if (t) bodies[locale as ReplyLocale] = t
    }
    if (Object.keys(bodies).length === 0) return problem('Write the reply in at least one language.')
    value.bodies = bodies
  }
  return { ok: true, value }
}

/** What a whole template breaks, once its parts are merged: a text too long for its channel. Null = fine. */
export function templateProblem(t: { channel: string | null; bodies: Partial<Record<ReplyLocale, string>> }): string | null {
  for (const locale of REPLY_LOCALES) {
    const body = t.bodies[locale]
    if (!body) continue
    if (body.length > TEMPLATE_BODY_MAX) return `A reply is at most ${TEMPLATE_BODY_MAX.toLocaleString('en-US')} characters: shorten the ${LANGUAGE_NAME[locale]} text by ${body.length - TEMPLATE_BODY_MAX}.`
    if (t.channel === 'EBAY' && body.length > EBAY_REPLY_LIMIT) {
      return `eBay takes replies of up to ${EBAY_REPLY_LIMIT} characters: shorten the ${LANGUAGE_NAME[locale]} text by ${body.length - EBAY_REPLY_LIMIT}.`
    }
  }
  return null
}

export function bodiesFromJson(json: unknown): Partial<Record<ReplyLocale, string>> {
  const out: Partial<Record<ReplyLocale, string>> = {}
  if (!isRecord(json)) return out
  for (const locale of REPLY_LOCALES) {
    const t = text(json[locale])
    if (t) out[locale] = t
  }
  return out
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TeamMember {
  userId: string
  name: string
  email: string
  owner: boolean
}

/** The active members of the business the call runs in. */
export async function teamMembers(): Promise<TeamMember[]> {
  const rows = await prisma.workspaceMembership.findMany({
    where: { workspaceId: workspaceIdForQuery(), status: 'active', user: { status: 'active' } },
    select: { userId: true, user: { select: { displayName: true, email: true } }, roles: { select: { role: { select: { key: true } } } } },
  })
  return rows
    .map((m) => ({
      userId: m.userId,
      name: text(m.user.displayName) || text(m.user.email).split('@')[0] || 'A team member',
      email: text(m.user.email),
      owner: m.roles.some((r) => r.role.key === 'OWNER'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The saved voice and alerts (or the defaults), and when and by whom they were saved. */
export async function readVoiceAndAlerts(): Promise<{ id: string | null; voice: VoiceSettings; alerts: AlertSetting[]; updatedAt: Date | null; updatedBy: string | null }> {
  const row = await prisma.reviewSettings.findFirst()
  return {
    id: row?.id ?? null,
    voice: voiceFromRow(row),
    alerts: alertsFromJson(row?.alerts),
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  }
}

/** One alert as saved (or its default). */
export async function readAlert(key: AlertKey): Promise<AlertSetting> {
  return (await readVoiceAndAlerts()).alerts.find((a) => a.key === key)!
}

export interface SenderView {
  name: string | null
  address: string | null
  replyTo: string | null
  /** Where the sender is changed (one edit path). */
  editHref: string
  /** Why this business's buyers get no e-mail yet; null when it has an identity. */
  problem: string | null
  /** Where the review button of a Shopify buyer's e-mail goes (this business's own shop); null = no button. */
  shopReviewPage: string | null
  /** Why Shopify buyers' review e-mails have no button, in words; null when they have one. */
  shopReviewHeld: string | null
}

/** "Name <address>" → its parts. */
export function splitFrom(from: string): { name: string | null; address: string | null } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from)
  if (match) return { name: match[1].trim() || null, address: match[2].trim() || null }
  const bare = from.trim()
  return bare.includes('@') ? { name: null, address: bare } : { name: bare || null, address: null }
}

/** The sender every review e-mail of this business carries (business-identity.service.ts), read-only. */
export async function senderIdentity(): Promise<SenderView> {
  const editHref = '/settings/company'
  const [found, shop] = await Promise.all([resolveBusinessIdentity(), readShopReviewPage().catch(() => null)])
  const shopFacts = shop
    ? { shopReviewPage: shop.url, shopReviewHeld: shopReviewHeld(shop) }
    : { shopReviewPage: null, shopReviewHeld: 'Nexus could not check this business’s shop just now.' }
  if (found.ok === false) return { name: null, address: null, replyTo: null, editHref, problem: found.reason, ...shopFacts }
  const from = splitFrom(found.identity.emailFrom ?? defaultFrom())
  return { name: from.name ?? found.identity.brandName, address: from.address, replyTo: found.identity.supportEmail || null, editHref, problem: null, ...shopFacts }
}

/**
 * Where the digest goes when nobody is picked: for the legacy business the configured digest/support inbox, else its
 * support address from the business identity; for any business without one, its owners. No address is written in code.
 */
export async function digestFallbackRecipients(team?: TeamMember[]): Promise<string[]> {
  const split = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)
  if (workspaceIdForQuery() === LEGACY_WORKSPACE_ID) {
    const configured = process.env.NEXUS_REVIEW_DIGEST_TO ?? process.env.NEXUS_SUPPORT_INBOX
    if (configured) return split(configured)
    const found = await resolveBusinessIdentity()
    if (found.ok !== false && found.identity.supportEmail) return split(found.identity.supportEmail)
  }
  return (team ?? (await teamMembers())).filter((m) => m.owner && m.email).map((m) => m.email)
}

export interface ReviewSettingsView {
  voice: VoiceSettings
  alerts: Array<{ key: AlertKey; on: boolean; recipients: Array<{ userId: string; name: string }>; via: AlertVia[] }>
  sender: SenderView
  team: Array<{ userId: string; name: string; owner: boolean }>
  /** The digest's addresses when nobody is picked. */
  digestFallback: string[]
  /** The three review automation templates and how many are not loaded yet. */
  automationTemplates: { total: number; missing: number }
  /** When "Rating drop" opens an alert (rating-drop-math.ts), for the page to say in words. */
  ratingDropRule: RatingDropRule
  /** When the hourly spike check opens a "Complaint spike" alert (complaint-spike-math.ts), for the page to say in words. */
  complaintSpikeRule: ComplaintSpikeRule
  updatedAt: string | null
  updatedBy: string | null
}

/** GET /api/reviews/settings. */
export async function readReviewSettings(): Promise<ReviewSettingsView> {
  const [saved, team, sender, seeded] = await Promise.all([
    readVoiceAndAlerts(),
    teamMembers(),
    senderIdentity(),
    prisma.automationRule.findMany({ where: { domain: 'reviews', name: { in: REVIEW_TEMPLATES.map((t) => t.name) } }, select: { name: true } }),
  ])
  const names = new Map(team.map((m) => [m.userId, m.name]))
  const loaded = new Set(seeded.map((r) => r.name))
  return {
    voice: saved.voice,
    alerts: saved.alerts.map((a) => ({
      key: a.key,
      on: a.on,
      // Someone who left the business is no longer a recipient: they are not shown and get nothing.
      recipients: a.recipients.filter((id) => names.has(id)).map((id) => ({ userId: id, name: names.get(id)! })),
      via: a.via,
    })),
    sender,
    team: team.map((m) => ({ userId: m.userId, name: m.name, owner: m.owner })),
    digestFallback: await digestFallbackRecipients(team),
    automationTemplates: { total: REVIEW_TEMPLATES.length, missing: REVIEW_TEMPLATES.filter((t) => !loaded.has(t.name)).length },
    ratingDropRule: { ...RATING_DROP_RULE },
    complaintSpikeRule: { ...COMPLAINT_SPIKE_RULE },
    updatedAt: saved.updatedAt?.toISOString() ?? null,
    updatedBy: saved.updatedBy ? (names.get(saved.updatedBy) ?? null) : null,
  }
}

const isUniqueViolation = (err: unknown) => !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002'

/** PUT /api/reviews/settings { voice?, alerts? } → the settings as saved, or why not (in words). */
export async function saveReviewSettings(body: unknown, actor: string | null): Promise<{ ok: true; settings: ReviewSettingsView } | Problem> {
  const [saved, team] = await Promise.all([readVoiceAndAlerts(), teamMembers()])
  const valid = validateSettingsInput(body, { voice: saved.voice, alerts: saved.alerts, teamIds: new Set(team.map((m) => m.userId)) })
  if (valid.ok === false) return valid
  const data = {
    tone: valid.voice.tone,
    languages: valid.voice.languages,
    signOff: valid.voice.signOff,
    avoidWords: valid.voice.avoidWords,
    alerts: valid.alerts as unknown as object,
    updatedBy: actor,
  }
  const write = async (id: string | null) => {
    if (id) await prisma.reviewSettings.update({ where: { id }, data })
    else await prisma.reviewSettings.create({ data })
  }
  try {
    await write(saved.id)
  } catch (err) {
    // Two first saves at once: the other one made the row; this one updates it.
    if (!isUniqueViolation(err)) throw err
    await write((await prisma.reviewSettings.findFirst({ select: { id: true } }))?.id ?? null)
  }
  return { ok: true, settings: await readReviewSettings() }
}

// ── Templates ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReplyTemplateView {
  id: string
  name: string
  channel: TemplateChannel | null
  bodies: Partial<Record<ReplyLocale, string>>
  languages: ReplyLocale[]
  usedCount: number
  updatedAt: string
}

function templateView(row: { id: string; name: string; channel: string | null; bodies: unknown; usedCount: number; updatedAt: Date }): ReplyTemplateView {
  const bodies = bodiesFromJson(row.bodies)
  return {
    id: row.id,
    name: row.name,
    channel: TEMPLATE_CHANNELS.includes(row.channel as TemplateChannel) ? (row.channel as TemplateChannel) : null,
    bodies,
    languages: REPLY_LOCALES.filter((l) => !!bodies[l]),
    usedCount: row.usedCount,
    updatedAt: row.updatedAt.toISOString(),
  }
}

const TEMPLATE_SELECT = { id: true, name: true, channel: true, bodies: true, usedCount: true, updatedAt: true } as const

/** GET /api/reviews/reply-templates[?channel=EBAY]: a channel's templates are its own and the every-channel ones. */
export async function listReplyTemplates(filter: { channel?: string | null } = {}): Promise<ReplyTemplateView[]> {
  const channel = text(filter.channel).toUpperCase()
  const rows = await prisma.reviewReplyTemplate.findMany({
    where: channel ? { OR: [{ channel }, { channel: null }] } : undefined,
    orderBy: [{ usedCount: 'desc' }, { name: 'asc' }],
    select: TEMPLATE_SELECT,
  })
  return rows.map(templateView)
}

type TemplateResult = { ok: true; template: ReplyTemplateView } | { ok: false; code: 400 | 404 | 409; words: string }

const duplicate = (name: string): TemplateResult => ({ ok: false, code: 409, words: `A template called “${name}” already exists. Pick another name.` })

/** POST /api/reviews/reply-templates { name, channel, bodies }. */
export async function createReplyTemplate(body: unknown, actor: string | null): Promise<TemplateResult> {
  const valid = validateTemplateInput(body, { partial: false })
  if (valid.ok === false) return { ok: false, code: 400, words: valid.words }
  const { name, channel = null, bodies = {} } = valid.value
  const broken = templateProblem({ channel, bodies })
  if (broken) return { ok: false, code: 400, words: broken }
  try {
    const row = await prisma.reviewReplyTemplate.create({ data: { name: name!, channel, bodies, createdBy: actor }, select: TEMPLATE_SELECT })
    return { ok: true, template: templateView(row) }
  } catch (err) {
    if (isUniqueViolation(err)) return duplicate(name!)
    throw err
  }
}

const NOT_FOUND = { ok: false as const, code: 404 as const, words: 'Nexus could not find this template. It may have been deleted.' }

/** PATCH /api/reviews/reply-templates/:id { name?, channel?, bodies? }. */
export async function updateReplyTemplate(id: string, body: unknown): Promise<TemplateResult> {
  const valid = validateTemplateInput(body, { partial: true })
  if (valid.ok === false) return { ok: false, code: 400, words: valid.words }
  const current = await prisma.reviewReplyTemplate.findFirst({ where: { id }, select: TEMPLATE_SELECT })
  if (!current) return NOT_FOUND
  const merged = {
    channel: valid.value.channel !== undefined ? valid.value.channel : current.channel,
    bodies: valid.value.bodies ?? bodiesFromJson(current.bodies),
  }
  const broken = templateProblem(merged)
  if (broken) return { ok: false, code: 400, words: broken }
  try {
    const row = await prisma.reviewReplyTemplate.update({ where: { id }, data: valid.value, select: TEMPLATE_SELECT })
    return { ok: true, template: templateView(row) }
  } catch (err) {
    if (isUniqueViolation(err)) return duplicate(valid.value.name ?? current.name)
    throw err
  }
}

/** DELETE /api/reviews/reply-templates/:id. */
export async function deleteReplyTemplate(id: string): Promise<{ ok: true; name: string } | typeof NOT_FOUND> {
  const current = await prisma.reviewReplyTemplate.findFirst({ where: { id }, select: { id: true, name: true } })
  if (!current) return NOT_FOUND
  await prisma.reviewReplyTemplate.delete({ where: { id } })
  return { ok: true, name: current.name }
}

/** POST /api/reviews/reply-templates/:id/use — a person picked it in the Inbox reply box. */
export async function markReplyTemplateUsed(id: string): Promise<{ ok: true; usedCount: number } | typeof NOT_FOUND> {
  const current = await prisma.reviewReplyTemplate.findFirst({ where: { id }, select: { id: true } })
  if (!current) return NOT_FOUND
  const row = await prisma.reviewReplyTemplate.update({ where: { id }, data: { usedCount: { increment: 1 } }, select: { usedCount: true } })
  return { ok: true, usedCount: row.usedCount }
}

/** The saved replies the AI draft follows: the channel's own and the every-channel ones, most used first. */
export async function promptTemplatesFor(channel: string | null): Promise<PromptTemplate[]> {
  const templates = await listReplyTemplates({ channel })
  return templates.map((t) => ({ name: t.name, bodies: t.bodies }))
}

// ── Review automations: on / off ─────────────────────────────────────────────────────────────────────────────────

/** PATCH /api/reviews/automation-rules/:id { enabled } — review automations only. */
export async function setReviewAutomationEnabled(
  id: string,
  enabled: unknown,
): Promise<{ ok: true; rule: { id: string; name: string; enabled: boolean; dryRun: boolean } } | { ok: false; code: 400 | 404; words: string }> {
  if (typeof enabled !== 'boolean') return { ok: false, code: 400, words: 'Say whether the automation is on or off.' }
  const rule = await prisma.automationRule.findFirst({ where: { id, domain: 'reviews' }, select: { id: true } })
  if (!rule) return { ok: false, code: 404, words: 'Nexus could not find this review automation.' }
  const row = await prisma.automationRule.update({ where: { id }, data: { enabled }, select: { id: true, name: true, enabled: true, dryRun: true } })
  return { ok: true, rule: row }
}

