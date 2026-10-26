/**
 * Meta step 38 (2026-10-26) — the live state a messaging change is built on, read through the gateway (GET only), each from
 * step 15's own checks and reads (live-messaging.ts: ownPerson, ownConversation, instagramOnPage, ownWhatsApp, windowOf and
 * the raw reads) and step 37's comment checks (live-comments.ts) — never a second copy of them.
 *
 * PEOPLE'S DATA. A message goes to a person who wrote to the business first: the person is named by their scoped id (PSID /
 * IGSID, from meta-conversations) and checked to have a conversation with the chosen Page or Instagram account. What a
 * change stands on is only times and ids (the person's last message time, the window's end, message ids for a reaction or a
 * reply-to): never a person's words or name. Nothing here stores anything.
 */
import prisma from '../../../db.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { fieldRefused, listPaged } from './live-objects.js'
import { pageOf } from './live-media.js'
import { takenIds } from './taken.js'
import {
  instagramOnPage, liveConversations, ownPerson, ownWhatsApp, readCallSettings, readMessengerProfile, readMessengerTemplates, readPageLabels,
  readPersonMenu, readPersonas, readTemplateGroup, readWelcomeFlows, readWhatsAppTemplates, type MessagingPlatform, type OwnWhatsApp,
} from './live-messaging.js'
import { liveFacebookComment, liveInstagramComment } from './live-comments.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : []).map(obj).filter((r): r is Row => !!r)
const timeOf = (v: unknown): number | null => { const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v * 1000 : NaN; return Number.isFinite(t) ? t : null }

/** The business's chosen Meta account (Page, Instagram account, ad account, portfolio) for a messaging change. */
export async function messagingAccount(connectionId: string): Promise<MetaChosenAccount> {
  return metaChosenAccount(connectionId)
}

// ── a person and their conversation ──────────────────────────────────────────────────────────────────────────────

/** A person's conversation as a message to them stands on: ids and times only. */
export interface PersonState {
  personId: string
  platform: MessagingPlatform
  pageId: string
  instagramId: string | null
  conversationId: string
  /** The person's newest message among the 20 newest Meta answers (ISO), or null when none of them is theirs. */
  lastMessageFromPerson: string | null
  /** The end of Meta's standard 24-hour window after it (ISO), or null. */
  standardWindowEndsAt: string | null
  /** The ids of the conversation's 20 newest messages (a reaction or a reply-to must name one of them). */
  messageIds: string[]
}

/**
 * THE check before anything is sent to a person (step 15's own): Meta answers a conversation of the chosen Page (or the chosen
 * Instagram account, through the Page it is linked to) with that person among its participants; then its 20 newest messages
 * give the person's last message time (step 15's windowOf) and the message ids. A person who is a Page or Instagram account
 * another business in Nexus uses is never a target.
 */
export async function livePerson(account: MetaChosenAccount, personIdArg: string, platform: MessagingPlatform): Promise<PersonState> {
  const { personId, conversationId } = await ownPerson(account, personIdArg, platform)
  const read = await liveConversations({ connectionId: account.connectionId, view: 'messages', conversationId })
  const people = (read as { personIds?: Array<{ id: string; takenByAnotherBusiness: boolean }> }).personIds ?? []
  if (people.some((p) => p.id === personId && p.takenByAnotherBusiness)) throw new MetaLiveRefusal('That person is a Page or Instagram account another business in Nexus uses: Nexus never messages it.')
  if ((await takenIds('PAGE', [personId])).has(personId) || (await takenIds('INSTAGRAM', [personId])).has(personId)) throw new MetaLiveRefusal('That person is a Page or Instagram account another business in Nexus uses: Nexus never messages it.')
  const window = (read as { window?: { lastMessageFromPerson: string | null; standardWindowEndsAt: string | null } }).window
  const items = (read as { items?: Array<{ messageId: string | null }> }).items ?? []
  return {
    personId, platform, pageId: pageOf(account), instagramId: account.instagramId, conversationId,
    lastMessageFromPerson: window?.lastMessageFromPerson ?? null, standardWindowEndsAt: window?.standardWindowEndsAt ?? null,
    messageIds: items.map((m) => m.messageId).filter((m): m is string => !!m),
  }
}

/** A person with a Messenger conversation of the chosen Page (a label, a menu): the check only, no messages read. */
export async function liveMessengerPerson(account: MetaChosenAccount, personIdArg: string): Promise<{ personId: string; pageId: string; conversationId: string }> {
  const { personId, conversationId } = await ownPerson(account, personIdArg, 'messenger')
  if ((await takenIds('PAGE', [personId])).has(personId) || (await takenIds('INSTAGRAM', [personId])).has(personId)) throw new MetaLiveRefusal('That person is a Page or Instagram account another business in Nexus uses: Nexus never changes anything for it.')
  return { personId, pageId: pageOf(account), conversationId }
}

