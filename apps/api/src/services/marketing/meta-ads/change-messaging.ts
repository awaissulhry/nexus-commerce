/**
 * Meta step 38 (2026-10-26) — messages and inbox labels as drafts (pure: built from a request and the live state, no call).
 * Master rows EN-012, EN-026, EN-036, EN-037, EN-039, EN-040, EN-044, EN-046, EN-910, LD-049, OT-008 (create-meta-message) and
 * EN-912 … EN-915 (set-meta-conversation-labels); what Meta allows is checked on its v26 reference, guides and Python SDK
 * (gateway/meta-messaging-rules.ts names each page). Meta has no check (validate_only) for any of these: every preview says
 * so. Nothing here spends money.
 *
 * A MESSAGE REACHES A PERSON AND CANNOT BE RECALLED. So: only to a person who wrote to the business first (step 15's
 * ownPerson); inside Meta's standard 24-hour window as RESPONSE or UPDATE; after it only what Meta allows — a person's own
 * reply with the HUMAN_AGENT tag within 7 days of the person's last message (never promotional; an App Review feature whose
 * state no API reads: Meta's refusal says so, and the message is never sent again as another kind) or an APPROVED Messenger
 * utility template (Messenger only; never marketing); ONE private reply within 7 days of a comment or visitor post; a
 * creator message only through Instagram's Partnership folder. ACCOUNT_UPDATE, POST_PURCHASE_UPDATE and
 * CONFIRMED_EVENT_UPDATE are refused (Meta's error 100 since 2026-04-27). Nexus cannot see whether a click-to-message ad
 * opened a 7-day window, so it holds to 24 hours. Never to an Amazon buyer: these tools take only Meta's own ids of people
 * who wrote to the Page, never an order's buyer.
 *
 * PEOPLE'S DATA. The preview shows the exact words and the recipient as Meta's scoped id — the approval needs both (a person
 * approves exactly what goes, and the run sends exactly that). The change record keeps the kind of message, the Page, the
 * conversation and Meta's message id: never the words or the person's id. A label's record keeps the person's id it was put
 * on, for its undo (the same rule as step 37's block). Nexus's call log keeps neither (gateway rule `ledger`).
 */
import type { MetaChangeDraft, MetaChangeRequest } from './change-draft.js'
import { changeLines } from './change-draft.js'
import type { MetaChangeResult } from './write-client.js'
import { META_DEAD_TAGS, META_INSTAGRAM_INBOX_APP, META_MESSAGE_LIMITS, META_MESSAGE_MAX_BODY, META_PAGE_INBOX_APP, templatePlaceholders } from '../../gateway/meta-messaging-rules.js'
import { META_COMMENT_TEXT, META_NAME_TEXT } from '../../gateway/meta-write-text.js'
import type { PageTemplate, PersonState, PrivateReplyTarget } from './live-messaging-change.js'
import type { MessagingPlatform } from './live-messaging.js'

export const MESSAGE_ACTIONS = ['message', 'private-reply', 'sender-action', 'instant-form', 'creator-message', 'handover'] as const
export type MessageAction = typeof MESSAGE_ACTIONS[number]
export const MESSAGE_MODES = ['response', 'update', 'human-agent', 'utility'] as const
export type MessageMode = typeof MESSAGE_MODES[number]
export const SENDER_ACTIONS = ['seen', 'typing-on', 'typing-off', 'react', 'unreact'] as const
export type SenderAction = typeof SENDER_ACTIONS[number]
export const HANDOVER_CONTROLS = ['pass', 'release', 'take'] as const
export type HandoverControl = typeof HANDOVER_CONTROLS[number]
export const HANDOVER_TARGETS = ['page-inbox', 'instagram-inbox', 'default', 'app'] as const
export type HandoverTarget = typeof HANDOVER_TARGETS[number]
export const NOTIFICATIONS = { regular: 'REGULAR', silent: 'SILENT_PUSH', none: 'NO_PUSH' } as const
export const MEDIA_TYPES = ['image', 'video', 'audio', 'file'] as const

const DAY_MS = 86_400_000
const STANDARD_WINDOW_MS = DAY_MS
const HUMAN_AGENT_MS = 7 * DAY_MS
const PRIVATE_REPLY_MS = 7 * DAY_MS

/** What a message change kept (AgentChange before / after): never the words or the person's id. */
export interface MessageRecord {
  action: MessageAction
  platform: MessagingPlatform
  pageId: string
  instagramId?: string | null
  /** message: response / update / human-agent / utility; sender-action: its action; handover: its control. */
  kind?: string | null
  conversationId?: string | null
  /** The comment or visitor post a private reply answered. */
  commentId?: string | null
  postId?: string | null
  /** Meta's id of the message it sent (null until sent, or when Meta named none). */
  messageId?: string | null
  sent?: boolean
}

// ── what Meta's codes mean here ────────────────────────────────────────────────────────────────────────────────────

export const MESSAGE_EXPLAIN: Readonly<Record<string, string>> = {
  10: 'Meta refused it for permission: outside the person\'s window Meta needs the Human Agent feature (App Review and Business Verification) for HUMAN_AGENT, or an approved utility template; inside it, pages_messaging — and Advanced Access for anyone without a role on the business\'s Meta app (subcode 2018300: the conversation belongs to Meta Business AI). Nexus never sends it again as another kind of message.',
  100: 'Meta says a parameter is not valid for this message (the person\'s id, the window, the template or a tag): nothing was sent.',
  200: 'Meta refused it for permission: the system user needs the MESSAGING task on the chosen Page and its token pages_messaging (Instagram also instagram_basic and instagram_manage_messages; creators instagram_creator_marketplace_messaging, App Review); with Standard access Meta delivers only to people with a role on the business\'s Meta app — real customers need Advanced Access (App Review). Nexus has no way around it.',
  551: 'Meta: "This person isn\'t available right now" — they may have blocked the Page, closed their account or turned messages off. Nothing was sent.',
  613: 'Meta asked to slow down (too many messages for now): nothing more is sent; ask again in a while.',
  368: 'Meta judged this message abusive or not allowed for this Page (its own policy check): a person looks at the Page in Meta\'s Business Support Home before asking again.',
  2022: 'Meta has switched off commerce messages for this app for now: nothing was sent.',
  10900: 'Meta: "Activity already replied to" — that comment or post already has its one private reply.',
  10903: 'Meta: "This user can\'t reply to this activity" — Meta lets no private reply go to it.',
  10904: 'Meta: the Page has messages switched off in its settings.',
  80006: 'Meta allows only so many Messenger calls to this Page in a while: wait a few minutes and ask again.',
  80002: 'Meta allows only so many calls to this Instagram account in a while: wait a few minutes and ask again.',
  9: 'Meta\'s creator limits: 250 new creators a day and 2 messages per creator in 30 days before they reply (subcodes 2207094 / 2207095), or the creator has had too many brands writing (2207096): ask again later.',
  1: 'Meta: the form id is not right, or the form is not usable inside a conversation (subcode 2018382: only CUSTOM, EMAIL, FIRST_NAME, FULL_NAME, LAST_NAME and PHONE questions, and Open Sharing on).',
}