// ── private replies ──────────────────────────────────────────────────────────────────────────────────────────────

/** What a private reply stands on: the comment (or visitor post), who wrote it (never the Page itself) and when. */
export interface PrivateReplyTarget {
  platform: MessagingPlatform
  pageId: string
  instagramId: string | null
  /** The comment, or the visitor post (Facebook) the reply answers. */
  commentId: string | null
  postId: string | null
  createdAt: string | null
  /** Meta's can_reply_privately for the reading token (a hint only: the Page's own token decides). */
  canReplyPrivately: boolean | null
}

async function createdOf(account: MetaChosenAccount, id: string, field: 'created_time' | 'timestamp', withCanReply: boolean): Promise<{ createdAt: string | null; canReplyPrivately: boolean | null }> {
  const read = (fields: string) => metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'messaging.privateReplyTarget', path: id, query: { fields } })
  let body: Row
  try {
    body = (await read(`id,${field}${withCanReply ? ',can_reply_privately' : ''}`)).body
  } catch (err) {
    if (!withCanReply || !fieldRefused(err)) throw err
    body = (await read(`id,${field}`)).body
  }
  if (idText(body.id) !== id) throw new MetaLiveRefusal('Meta answered with another object than the one asked; nothing is sent.')
  const t = timeOf(body[field])
  return { createdAt: t === null ? null : new Date(t).toISOString(), canReplyPrivately: typeof body.can_reply_privately === 'boolean' ? body.can_reply_privately : null }
}

/**
 * The comment (Facebook: on a post of the chosen Page — step 37's own check; Instagram: on the chosen account's media) or a
 * visitor's post on the chosen Page a private reply answers, never one the business wrote itself, with its time (Meta allows
 * ONE private reply within 7 days of it).
 */
export async function livePrivateReplyTarget(account: MetaChosenAccount, input: { platform: MessagingPlatform; commentId?: string | null; postId?: string | null; adId?: string | null }): Promise<PrivateReplyTarget> {
  const pageId = pageOf(account)
  try {
    if (input.platform === 'instagram') {
      if (!input.commentId) throw new MetaLiveRefusal('Name the Instagram comment (commentId, from meta-comments view instagram).')
      const comment = await liveInstagramComment(account.connectionId, input.commentId)
      if (comment.byTheAccount === true) throw new MetaLiveRefusal('That comment was written by the chosen Instagram account itself: a private reply goes to the person who commented.')
      await instagramOnPage(account)
      const when = await createdOf(account, comment.commentId, 'timestamp', false)
      return { platform: 'instagram', pageId, instagramId: comment.instagramId, commentId: comment.commentId, postId: null, ...when }
    }
    if (input.commentId) {
      const comment = await liveFacebookComment(account.connectionId, { postId: input.postId ?? null, adId: input.adId ?? null, commentId: input.commentId })
      if (comment.byThePage === true) throw new MetaLiveRefusal('That comment was written by the chosen Page itself: a private reply goes to the person who commented.')
      const when = await createdOf(account, comment.commentId, 'created_time', true)
      return { platform: 'messenger', pageId, instagramId: null, commentId: comment.commentId, postId: comment.postId, ...when }
    }
    const postId = input.postId?.trim() ?? ''
    if (!new RegExp(`^${pageId}_\\d{1,25}$`).test(postId)) throw new MetaLiveRefusal('Name the comment (commentId, with its post: postId or adId), or a visitor\'s post on the chosen Page (postId: <Page id>_<post id>).')
    const post = (await metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'messaging.visitorPost', path: postId, query: { fields: 'id,from{id},created_time' } })).body
    if (idText(post.id) !== postId) throw new MetaLiveRefusal('Meta answered with another post than the one asked; nothing is sent.')
    if (idText(obj(post.from)?.id) === pageId) throw new MetaLiveRefusal('That post was written by the chosen Page itself: a private reply goes to a person\'s visitor post or comment.')
    const t = timeOf(post.created_time)
    return { platform: 'messenger', pageId, instagramId: null, commentId: null, postId, createdAt: t === null ? null : new Date(t).toISOString(), canReplyPrivately: null }
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled && !err.failure.authLost) throw new MetaLiveRefusal(`Meta did not answer the comment or post this private reply answers: ${err.failure.sentence}`)
    throw err
  }
}

// ── templates ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A utility template of the chosen Page as Meta answers it (Meta's own object, for a preview, a send and an undo). */
export interface PageTemplate { templateId: string; name: string; language: string | null; status: string | null; category: string | null; parameterFormat: string | null; components: unknown }

const pageTemplateOf = (r: Row): PageTemplate | null => {
  const templateId = idText(r.id)
  const name = text(r.name)
  return templateId && name ? { templateId, name, language: text(r.language), status: text(r.status), category: text(r.category), parameterFormat: text(r.parameter_format), components: r.components ?? null } : null
}

/** The chosen Page's utility templates (its first 500), optionally by name. */
export async function livePageTemplates(account: MetaChosenAccount, name?: string | null): Promise<PageTemplate[]> {
  const read = await readMessengerTemplates(account, name ? { name } : {}, 500)
  return read.rows.map(pageTemplateOf).filter((t): t is PageTemplate => !!t)
}

/** One utility template of the chosen Page by its id (refused when it is not one of the Page's first 500). */
export async function livePageTemplate(account: MetaChosenAccount, templateId: string): Promise<PageTemplate> {
  const found = (await livePageTemplates(account)).find((t) => t.templateId === templateId)
  if (!found) throw new MetaLiveRefusal('That template is not one of the chosen Page\'s utility templates (among the first 500 Meta lists), so nothing is changed.')
  return found
}

/** A WhatsApp template of the business's own WhatsApp account (Meta's own object). */
export interface WhatsAppTemplate { templateId: string; name: string; language: string | null; status: string | null; category: string | null }

/** The business's own WhatsApp account (step 15's ownWhatsApp: the chosen ad account's portfolio, never a shared one). */
export async function liveWhatsAppAccount(account: MetaChosenAccount, wabaId?: string | null): Promise<OwnWhatsApp> {
  const pick = await ownWhatsApp(account, wabaId ?? null)
  if ('taken' in pick) throw new MetaLiveRefusal(pick.taken.sentence)
  return pick.waba
}

/** The WhatsApp account's templates (its first 500). */
export async function liveWhatsAppTemplates(account: MetaChosenAccount, waba: OwnWhatsApp): Promise<WhatsAppTemplate[]> {
  const read = await readWhatsAppTemplates(account, waba, {}, 500)
  return read.rows.map((r) => ({ templateId: idText(r.id) ?? '', name: text(r.name) ?? '', language: text(r.language), status: text(r.status), category: text(r.category) })).filter((t) => /^\d{1,25}$/.test(t.templateId) && t.name)
}

/** A template group of the WhatsApp account (step 15's readTemplateGroup: its owner checked first). */
export interface TemplateGroupState { groupId: string; name: string | null; description: string | null; templateIds: string[] }
export async function liveTemplateGroup(account: MetaChosenAccount, waba: OwnWhatsApp, groupId: string): Promise<TemplateGroupState> {
  const body = await readTemplateGroup(account, waba, groupId)
  return { groupId: idText(body.id) ?? groupId, name: text(body.name), description: text(body.description), templateIds: rowsOf(body.whatsapp_business_templates).map((t) => idText(t.id)).filter((x): x is string => !!x) }
}

// ── the messaging setup ──────────────────────────────────────────────────────────────────────────────────────────

/** The chosen Page's inbox labels ({ id, name }), its first 500. */
export async function livePageLabels(account: MetaChosenAccount): Promise<{ pageId: string; labels: Array<{ labelId: string; name: string | null }>; more: boolean }> {
  const read = await readPageLabels(account, 500)
  return { pageId: read.pageId, labels: read.rows.map((r) => ({ labelId: idText(r.id) ?? '', name: text(r.page_label_name) })).filter((l) => l.labelId), more: read.more }
}

/** The chosen Page's personas, its first 500. */
export async function livePersonas(account: MetaChosenAccount): Promise<{ pageId: string; personas: Array<{ personaId: string; name: string | null; pictureUrl: string | null }> }> {
  const read = await readPersonas(account, 500)
  return { pageId: read.pageId, personas: read.rows.map((p) => ({ personaId: idText(p.id) ?? '', name: text(p.name), pictureUrl: text(p.profile_picture_url) })).filter((p) => p.personaId) }
}

export { readCallSettings, readMessengerProfile, readPersonMenu, readWelcomeFlows }

/**
 * EN-917 — Meta has no read of the Built-In NLP setting ("Reading: can't perform"): the last value Nexus set for this Page
 * (set-meta-messaging-setup's own change records, row-level security: this business's only), or null when Nexus never set it.
 */