export const MESSAGE_NO_CHECK = 'Meta has no check (validate_only) for a message: the preview is built from the live conversation, read again before it is sent.'
export const MESSAGE_FINAL = 'A message reaches the person at once and cannot be recalled or deleted by Nexus.'
export const GERMAN_RULE = 'If the person is in Germany (or California) and these words were written by an automated system, Meta\'s policy asks that the message says it is automated.'
export const ACCESS_NOTE = 'With Standard access Meta delivers only to people with a role on the business\'s Meta app, its Page, its Instagram account or its business portfolio; real customers need Advanced Access for pages_messaging (Instagram: instagram_manage_messages), which takes App Review — Nexus has no way around it. The Marketing API access tier (development_access today) does not gate messaging; the messaging permission\'s own access level does.'
export const NO_AMAZON = 'Nexus never writes here to a marketplace buyer: these tools take only Meta\'s own ids of people who wrote to the business on Messenger or Instagram (Amazon and eBay buyers are written to through send-customer-message).'

// ── the pieces of a request ────────────────────────────────────────────────────────────────────────────────────────

function request(r: Omit<MetaChangeRequest, 'step' | 'check' | 'raisesSpend' | 'readBackInPost' | 'budget'>): MetaChangeRequest {
  return { step: 1, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, asPage: true, skipReadBack: true, ...r }
}

function draftOf(input: { summary: string; lines: Array<[string, unknown, unknown]>; warnings: string[]; requests: MetaChangeRequest[]; stands: unknown; before: unknown; after: unknown; skipped?: string[] }): MetaChangeDraft {
  const { changes, more } = changeLines(input.lines)
  return {
    summary: input.summary, changes, totals: { requests: input.requests.length, ...(more ? { moreLines: more } : {}) },
    warnings: input.warnings, spendsMoney: [], skipped: input.skipped ?? [], requests: input.requests.map((r, i) => ({ ...r, step: i + 1 })),
    stands: input.stands, before: input.before, after: input.after,
  }
}

const json = (v: unknown) => JSON.stringify(v)
const platformName = (p: MessagingPlatform) => (p === 'instagram' ? 'Instagram Direct' : 'Messenger')
const businessName = (p: MessagingPlatform) => (p === 'instagram' ? 'the chosen Instagram account' : 'the chosen Facebook Page')
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

/** The words a message carries: text, a media link Meta fetches, quick replies; the person's own limits. */
export interface MessageWords {
  text?: string
  mediaUrl?: string
  mediaType?: typeof MEDIA_TYPES[number]
  quickReplies?: Array<{ title: string; payload: string }>
}

/** Why the words are refused for this platform (Meta's own limits), or null. */
export function wordsProblem(words: MessageWords, platform: MessagingPlatform, allowQuick = true): string | null {
  if (words.text === undefined && !words.mediaUrl) return 'Give the exact words (text) or a media link (mediaUrl with mediaType).'
  if (words.text !== undefined && words.mediaUrl) return 'Meta sends text or one media attachment per message, not both: send them as two messages.'
  if (words.mediaUrl && !words.mediaType) return 'Name the media type (mediaType: image, video, audio or file).'
  if (words.mediaType && !words.mediaUrl) return 'mediaType goes with mediaUrl.'
  if (words.text !== undefined) {
    if (!words.text.trim()) return 'The text is empty.'
    if (!META_COMMENT_TEXT.test(words.text)) return 'The text is printable text (line breaks allowed; no control or format characters).'
    if ([...words.text].length > META_MESSAGE_LIMITS.messengerText) return `The text is at most ${META_MESSAGE_LIMITS.messengerText} characters.`
    if (platform === 'instagram' && Buffer.byteLength(words.text, 'utf8') > META_MESSAGE_LIMITS.instagramTextBytes) return `On Instagram Meta takes at most ${META_MESSAGE_LIMITS.instagramTextBytes} bytes of text (UTF-8: emoji and accented letters take more than one): shorten it.`
  }
  if (platform === 'instagram' && words.mediaType === 'file') return 'Instagram Direct takes an image, a video or audio (a file only in a creator message).'
  if (words.quickReplies?.length) {
    if (!allowQuick) return 'Quick replies are for a message in a conversation only.'
    if (words.quickReplies.length > META_MESSAGE_LIMITS.quickReplies) return `At most ${META_MESSAGE_LIMITS.quickReplies} quick replies.`
    for (const q of words.quickReplies) {
      if ([...q.title].length > META_MESSAGE_LIMITS.quickReplyTitle || !META_NAME_TEXT.test(q.title) || !q.title.trim()) return `A quick reply's title is 1–${META_MESSAGE_LIMITS.quickReplyTitle} printable characters ("${q.title.slice(0, 30)}").`
      if ([...q.payload].length > META_MESSAGE_LIMITS.payload || !META_NAME_TEXT.test(q.payload) || !q.payload.trim()) return `A quick reply's payload is 1–${META_MESSAGE_LIMITS.payload} printable characters.`
    }
  }
  return null
}

/** The message object as Meta takes it (gateway meta-messaging-rules.ts judges exactly this shape). */
export function messageOf(words: MessageWords, allowQuick = true): Record<string, unknown> {
  const quick = allowQuick && words.quickReplies?.length ? { quick_replies: words.quickReplies.map((q) => ({ content_type: 'text', title: q.title, payload: q.payload })) } : {}
  if (words.text !== undefined) return { text: words.text, ...quick }
  return { attachment: { type: words.mediaType, payload: { url: words.mediaUrl } }, ...quick }
}

/** What the person will read, as the preview shows it (the exact words, the media link, the quick replies). */
export function wordsLine(words: MessageWords): string {
  const quick = words.quickReplies?.length ? ` [quick replies: ${words.quickReplies.map((q) => `"${q.title}"`).join(', ')}]` : ''
  return words.text !== undefined ? `"${words.text}"${quick}` : `${words.mediaType} from ${words.mediaUrl} (Meta fetches it)${quick}`
}

/** The encoded body must fit the gateway's cap, so a long emoji text is refused here, never after approval. */
function bodyTooLong(params: Record<string, string>): string | null {
  const length = new URLSearchParams(params).toString().length
  return length > META_MESSAGE_MAX_BODY ? `The message is too long once encoded for Meta (${length} characters, at most ${META_MESSAGE_MAX_BODY}): shorten it.` : null
}

/** A done send: Meta's message id (never the recipient id Meta answers beside it). */
export const messageIdOf = (result: MetaChangeResult): string | null => {
  const id = result.node?.message_id
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

const sentSentence = (what: string) => (result: MetaChangeResult) => {
  const id = messageIdOf(result)
  return `${what}: Meta sent it${id ? ` (message ${id})` : ''}.`
}
const confirmedSentence = (what: string) => (result: MetaChangeResult) => `${what}: Meta ${result.node && (result.node as Record<string, unknown>).success === false ? 'did not confirm it' : 'confirmed it'}.`

// ── the window ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Meta's windows for this person now: the standard 24 hours and the Human Agent 7 days after the person's last message. */
export function windowNow(person: PersonState, now: number): { last: number | null; open: boolean; humanAgent: boolean; endsAt: number | null } {
  const last = person.lastMessageFromPerson ? Date.parse(person.lastMessageFromPerson) : NaN
  if (!Number.isFinite(last)) return { last: null, open: false, humanAgent: false, endsAt: null }
  return { last, open: now < last + STANDARD_WINDOW_MS, humanAgent: now < last + HUMAN_AGENT_MS, endsAt: last + STANDARD_WINDOW_MS }
}

function windowRefusal(person: PersonState, now: number, mode: MessageMode): string | null {
  const w = windowNow(person, now)
  const none = `Nexus finds no message from this person among the conversation's 20 newest, so Meta's window cannot be confirmed open.`
  if (mode === 'response' || mode === 'update') {
    if (w.open) return null
    if (w.last === null) return `${none} Nothing is sent. A person's own reply after the window goes with mode human-agent (within 7 days of the person's last message); an order, shipping or account update with mode utility (an approved Messenger utility template).`
    return `Meta's standard 24-hour window for this person closed at ${iso(w.endsAt!)} (their last message: ${iso(w.last)}), so a RESPONSE or UPDATE is not sent (Nexus cannot see a 7-day click-to-message ad window). ${w.humanAgent ? 'A person\'s own reply (never promotional) goes with mode human-agent until ' + iso(w.last + HUMAN_AGENT_MS) + '; ' : ''}an order, shipping or account update goes with mode utility (Messenger only).`
  }
  if (mode === 'human-agent') {
    if (w.last === null) return `${none} The HUMAN_AGENT tag is for a reply within 7 days of the person's last message: nothing is sent.`
    if (w.open) return `The person's standard window is still open until ${iso(w.endsAt!)}: send it as mode response (a tag is for after the window).`
    if (!w.humanAgent) return `The person's last message was ${iso(w.last)}: more than 7 days ago, so Meta allows no HUMAN_AGENT reply any more. Only an approved Messenger utility template (mode utility) can still go.`
    return null
  }
  return null
}

// ── create-meta-message ─────────────────────────────────────────────────────────────────────────────────────────────

const recordOf = (action: MessageAction, platform: MessagingPlatform, pageId: string, extra: Partial<MessageRecord> = {}): MessageRecord => ({ action, platform, pageId, messageId: null, sent: false, ...extra })
const pageKind = (p: MessagingPlatform) => (p === 'instagram' ? 'instagrampage' as const : 'messengerpage' as const)
const sendOperation = (p: MessagingPlatform) => (p === 'instagram' ? 'instagram.message' : 'messenger.message')

export interface MessageInput {
  mode: MessageMode
  words: MessageWords
  personaId?: string | null
  personaName?: string | null
  replyToMessageId?: string | null
  notification?: keyof typeof NOTIFICATIONS | null
}

/** EN-036 / EN-037 / EN-040 / EN-044 — a message in a person's conversation (RESPONSE, UPDATE or HUMAN_AGENT). */
export function conversationMessageDraft(person: PersonState, input: MessageInput, now: number): MetaChangeDraft | { refusal: string } {
  if (input.mode === 'utility') return { refusal: 'mode utility sends an approved Messenger utility template: give template.' }
  const p = person.platform
  if (input.personaId && p !== 'messenger') return { refusal: 'Personas are Messenger\'s (Meta has none for Instagram Direct).' }
  if (input.notification && p !== 'messenger') return { refusal: 'notification is a Messenger setting (Instagram Direct has none).' }
  const wordsRefusal = wordsProblem(input.words, p)
  if (wordsRefusal) return { refusal: wordsRefusal }
  if (input.replyToMessageId && !person.messageIds.includes(input.replyToMessageId)) return { refusal: 'replyToMessageId is not one of the conversation\'s 20 newest messages (meta-conversations view messages lists them): Meta answers no older one.' }
  const windowProblem = windowRefusal(person, now, input.mode)
  if (windowProblem) return { refusal: windowProblem }
  const w = windowNow(person, now)
  const type = input.mode === 'human-agent' ? 'MESSAGE_TAG' : input.mode === 'update' ? 'UPDATE' : 'RESPONSE'
  const params: Record<string, string> = {
    recipient: json({ id: person.personId }),
    messaging_type: type,
    message: json(messageOf(input.words)),
    ...(input.mode === 'human-agent' ? { tag: 'HUMAN_AGENT' } : {}),
    ...(input.notification ? { notification_type: NOTIFICATIONS[input.notification] } : {}),
    ...(input.personaId ? { persona_id: input.personaId } : {}),
    ...(input.replyToMessageId ? { reply_to: json({ mid: input.replyToMessageId }) } : {}),
  }
  const tooLong = bodyTooLong(params)
  if (tooLong) return { refusal: tooLong }
  const how = input.mode === 'human-agent'
    ? `HUMAN_AGENT tag (a person's own reply, non-promotional), until ${iso(w.last! + HUMAN_AGENT_MS)}`
    : `${type} inside the standard window (open until ${iso(w.endsAt!)})`
  const before = recordOf('message', p, person.pageId, { instagramId: p === 'instagram' ? person.instagramId : null, kind: input.mode, conversationId: person.conversationId })
  return draftOf({
    summary: `Send one ${platformName(p)} message as ${businessName(p)} to the person in conversation ${person.conversationId} — it reaches them at once and cannot be recalled.`,
    lines: [
      ['To', null, `${platformName(p)} person ${person.personId} (their scoped id; conversation ${person.conversationId})`],
      ['Message', null, wordsLine(input.words)],
      ['Sent as', null, how],
      ...(input.personaId ? [['As persona', null, `${input.personaName ?? 'persona'} (${input.personaId})`] as [string, unknown, unknown]] : []),
      ...(input.replyToMessageId ? [['In reply to message', null, input.replyToMessageId] as [string, unknown, unknown]] : []),
      ...(input.notification ? [['Notification', null, NOTIFICATIONS[input.notification]] as [string, unknown, unknown]] : []),
    ],
    warnings: [
      MESSAGE_FINAL, MESSAGE_NO_CHECK,
      ...(input.mode === 'human-agent' ? ['HUMAN_AGENT is for a person\'s own reply to the person\'s question, never promotional (no offer, coupon or discount). It needs Meta\'s Human Agent feature (App Review and Business Verification), whose state no API reads: if Meta refuses it, its words are passed on and Nexus never sends the message again as another kind.'] : []),
      ...(input.mode === 'update' ? ['UPDATE is a message that answers nothing the person asked (inside the window it may be promotional).'] : []),
      ...(input.words.mediaUrl ? ['Meta fetches the media from the https link you gave; Nexus uploads no file.'] : []),
      GERMAN_RULE, ACCESS_NOTE, NO_AMAZON,
    ],
    requests: [request({
      label: `Send the ${platformName(p)} message to the person in conversation ${person.conversationId}`, objectId: person.pageId, objectKind: pageKind(p), edge: 'messages',
      operation: sendOperation(p), params, undoable: false, explain: MESSAGE_EXPLAIN, doneSentence: sentSentence(`The ${platformName(p)} message to the person in conversation ${person.conversationId}`),
    })],
    stands: { action: 'message', platform: p, conversationId: person.conversationId, lastMessageFromPerson: person.lastMessageFromPerson, windowOpen: w.open, humanAgent: w.humanAgent, replyToKnown: input.replyToMessageId ? person.messageIds.includes(input.replyToMessageId) : null },
    before, after: { ...before, sent: true },
  })
}

/** The utility template as it is sent: its parameters and buttons, checked against the template Meta answers. */
export interface UtilityInput {
  template: PageTemplate
  parameters: Array<{ component: 'header' | 'body'; name?: string; text: string }>
  buttons: Array<{ type: 'postback' | 'url'; value: string }>
}

const componentsOfTemplate = (t: PageTemplate): Array<Record<string, unknown>> => (Array.isArray(t.components) ? t.components.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object') : [])
const textOf = (t: PageTemplate, type: 'HEADER' | 'BODY'): string | null => {
  const c = componentsOfTemplate(t).find((x) => String(x.type).toUpperCase() === type)
  return c && typeof c.text === 'string' ? c.text : null
}

/** The exact words the person reads: the template's header and body with each placeholder filled. */
export function utilityText(input: UtilityInput): { header: string | null; body: string | null } | { problem: string } {
  const named = input.template.parameterFormat === 'NAMED'
  const fill = (part: 'header' | 'body', text: string | null): string | null | { problem: string } => {
    if (text === null) return input.parameters.some((p) => p.component === part) ? { problem: `The template has no ${part} text, so it takes no ${part} parameters.` } : null
    const given = input.parameters.filter((p) => p.component === part)
    const holes = templatePlaceholders(text)
    if (named) {
      const names = [...new Set(holes.named)]
      if (given.length !== names.length || given.some((g) => !g.name || !names.includes(g.name))) return { problem: `The template's ${part} takes the named parameters ${names.join(', ') || '(none)'}, each once (parameters[].name).` }
      return text.replace(/\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g, (_, n: string) => given.find((g) => g.name === n)!.text)
    }
    if (given.some((g) => g.name)) return { problem: 'A positional template takes its parameters in order, without names.' }
    if (given.length !== holes.positional.length) return { problem: `The template's ${part} has ${holes.positional.length} placeholder${holes.positional.length === 1 ? '' : 's'}: give ${holes.positional.length} ${part} parameter${holes.positional.length === 1 ? '' : 's'} in order.` }
    return text.replace(/\{\{\s*([1-9]\d?)\s*\}\}/g, (_, n: string) => given[Number(n) - 1]?.text ?? `{{${n}}}`)
  }
  const header = fill('header', textOf(input.template, 'HEADER'))
  if (header && typeof header === 'object') return header
  const body = fill('body', textOf(input.template, 'BODY'))
  if (body && typeof body === 'object') return body
  return { header: header as string | null, body: body as string | null }
}

/** The template message as Meta takes it (utility-messages.md: lower-case component types, text parameters, button params). */
export function utilityMessageOf(input: UtilityInput): Record<string, unknown> {
  const named = input.template.parameterFormat === 'NAMED'
  const part = (component: 'header' | 'body') => input.parameters.filter((p) => p.component === component)
    .map((p) => ({ type: 'text', ...(named && p.name ? { parameter_name: p.name } : {}), text: p.text }))
  const components: Array<Record<string, unknown>> = []
  if (part('header').length) components.push({ type: 'header', parameters: part('header') })
  if (part('body').length) components.push({ type: 'body', parameters: part('body') })
  if (input.buttons.length) components.push({ type: 'buttons', parameters: input.buttons.map((b) => (b.type === 'url' ? { type: 'URL', url: b.value } : { type: 'POSTBACK', payload: b.value })) })
  return { template: { name: input.template.name, language: { code: input.template.language }, ...(components.length ? { components } : {}) } }
}

/** A Messenger utility message (an APPROVED utility template of the chosen Page) — the documented way outside the window. */
export function utilityMessageDraft(person: PersonState, input: UtilityInput, now: number): MetaChangeDraft | { refusal: string } {
  if (person.platform !== 'messenger') return { refusal: 'Utility templates are Messenger\'s (Instagram Direct has none): outside the window an Instagram person gets only a HUMAN_AGENT reply.' }
  const t = input.template
  if (t.status !== 'APPROVED') return { refusal: `Template "${t.name}" is ${t.status ?? 'not approved'}: Meta sends only an APPROVED utility template (meta-message-templates view messenger shows its review).` }
  if (t.category && t.category !== 'UTILITY') return { refusal: `Template "${t.name}" is ${t.category}, not UTILITY.` }
  if (!t.language) return { refusal: `Meta names no language for template "${t.name}", so Nexus cannot send it.` }
  if (input.buttons.length > META_MESSAGE_LIMITS.messengerButtons) return { refusal: `At most ${META_MESSAGE_LIMITS.messengerButtons} button parameters.` }
  for (const p of [...input.parameters.map((x) => x.text), ...input.buttons.map((b) => b.value)]) {
    if (!p.trim() || !META_NAME_TEXT.test(p) || [...p].length > META_MESSAGE_LIMITS.bodyText) return { refusal: 'Each parameter is printable text on one line (no control or format characters).' }
  }
  const words = utilityText(input)
  if ('problem' in words) return { refusal: words.problem }
  const w = windowNow(person, now)
  const params: Record<string, string> = { recipient: json({ id: person.personId }), messaging_type: 'UTILITY', message: json(utilityMessageOf(input)) }
  const tooLong = bodyTooLong(params)
  if (tooLong) return { refusal: tooLong }
  const before = recordOf('message', 'messenger', person.pageId, { kind: 'utility', conversationId: person.conversationId })
  return draftOf({
    summary: `Send the approved utility template "${t.name}" (${t.language}) on Messenger as the chosen Facebook Page to the person in conversation ${person.conversationId} — it reaches them at once and cannot be recalled.`,
    lines: [
      ['To', null, `Messenger person ${person.personId} (their scoped id; conversation ${person.conversationId})`],
      ...(words.header ? [['Header', null, `"${words.header}"`] as [string, unknown, unknown]] : []),
      ['Message', null, words.body !== null ? `"${words.body}"` : '(the template has no body text)'],
      ...(input.buttons.length ? [['Button values', null, input.buttons.map((b) => `${b.type} ${b.value}`).join(', ')] as [string, unknown, unknown]] : []),
      ['Sent as', null, `UTILITY (template ${t.name} ${t.templateId}; ${w.open ? 'inside' : 'outside'} the standard window)`],
    ],
    warnings: [
      MESSAGE_FINAL, MESSAGE_NO_CHECK,
      'A utility message is an order, shipping, account or appointment update the person asked for — never marketing (Meta\'s rule for utility messages; its review may restrict the Page if it is).',
      'It needs page_utility_messaging on the token.', ACCESS_NOTE, NO_AMAZON,
    ],
    requests: [request({
      label: `Send utility template "${t.name}" to the person in conversation ${person.conversationId}`, objectId: person.pageId, objectKind: 'messengerpage', edge: 'messages',
      operation: 'messenger.message', params, undoable: false, explain: MESSAGE_EXPLAIN, doneSentence: sentSentence(`The utility message "${t.name}" to the person in conversation ${person.conversationId}`),
    })],
    stands: { action: 'utility', conversationId: person.conversationId, templateId: t.templateId, status: t.status, components: t.components, parameterFormat: t.parameterFormat },
    before, after: { ...before, sent: true },
  })
}

/** EN-012 / EN-026 — ONE private reply to a person's comment (Facebook, Instagram) or visitor post (Facebook), within 7 days. */
export function privateReplyDraft(target: PrivateReplyTarget, words: MessageWords, now: number): MetaChangeDraft | { refusal: string } {
  if (words.mediaUrl || words.quickReplies?.length) return { refusal: 'A private reply is one text message (Nexus sends no media or quick replies in it).' }
  const wordsRefusal = wordsProblem(words, target.platform, false)
  if (wordsRefusal) return { refusal: wordsRefusal }
  const created = target.createdAt ? Date.parse(target.createdAt) : NaN
  if (!Number.isFinite(created)) return { refusal: 'Meta names no time for that comment or post, so Nexus cannot confirm it is within the 7 days Meta allows a private reply.' }
  if (now >= created + PRIVATE_REPLY_MS) return { refusal: `That ${target.commentId ? 'comment' : 'post'} was written ${iso(created)}: more than 7 days ago, so Meta allows no private reply any more.` }
  const what = target.commentId ? `comment ${target.commentId}` : `visitor post ${target.postId}`
  const params: Record<string, string> = { recipient: json(target.commentId ? { comment_id: target.commentId } : { post_id: target.postId }), messaging_type: 'RESPONSE', message: json(messageOf(words, false)) }
  const tooLong = bodyTooLong(params)
  if (tooLong) return { refusal: tooLong }
  const before = recordOf('private-reply', target.platform, target.pageId, { instagramId: target.instagramId, commentId: target.commentId, postId: target.postId })
  return draftOf({
    summary: `Send ONE private ${platformName(target.platform)} reply as ${businessName(target.platform)} to the person who wrote ${what} — it reaches them at once and cannot be recalled.`,
    lines: [
      ['To', null, `the author of ${what} (Meta finds them from it)`],
      ['Message', null, wordsLine(words)],
      ['Sent as', null, `a private reply (RESPONSE; Meta allows one, until ${iso(created + PRIVATE_REPLY_MS)}; Meta adds a link to the ${target.commentId ? 'comment' : 'post'})`],
    ],
    warnings: [
      MESSAGE_FINAL, MESSAGE_NO_CHECK,
      'Meta allows ONE private reply per comment or post: the conversation goes on only when the person answers (then 24 hours). Meta refuses a second one in its own words (10900).',
      ...(target.canReplyPrivately === false ? ['Meta says the reading token cannot reply privately to this comment (can_reply_privately false); the Page\'s own token decides when it is sent, and Meta\'s refusal is passed on.'] : []),
      ...(target.platform === 'instagram' ? ['Instagram private replies need instagram_manage_comments and pages_messaging, Meta\'s Human Agent feature and Advanced Access; it lands in the person\'s Inbox if they follow the account, else in Requests.'] : []),
      GERMAN_RULE, ACCESS_NOTE,
    ],
    requests: [request({
      label: `Private reply to ${what}`, objectId: target.pageId, objectKind: pageKind(target.platform), edge: 'messages',
      operation: sendOperation(target.platform), params, undoable: false, explain: MESSAGE_EXPLAIN, doneSentence: sentSentence(`The private reply to ${what}`),
    })],
    stands: { action: 'private-reply', platform: target.platform, commentId: target.commentId, postId: target.postId, createdAt: target.createdAt },
    before, after: { ...before, sent: true },
  })
}

const SENDER_ACTION_OF: Readonly<Record<SenderAction, string>> = { seen: 'mark_seen', 'typing-on': 'typing_on', 'typing-off': 'typing_off', react: 'react', unreact: 'unreact' }

/** EN-039 — "seen", typing or a reaction in a person's conversation (inside the standard window). */
export function senderActionDraft(person: PersonState, action: SenderAction, input: { messageId?: string | null; reaction?: string | null }, now: number): MetaChangeDraft | { refusal: string } {
  const w = windowNow(person, now)
  if (!w.open) return { refusal: 'Nexus shows "seen", typing or a reaction only while the person\'s standard 24-hour window is open (it tells the person the business is answering now).' }
  const reacts = action === 'react' || action === 'unreact'
  if (reacts && !input.messageId) return { refusal: `${action} names the message (messageId: one of the conversation's 20 newest, meta-conversations view messages).` }
  if (!reacts && (input.messageId || input.reaction)) return { refusal: 'messageId and reaction are for react and unreact only.' }
  if (input.messageId && !person.messageIds.includes(input.messageId)) return { refusal: 'That message is not one of the conversation\'s 20 newest (Meta answers no older one).' }
  if (action === 'unreact' && input.reaction) return { refusal: 'unreact takes no reaction.' }
  if (action === 'react') {
    if (!input.reaction) return { refusal: person.platform === 'instagram' ? 'Name the reaction (Instagram takes "love").' : 'Name the reaction (one emoji).' }
    if (person.platform === 'instagram' && input.reaction !== 'love') return { refusal: 'Instagram takes the reaction "love" only.' }
    if (person.platform === 'messenger' && !/^\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}‍\p{Extended_Pictographic}]{0,15}$/u.test(input.reaction)) return { refusal: 'The reaction is one emoji.' }
  }
  const params: Record<string, string> = {
    recipient: json({ id: person.personId }), sender_action: SENDER_ACTION_OF[action],
    ...(reacts ? { payload: json({ message_id: input.messageId, ...(action === 'react' ? { reaction: input.reaction } : {}) }) } : {}),
  }
  const shown = action === 'seen' ? '"seen"' : action === 'typing-on' ? 'typing…' : action === 'typing-off' ? 'typing stops' : action === 'react' ? `reaction ${input.reaction} on message ${input.messageId}` : `reaction removed from message ${input.messageId}`
  const before = recordOf('sender-action', person.platform, person.pageId, { kind: action, conversationId: person.conversationId })
  return draftOf({
    summary: `Show ${shown} to the person in conversation ${person.conversationId} in ${platformName(person.platform)}, as ${businessName(person.platform)}.`,
    lines: [['To', null, `${platformName(person.platform)} person ${person.personId} (conversation ${person.conversationId})`], ['Shows', null, shown]],
    warnings: [MESSAGE_NO_CHECK, 'The person sees it at once (Meta shows it only while they are signed in); typing stops by itself after 20 seconds or the next message.', ACCESS_NOTE],
    requests: [request({
      label: `Show ${shown} to the person in conversation ${person.conversationId}`, objectId: person.pageId, objectKind: pageKind(person.platform), edge: 'messages',
      operation: sendOperation(person.platform), params, undoable: false, explain: MESSAGE_EXPLAIN, doneSentence: confirmedSentence(`${shown} for the person in conversation ${person.conversationId}`),
    })],
    stands: { action: 'sender-action', conversationId: person.conversationId, windowOpen: w.open, messageKnown: input.messageId ? person.messageIds.includes(input.messageId) : null },
    before, after: { ...before, sent: true },
  })
}