export async function lastNlpSetByNexus(pageId: string): Promise<{ nlpEnabled: boolean; model: string | null } | null> {
  const row = await prisma.agentChange.findFirst({
    where: { toolName: 'set-meta-messaging-setup', undoneAt: null, AND: [{ after: { path: ['section'], equals: 'nlp' } }, { after: { path: ['pageId'], equals: pageId } }] },
    orderBy: { executedAt: 'desc' },
    select: { after: true },
  })
  const after = obj(row?.after)
  return after && typeof after.nlpEnabled === 'boolean' ? { nlpEnabled: after.nlpEnabled, model: typeof after.model === 'string' ? after.model : null } : null
}

// ── a creator, an app on the Page, a lead form, the Page's WhatsApp number ─────────────────────────────────────────

/** OT-008 — the creator's messaging id Meta's creator marketplace answers for their username, never another Nexus business's. */
export async function liveCreator(account: MetaChosenAccount, usernameArg: string): Promise<{ username: string; messagingId: string; creatorId: string | null }> {
  const username = usernameArg.trim().replace(/^@/, '')
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new MetaLiveRefusal('An Instagram username is 1–30 letters, digits, dots and underscores.')
  if (!account.instagramId) throw new MetaLiveRefusal('No Instagram account is chosen for this business, and creators are messaged from it.')
  await instagramOnPage(account)
  let rows: Row[]
  try {
    rows = rowsOf((await metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'messaging.creatorId', path: `${account.instagramId}/creator_marketplace_creators`, query: { username, fields: 'id,page_id,messaging_id' } })).body)
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled && !err.failure.authLost) throw new MetaLiveRefusal(`Meta's creator marketplace did not answer for @${username}: ${err.failure.sentence} It needs instagram_creator_marketplace_discovery with Advanced access, and the brand onboarded to Instagram's creator marketplace.`)
    throw err
  }
  const row = rows.find((r) => idText(r.messaging_id))
  if (!row) throw new MetaLiveRefusal(`Meta's creator marketplace gives no messaging id for @${username}: the creator is not onboarded, has more than 250,000 followers or opted out of partnership messages.`)
  const creatorId = idText(row.id)
  const page = idText(row.page_id)
  if ((creatorId && (await takenIds('INSTAGRAM', [creatorId])).has(creatorId)) || (page && (await takenIds('PAGE', [page])).has(page))) throw new MetaLiveRefusal('That creator is an Instagram account or Page another business in Nexus uses: Nexus never messages it.')
  return { username, messagingId: idText(row.messaging_id)!, creatorId }
}

/** The apps installed on the chosen Page (a conversation may be passed to one of them), with the Page's own token. */
export async function livePageApps(account: MetaChosenAccount): Promise<Array<{ appId: string; name: string | null }>> {
  const pageId = pageOf(account)
  const read = await listPaged(account.connectionId, 'messaging.pageApps', `${pageId}/subscribed_apps`, { fields: 'id,name' }, 100)
  return read.rows.map((r) => ({ appId: idText(r.id) ?? '', name: text(r.name) })).filter((a) => a.appId)
}

/** LD-049 — a lead form of the chosen Page and its question types (only CUSTOM, EMAIL, names and PHONE are in-thread eligible). */
export async function liveLeadForm(account: MetaChosenAccount, formId: string): Promise<{ formId: string; questionTypes: string[] }> {
  const pageId = pageOf(account)
  const body = (await metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'messaging.instantForm', path: formId, query: { fields: 'id,page_id,questions{type}' } })).body
  if (idText(body.id) !== formId) throw new MetaLiveRefusal('Meta answered with another object than the lead form asked; nothing is sent.')
  if (idText(body.page_id) !== pageId) throw new MetaLiveRefusal('That lead form is not a form of the Facebook Page this business chose, so it is not sent.')
  return { formId, questionTypes: rowsOf(body.questions).map((q) => text(q.type)).filter((t): t is string => !!t) }
}

/** CR-216 — the chosen Page's WhatsApp number as Meta answers it now (the system-user token: the Page's own fields). */
export async function livePageWhatsAppNumber(account: MetaChosenAccount): Promise<{ pageId: string; number: string | null; hasNumber: boolean | null }> {
  const pageId = pageOf(account)
  const body = (await metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'setup.whatsappNumber', path: pageId, query: { fields: 'id,has_whatsapp_number,whatsapp_number' } })).body
  if (idText(body.id) !== pageId) throw new MetaLiveRefusal('Meta answered for another Page than the chosen one; nothing is changed.')
  return { pageId, number: text(body.whatsapp_number), hasNumber: typeof body.has_whatsapp_number === 'boolean' ? body.has_whatsapp_number : null }
}