/** Meta's in-thread eligible question types (instant-form-template.md). */
export const INSTANT_FORM_TYPES: ReadonlySet<string> = new Set(['CUSTOM', 'EMAIL', 'FIRST_NAME', 'FULL_NAME', 'LAST_NAME', 'PHONE'])

/** LD-049 — an instant form of the chosen Page inside a Messenger conversation (inside the standard window). */
export function instantFormDraft(person: PersonState, form: { formId: string; questionTypes: string[] }, mode: MessageMode, now: number): MetaChangeDraft | { refusal: string } {
  if (person.platform !== 'messenger') return { refusal: 'Meta sends an instant form inside a Messenger conversation only.' }
  if (mode !== 'response' && mode !== 'update') return { refusal: 'An instant form goes inside the standard window only (mode response or update).' }
  const bad = form.questionTypes.filter((t) => !INSTANT_FORM_TYPES.has(t))
  if (bad.length) return { refusal: `Lead form ${form.formId} asks ${[...new Set(bad)].join(', ')}: Meta sends a form inside a conversation only when every question is CUSTOM, EMAIL, FIRST_NAME, FULL_NAME, LAST_NAME or PHONE (and Open Sharing is on).` }
  const windowProblem = windowRefusal(person, now, mode)
  if (windowProblem) return { refusal: windowProblem }
  const w = windowNow(person, now)
  const params: Record<string, string> = {
    recipient: json({ id: person.personId }), messaging_type: mode === 'update' ? 'UPDATE' : 'RESPONSE',
    message: json({ attachment: { type: 'template', payload: { template_type: 'instant_form', form_id: form.formId } } }),
  }
  const before = recordOf('instant-form', 'messenger', person.pageId, { conversationId: person.conversationId })
  return draftOf({
    summary: `Send lead form ${form.formId} of the chosen Page inside the Messenger conversation ${person.conversationId} — it reaches them at once and cannot be recalled.`,
    lines: [['To', null, `Messenger person ${person.personId} (conversation ${person.conversationId})`], ['Message', null, `lead form ${form.formId} (${form.questionTypes.length} question${form.questionTypes.length === 1 ? '' : 's'}: ${form.questionTypes.join(', ')})`], ['Sent as', null, `${mode === 'update' ? 'UPDATE' : 'RESPONSE'} inside the standard window (open until ${iso(w.endsAt!)})`]],
    warnings: [MESSAGE_FINAL, MESSAGE_NO_CHECK, 'Meta says instant forms in conversations are in development and may change or go away; the form must have Open Sharing on (block_display_for_non_targeted_viewer false), else Meta refuses it (2018382).', 'The person\'s answers are leads: Meta keeps them in its Leads Center until real lead retrieval is approved (App Review).', ACCESS_NOTE],
    requests: [request({
      label: `Send lead form ${form.formId} to the person in conversation ${person.conversationId}`, objectId: person.pageId, objectKind: 'messengerpage', edge: 'messages',
      operation: 'messenger.message', params, undoable: false, explain: MESSAGE_EXPLAIN, doneSentence: sentSentence(`The lead form ${form.formId} to the person in conversation ${person.conversationId}`),
    })],
    stands: { action: 'instant-form', conversationId: person.conversationId, windowOpen: w.open, lastMessageFromPerson: person.lastMessageFromPerson, questionTypes: form.questionTypes },
    before, after: { ...before, sent: true },
  })
}

/** OT-008 — a message to a creator through Instagram's Partnership folder (Creator Marketplace). */
export function creatorMessageDraft(creator: { username: string; messagingId: string }, pageId: string, instagramId: string, words: MessageWords): MetaChangeDraft | { refusal: string } {
  if (words.quickReplies?.length) return { refusal: 'A creator message is text or one media file (no quick replies).' }
  const wordsRefusal = wordsProblem({ ...words, ...(words.mediaType === 'file' ? { mediaType: 'image' as const } : {}) }, 'instagram', false)
  if (wordsRefusal) return { refusal: wordsRefusal }
  const params: Record<string, string> = { recipient: json({ id: creator.messagingId }), message: json(messageOf(words, false)), folder: 'partnership' }
  const before = recordOf('creator-message', 'instagram', pageId, { instagramId })
  return draftOf({
    summary: `Send a partnership message from the chosen Instagram account to the creator @${creator.username} (Instagram's Partnership folder) — it reaches them at once and cannot be recalled.`,
    lines: [['To', null, `creator @${creator.username} (Meta's messaging id ${creator.messagingId})`], ['Message', null, wordsLine(words)], ['Sent as', null, 'a Creator Marketplace partnership message (folder partnership)']],
    warnings: [
      MESSAGE_FINAL, MESSAGE_NO_CHECK,
      'Before the creator replies Meta allows 2 messages per 30 days to them and 250 new creators a day; Meta refuses more in its own words.',
      'It needs instagram_creator_marketplace_messaging (App Review), the brand onboarded to Instagram\'s creator marketplace and a creator who accepts messages from everyone; Nexus has no way around it.',
    ],
    requests: [request({
      label: `Send the partnership message to @${creator.username}`, objectId: pageId, objectKind: 'instagrampage', edge: 'messages', parent: { kind: 'creator', id: creator.username },
      operation: 'instagram.message', params, undoable: false, explain: MESSAGE_EXPLAIN, doneSentence: sentSentence(`The partnership message to @${creator.username}`),
    })],
    stands: { action: 'creator-message', username: creator.username, messagingId: creator.messagingId },
    before, after: { ...before, sent: true },
  })
}

/** A thread-control request, each with its own literal edge (no request builder computes an edge). */
function threadRequest(control: HandoverControl, r: Omit<MetaChangeRequest, 'step' | 'check' | 'raisesSpend' | 'readBackInPost' | 'budget' | 'edge'>): MetaChangeRequest {
  if (control === 'pass') return request({ ...r, edge: 'pass_thread_control' })
  if (control === 'release') return request({ ...r, edge: 'release_thread_control' })
  return request({ ...r, edge: 'take_thread_control' })
}

/** EN-046 / EN-910 — who answers the person: pass the conversation on, release it, or take it. */
export function handoverDraft(person: PersonState, control: HandoverControl, target: { kind: HandoverTarget; appId?: string | null; appName?: string | null }, metadata: string | null): MetaChangeDraft | { refusal: string } {
  if (control !== 'pass' && target.kind !== 'default') return { refusal: `handoverTo is for a pass only (${control} names no app).` }
  if (control === 'pass' && target.kind === 'instagram-inbox' && person.platform !== 'instagram') return { refusal: 'The Instagram Inbox takes Instagram Direct conversations only.' }
  if (control === 'pass' && target.kind === 'page-inbox' && person.platform !== 'messenger') return { refusal: 'The Page Inbox takes Messenger conversations; an Instagram conversation goes to the Instagram Inbox.' }
  if (metadata !== null && (!metadata.trim() || !META_NAME_TEXT.test(metadata) || [...metadata].length > META_MESSAGE_LIMITS.metadata)) return { refusal: `metadata is printable text of at most ${META_MESSAGE_LIMITS.metadata} characters (the next app reads it; never a person's data).` }
  const appId = control !== 'pass' ? null : target.kind === 'page-inbox' ? META_PAGE_INBOX_APP : target.kind === 'instagram-inbox' ? META_INSTAGRAM_INBOX_APP : target.kind === 'app' ? target.appId ?? null : null
  if (target.kind === 'app' && !appId) return { refusal: 'Name the app (appId: an app installed on the chosen Page).' }
  const to = target.kind === 'page-inbox' ? 'the Page Inbox (Meta Business Suite)' : target.kind === 'instagram-inbox' ? 'the Instagram Inbox' : target.kind === 'app' ? `app ${target.appName ? `"${target.appName}" ` : ''}${appId}` : 'the Page\'s default app'
  const params: Record<string, string> = { recipient: json({ id: person.personId }), ...(appId ? { target_app_id: appId } : {}), ...(metadata ? { metadata } : {}) }
  const shown = control === 'pass' ? `pass the conversation to ${to}` : control === 'release' ? 'release the conversation (it goes idle; the default app answers next)' : 'take the conversation for the business\'s Meta app'
  const before = recordOf('handover', person.platform, person.pageId, { kind: control, conversationId: person.conversationId })
  return draftOf({
    summary: `${shown.charAt(0).toUpperCase()}${shown.slice(1)} — the ${platformName(person.platform)} conversation ${person.conversationId}.`,
    lines: [['Conversation', null, `${platformName(person.platform)} person ${person.personId} (conversation ${person.conversationId})`], ['Who answers', null, shown]],
    warnings: [
      MESSAGE_NO_CHECK,
      'Conversation Routing (Meta\'s replacement of the Handover Protocol, backwards compatible) decides who answers; the person sees no message.',
      ...(control === 'take' ? ['Taking control needs the takeover setting for the business\'s app in the Page\'s settings (Advanced Messaging) — Meta\'s reference says it is "only available to select developers": Meta\'s refusal is passed on in its words.'] : []),
      ...(control === 'pass' && target.kind === 'default' ? ['Without a target Meta passes control to the Page\'s default app (Conversation Routing on).'] : []),
      'It has no undo of its own: a later handover changes it again (create-meta-message action handover, pass or take).',
    ],
    requests: [threadRequest(control, {
      label: `${control === 'pass' ? 'Pass' : control === 'release' ? 'Release' : 'Take'} the conversation ${person.conversationId}`, objectId: person.pageId, objectKind: pageKind(person.platform),
      operation: `thread.${control}`, params, undoable: false, explain: MESSAGE_EXPLAIN, doneSentence: confirmedSentence(`${control === 'pass' ? 'Passing' : control === 'release' ? 'Releasing' : 'Taking'} the conversation ${person.conversationId}`),
    })],
    stands: { action: 'handover', control, conversationId: person.conversationId, appId },
    before, after: { ...before, sent: true },
  })
}

/** The words of a refused dead tag (the tool's enum never offers one; this is the gateway's sentence too). */
export const deadTagRefusal = (tag: string): string | null => (META_DEAD_TAGS.has(tag) ? `Meta answers the ${tag} tag with error 100 since 2026-04-27: it is never sent.` : null)

// ── set-meta-conversation-labels ────────────────────────────────────────────────────────────────────────────────────

export const LABEL_ACTIONS = ['create', 'add', 'remove', 'delete'] as const
export type LabelAction = typeof LABEL_ACTIONS[number]

/** What a label change replaced and wrote. A person's id is kept for add / remove only (their undo needs it). */
export interface LabelRecord {
  action: LabelAction
  pageId: string
  labelId: string | null
  labelName: string | null
  personId?: string | null
  /** add / remove: whether the person carries the label (Meta reads one person's labels only with their id in the path, which Nexus's call log keeps: not read — as recorded). */
  assigned?: boolean | null
  exists?: boolean
}

export const LABEL_EXPLAIN: Readonly<Record<string, string>> = {
  100: 'Meta says a parameter is not valid (the label, or the person\'s id).',
  200: 'Meta refused it for permission: labels need the Page\'s own token of someone with the MESSAGING task (pages_messaging, pages_manage_metadata, pages_show_list), and a Page admin must have accepted Meta\'s Page Contact Terms.',
  80006: 'Meta allows only so many Messenger calls to this Page in a while: wait a few minutes and ask again.',
}
const LABEL_NO_CHECK = 'Meta has no check (validate_only) for a label change: the preview is built from the Page\'s labels as Meta answers them now.'
export const LABEL_DELETE_FINAL = 'A deleted label cannot come back: a new one gets a new id, and the people who carried it lose it.'

export function labelCreateDraft(pageId: string, labels: Array<{ labelId: string; name: string | null }>, name: string): MetaChangeDraft | { refusal: string } {
  const trimmed = name.trim()
  if (!trimmed || !META_NAME_TEXT.test(trimmed) || [...trimmed].length > META_MESSAGE_LIMITS.labelName) return { refusal: `A label name is 1–${META_MESSAGE_LIMITS.labelName} printable characters.` }
  const same = labels.find((l) => (l.name ?? '').toLowerCase() === trimmed.toLowerCase())
  const record: LabelRecord = { action: 'create', pageId, labelId: null, labelName: trimmed, exists: false }
  if (same) return { summary: `The chosen Page already has the label "${same.name}" (${same.labelId}).`, changes: {}, totals: { requests: 0 }, warnings: [], spendsMoney: [], skipped: [`The chosen Page already has the label "${same.name}" (${same.labelId}): use action add with labelId ${same.labelId}.`], requests: [], stands: { labels: labels.map((l) => l.labelId) }, before: record, after: record }
  return draftOf({
    summary: `Make the inbox label "${trimmed}" on the chosen Facebook Page.`,
    lines: [['Inbox label', 'none', `"${trimmed}"`]],
    warnings: [LABEL_NO_CHECK, 'Its undo deletes the label Nexus made (and takes it off everyone it was put on by then).'],
    requests: [request({ label: `Make the inbox label "${trimmed}"`, objectId: pageId, objectKind: 'messagingpage', edge: 'custom_labels', operation: 'pagelabel.create', params: { page_label_name: trimmed }, undoable: true, explain: LABEL_EXPLAIN, doneSentence: (r) => `Make the inbox label "${trimmed}": Meta made it${typeof r.node?.id === 'string' || typeof r.node?.id === 'number' ? ` (${r.node.id})` : ''}.` })],
    stands: { labels: labels.map((l) => l.labelId).sort() },
    before: record, after: { ...record, exists: true },
  })
}

export function labelPersonDraft(action: 'add' | 'remove', label: { labelId: string; name: string | null }, person: { personId: string; pageId: string; conversationId: string }): MetaChangeDraft {
  const add = action === 'add'
  const before: LabelRecord = { action, pageId: person.pageId, labelId: label.labelId, labelName: label.name, personId: person.personId, assigned: !add }
  const shown = `"${label.name ?? label.labelId}" (${label.labelId})`
  return draftOf({
    summary: `${add ? 'Put' : 'Take'} the inbox label ${shown} ${add ? 'on' : 'off'} the Messenger conversation ${person.conversationId}.`,
    lines: [[`Label ${shown} on person ${person.personId}`, add ? 'off (as far as Nexus knows)' : 'on (as far as Nexus knows)', add ? 'on' : 'off']],
    warnings: [
      LABEL_NO_CHECK, 'The person does not see it: labels sort the Page\'s inbox.',
      'Nexus does not read one person\'s labels (Meta reads them only with the person\'s id in the request path, which Nexus\'s call log keeps): Meta answers success either way.',
      `Its undo ${add ? 'takes it off' : 'puts it on'} again. The person's id is kept in this change's record for that undo.`,
    ],
    requests: [request({
      label: `${add ? 'Put' : 'Take'} label ${shown} ${add ? 'on' : 'off'} the person in conversation ${person.conversationId}`, objectId: label.labelId, objectKind: 'pagelabel', edge: 'label',
      ...(add ? {} : { method: 'DELETE' as const }), operation: add ? 'pagelabel.assign' : 'pagelabel.unassign', params: { user: person.personId }, undoable: true, explain: LABEL_EXPLAIN,
      doneSentence: confirmedSentence(`${add ? 'Put' : 'Take'} label ${shown} ${add ? 'on' : 'off'} the person in conversation ${person.conversationId}`),
    })],
    stands: { labelId: label.labelId, conversationId: person.conversationId },
    before, after: { ...before, assigned: add },
  })
}

export function labelDeleteDraft(pageId: string, label: { labelId: string; name: string | null }): MetaChangeDraft {
  const before: LabelRecord = { action: 'delete', pageId, labelId: label.labelId, labelName: label.name, exists: true }
  return draftOf({
    summary: `Delete the inbox label "${label.name ?? label.labelId}" (${label.labelId}) of the chosen Facebook Page — for good.`,
    lines: [[`Inbox label "${label.name ?? label.labelId}"`, 'exists', 'deleted']],
    warnings: [LABEL_NO_CHECK, LABEL_DELETE_FINAL],
    requests: [request({ label: `Delete the inbox label ${label.labelId}`, objectId: label.labelId, objectKind: 'pagelabel', method: 'DELETE' as const, operation: 'pagelabel.delete', params: {}, undoable: false, explain: LABEL_EXPLAIN })],
    stands: { labelId: label.labelId },
    before, after: { ...before, exists: false },
  })
}
