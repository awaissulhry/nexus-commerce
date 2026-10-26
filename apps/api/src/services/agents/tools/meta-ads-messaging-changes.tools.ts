/**
 * Meta ads changes, step 38 (2026-10-26) — messages, inbox labels, templates and the messaging setup (32 master rows):
 *   create-meta-message           one message, private reply, sender action, instant form, creator message or handover in a
 *                                 conversation of the business's CHOSEN Facebook Page (Messenger) or CHOSEN Instagram account
 *                                 (Instagram Direct, through the Page): EN-012, EN-026, EN-036, EN-037, EN-039, EN-040, EN-044,
 *                                 EN-046, EN-910, LD-049, OT-008
 *   set-meta-conversation-labels  the chosen Page's inbox labels: make, put on, take off, delete — EN-912 … EN-915
 *   set-meta-message-templates    Messenger utility templates of the chosen Page and WhatsApp templates and template groups of
 *                                 the business's own WhatsApp account — EN-923 … EN-925, EN-931, EN-932, EN-940
 *   set-meta-messaging-setup      Messenger / Instagram profile, a person's own menu, personas, Built-In NLP, calling, welcome
 *                                 flows, the Page's WhatsApp number — EN-901, EN-902, EN-904, EN-905, EN-907, EN-908, EN-917,
 *                                 EN-921, EN-045, CR-216; CR-272 answers that Meta cannot (read-only fields)
 * A Nexus change like every other Meta change (meta-ads-kit.ts): a preview from the live state (Meta has no check for any of
 * these: said), an approvalId, a person approves it, it runs as that person.
 *
 * create-meta-message is gated exactly as send-customer-message (mutate.tools.ts) — never weaker: alwaysAsk, Claude's ceiling
 * ask, high risk, reversibility none, the buyer-message permission (orders.edit) — with ads.campaigns.manage and
 * customers.view on top —, never in a bulk approve (bulk-approve-policy.ts NEVER_IN_BULK), its exact words and recipient in
 * the preview the approval holds (the plan hash covers both: approval-inbox MATERIAL_PREVIEW_FIELDS). A message cannot be
 * recalled.
 *
 * Page requests go AS the chosen Page: the gateway reads its own token for that one call (gateway/meta-page-token.ts) and
 * sends it only for the Page, a label, persona or template of it, with every id inside the body confirmed
 * (gateway/meta-messaging-owner.ts). WhatsApp requests go with the system-user token, only to a WhatsApp account the chosen ad
 * account's own portfolio owns. The tools never see a token.
 *
 * PEOPLE'S DATA: what is stored and why — the approval request holds the person's scoped id and the business's exact words
 * (a person approves exactly what goes, and the run sends exactly that); the change record of a message holds its kind, the
 * Page, the conversation and Meta's message id (never the words or the person's id); a label's or a person's menu record holds
 * the person's id it was for (its undo needs it). Nexus's call log keeps neither words nor ids of people (gateway `ledger`).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder, type MetaRunOutcome } from './meta-ads-kit.js'
import { META_LABELS_TOOL, META_MESSAGE_TOOL, META_SETUP_TOOL, META_TEMPLATES_TOOL } from '../../gateway/account.js'
import { META_MESSAGE_ID, META_MESSAGE_LIMITS, META_NLP_MODELS, META_PAGE_TEMPLATE_NAME, META_TEMPLATE_LANGUAGE, META_TEMPLATE_NAME, META_WEEK_DAYS } from '../../gateway/meta-messaging-rules.js'
import { metaLeadUrlProblem } from '../../gateway/meta-lead-form-rules.js'
import {
  conversationMessageDraft, creatorMessageDraft, handoverDraft, instantFormDraft, labelCreateDraft, labelDeleteDraft, labelPersonDraft, messageIdOf,
  privateReplyDraft, senderActionDraft, utilityMessageDraft,
  HANDOVER_CONTROLS, HANDOVER_TARGETS, LABEL_ACTIONS, LABEL_DELETE_FINAL, MEDIA_TYPES, MESSAGE_ACTIONS, MESSAGE_MODES, NOTIFICATIONS, SENDER_ACTIONS,
  type LabelRecord, type MessageRecord, type MessageWords,
} from '../../marketing/meta-ads/change-messaging.js'
import {
  AD_DEFAULTS_CANNOT, BUTTON_TYPES, PROFILE_KEYS, PROFILE_META_KEY, SETUP_SECTIONS, TEMPLATE_ACTIONS, TEMPLATE_CHANNELS,
  callingDraft, callingFromMeta, flowDraft, flowFromMeta, groupCreateDraft, groupDeleteDraft, groupUpdateDraft, menuFromMeta, nlpDraft, partsFromMeta, personMenuDraft,
  personaCreateDraft, personaDeleteDraft, profileDraft, profileValueFromMeta, templateCreateDraft, templateDeleteDraft, templateEditDraft, whatsappNumberDraft,
  type CallingInput, type FlowInput, type MenuInput, type ParameterFormat, type ProfileInput, type ProfileKey, type SetupRecord, type TemplateParts, type TemplateRecord,
} from '../../marketing/meta-ads/change-messaging-setup.js'
import {
  lastNlpSetByNexus, liveCreator, liveLeadForm, liveMessengerPerson, livePageApps, livePageLabels, livePageTemplate, livePageTemplates, livePageWhatsAppNumber,
  livePerson, livePersonas, livePrivateReplyTarget, liveTemplateGroup, liveWhatsAppAccount, liveWhatsAppTemplates, messagingAccount, readCallSettings,
  readMessengerProfile, readPersonMenu, readWelcomeFlows,
} from '../../marketing/meta-ads/live-messaging-change.js'
import { pageOf } from '../../marketing/meta-ads/live-media.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeResult } from '../../marketing/meta-ads/write-client.js'

const L = META_MESSAGE_LIMITS
const httpsUrl = (what: string) => z.string().trim().max(L.url).refine((v) => metaLeadUrlProblem(v, 'it') === null, 'an https link (https://…, a host, no user or password)').describe(what)
const personArg = z.string().trim().regex(/^\d{1,25}$/, 'a scoped id is digits only').describe('the person: their Page-scoped id (Messenger) or Instagram-scoped id (Instagram Direct), as meta-conversations views messenger / instagram / messages give it — a person who wrote to the business first')
const platformArg = z.enum(['messenger', 'instagram']).describe('messenger (the chosen Facebook Page) or instagram (the chosen Instagram account\'s Direct, through the Page it is linked to)')
const messageIdArg = z.string().trim().regex(META_MESSAGE_ID, 'a Meta message id (m_…, mid.…, aWdf…)')
const confirmDeleteArg = z.literal(true).optional().describe('delete: true — the person asked to delete it (it cannot come back)')
const idOf = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)

/** A builder's refusal in words (MetaLiveRefusal: the chosen Page, a person's check, Meta's words). */
const refused = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}
const need = <T>(value: T | undefined | null, sentence: string): T => {
  if (value === undefined || value === null || value === '') throw new MetaLiveRefusal(sentence)
  return value
}
/** Arguments an action does not take are refused before any read. */
function extraArgs(a: Record<string, unknown>, allowed: readonly string[], what: string): string | null {
  const extra = Object.keys(a).filter((k) => a[k] !== undefined && !['connectionId', 'why', 'action', ...allowed].includes(k))
  return extra.length ? `${what} takes ${allowed.join(', ') || 'nothing more'} (not ${extra.join(', ')}).` : null
}

// ── create-meta-message ──────────────────────────────────────────────────────────────────────────────────────────

const messageInput = z.object({
  connectionId: metaConnectionArg,
  action: z.enum(MESSAGE_ACTIONS).describe(
    'message (a message in a person\'s conversation: mode response / update inside Meta\'s 24-hour window, human-agent within 7 days, utility = an approved Messenger utility template) · '
    + 'private-reply (ONE private message to the person who wrote a comment or a visitor post, within 7 days) · sender-action ("seen", typing, a reaction) · '
    + 'instant-form (a lead form of the chosen Page inside a Messenger conversation) · creator-message (a creator in Instagram\'s Partnership folder) · '
    + 'handover (pass, release or take the conversation: Conversation Routing)'),
  platform: platformArg,
  personId: personArg.optional(),
  mode: z.enum(MESSAGE_MODES).optional().describe('message: response (default: answers the person, inside the window) · update (unasked, inside the window) · human-agent (a person\'s own reply after the window, within 7 days of the person\'s last message, never promotional) · utility (an approved Messenger utility template: order, shipping, account updates; any time). instant-form: response or update'),
  text: z.string().min(1).max(L.messengerText).optional().describe(`the EXACT words, as the person approved them (sent as written, nothing added; at most ${L.messengerText} characters — Meta: fewer than 2,000; on Instagram at most ${L.instagramTextChars} characters and ${L.instagramTextBytes} bytes)`),
  mediaUrl: httpsUrl('instead of text: a media file Meta fetches from this https link (Nexus uploads nothing)').optional(),
  mediaType: z.enum(MEDIA_TYPES).optional().describe('with mediaUrl: image, video, audio or file (Instagram: no file, except in a creator message)'),
  quickReplies: z.array(z.object({
    title: z.string().min(1).max(L.quickReplyTitle).describe(`the button's words (at most ${L.quickReplyTitle})`),
    payload: z.string().min(1).max(L.payload).describe('what the business\'s app receives when it is tapped'),
  })).min(1).max(L.quickReplies).optional().describe(`message: tappable answers under it (at most ${L.quickReplies}, plain text)`),
  personaId: metaIdArg('message (Messenger): a persona of the chosen Page to send as (meta-messaging-setup view personas)').optional(),
  replyToMessageId: messageIdArg.optional().describe('message: answer this message of the conversation (one of its 20 newest, meta-conversations view messages)'),
  notification: z.enum(['regular', 'silent', 'none']).optional().describe('message (Messenger): the push the person gets — regular (default), silent, none'),
  template: z.object({
    name: z.string().regex(META_PAGE_TEMPLATE_NAME, 'a template name').describe('an APPROVED utility template of the chosen Page, named as Meta lists it (meta-message-templates view messenger)'),
    language: z.string().regex(META_TEMPLATE_LANGUAGE, 'a language code').describe('its language, as Meta lists it (it_IT, en_US, …)'),
    parameters: z.array(z.object({
      component: z.enum(['header', 'body']).describe('the part the placeholder is in'),
      name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional().describe('a NAMED template: the placeholder\'s name; positional: left out, in order'),
      text: z.string().min(1).max(L.bodyText).describe('the value that fills it (shown in the preview as the person reads it)'),
    })).max(L.templateParameters).optional().describe('the values of the template\'s placeholders'),
    buttons: z.array(z.object({
      type: z.enum(['postback', 'url']).describe('a postback button\'s payload, or a link button\'s value'),
      value: z.string().min(1).max(L.payload).describe('the value'),
    })).max(L.messengerButtons).optional().describe('values for the template\'s buttons that take one'),
  }).optional().describe('mode utility: the template and its values'),
  commentId: z.string().trim().regex(/^\d{1,25}(_\d{1,25})?$/, 'a Meta comment id').optional().describe('private-reply: the comment (Facebook <post id>_<comment id> with its post: postId or adId; Instagram digits — meta-comments shows each)'),
  postId: z.string().trim().regex(/^\d{1,25}_\d{1,25}$/, '<Page id>_<post id>').optional().describe('private-reply (Facebook): the comment\'s post, or alone: a person\'s visitor post on the chosen Page'),
  adId: metaIdArg('private-reply (Facebook): an ad of the chosen ad account whose post the comment is on').optional(),
  senderAction: z.enum(SENDER_ACTIONS).optional().describe('sender-action: seen, typing-on, typing-off, react, unreact'),
  messageId: messageIdArg.optional().describe('sender-action react / unreact: the message (one of the conversation\'s 20 newest)'),
  reaction: z.string().min(1).max(32).optional().describe('sender-action react: one emoji (Messenger) or love (Instagram)'),
  formId: metaIdArg('instant-form: a lead form of the chosen Page whose questions are all CUSTOM, EMAIL, FIRST_NAME, FULL_NAME, LAST_NAME or PHONE').optional(),
  creatorUsername: z.string().trim().regex(/^@?[A-Za-z0-9._]{1,30}$/, 'an Instagram username').optional().describe('creator-message: the creator\'s Instagram username (Meta\'s creator marketplace answers their messaging id)'),
  handover: z.enum(HANDOVER_CONTROLS).optional().describe('handover: pass (to handoverTo), release (the conversation goes idle; the default app answers next), take (for the business\'s Meta app)'),
  handoverTo: z.enum(HANDOVER_TARGETS).optional().describe('handover pass: page-inbox (Meta Business Suite), instagram-inbox, default (the Page\'s default app), app (appId)'),
  appId: metaIdArg('handover pass to app: an app installed on the chosen Page').optional(),
  metadata: z.string().min(1).max(L.metadata).optional().describe('handover: a note the next app reads (never a person\'s data)'),
  why: metaWhyArg,
})
type MessageArgs = z.infer<typeof messageInput>

const MESSAGE_ARGS: Readonly<Record<MessageArgs['action'], readonly string[]>> = {
  message: ['platform', 'personId', 'mode', 'text', 'mediaUrl', 'mediaType', 'quickReplies', 'personaId', 'replyToMessageId', 'notification', 'template'],
  'private-reply': ['platform', 'commentId', 'postId', 'adId', 'text'],
  'sender-action': ['platform', 'personId', 'senderAction', 'messageId', 'reaction'],
  'instant-form': ['platform', 'personId', 'formId', 'mode'],
  'creator-message': ['platform', 'creatorUsername', 'text', 'mediaUrl', 'mediaType'],
  handover: ['platform', 'personId', 'handover', 'handoverTo', 'appId', 'metadata'],
}

const wordsOf = (a: MessageArgs): MessageWords => ({ ...(a.text !== undefined ? { text: a.text } : {}), ...(a.mediaUrl ? { mediaUrl: a.mediaUrl, mediaType: a.mediaType } : a.mediaType ? { mediaType: a.mediaType } : {}), ...(a.quickReplies ? { quickReplies: a.quickReplies } : {}) })

function messageArgsRefusal(a: MessageArgs): string | null {
  const extra = extraArgs(a as Record<string, unknown>, MESSAGE_ARGS[a.action], `action ${a.action}`)
  if (extra) return extra
  if (a.action === 'message' && a.mode === 'utility' && (a.text !== undefined || a.mediaUrl || a.quickReplies || a.personaId || a.replyToMessageId || a.notification)) return 'mode utility sends a template: give template (its values), not text or media.'
  if (a.action === 'message' && a.mode !== 'utility' && a.template) return 'template is for mode utility.'
  if (a.action === 'creator-message' && a.platform !== 'instagram') return 'A creator message goes from the chosen Instagram account (platform instagram).'
  if (a.action === 'instant-form' && a.platform !== 'messenger') return 'An instant form goes inside a Messenger conversation (platform messenger).'
  if (a.action === 'handover' && !a.handover) return 'Name the handover: pass, release or take.'
  if (a.action === 'handover' && a.handover !== 'pass' && (a.handoverTo || a.appId)) return 'handoverTo and appId are for a pass only.'
  if (a.action === 'handover' && a.handoverTo === 'app' && !a.appId) return 'handoverTo app names the app (appId).'
  if (a.action === 'handover' && a.appId && a.handoverTo !== 'app') return 'appId goes with handoverTo app.'
  if (a.action === 'sender-action' && !a.senderAction) return 'Name the sender action (senderAction).'
  if (a.platform === 'instagram' && a.personaId) return 'Personas are Messenger\'s (Meta has none for Instagram Direct).'
  if (a.platform === 'instagram' && a.notification) return 'notification is a Messenger setting (Instagram Direct has none).'
  return null
}

const buildMessage = (args: Record<string, unknown>): MetaDraftBuilder => refused(async (account) => {
  const a = args as unknown as MessageArgs
  const problem = messageArgsRefusal(a)
  if (problem) return { refusal: problem }
  const chosen = await messagingAccount(account.accountId)
  const now = Date.now()
  const person = () => livePerson(chosen, need(a.personId, 'Name the person (personId: their scoped id from meta-conversations).'), a.platform)
  switch (a.action) {
    case 'message': {
      const p = await person()
      if (a.mode === 'utility') {
        const t = need(a.template, 'mode utility names the template (template: name, language, its values).')
        const found = (await livePageTemplates(chosen, t.name)).find((x) => x.name === t.name && x.language === t.language)
        if (!found) return { refusal: `The chosen Page has no utility template "${t.name}" in ${t.language} (meta-message-templates view messenger lists them).` }
        return utilityMessageDraft(p, { template: found, parameters: t.parameters ?? [], buttons: t.buttons ?? [] }, now)
      }
      let personaName: string | null = null
      if (a.personaId) {
        const persona = (await livePersonas(chosen)).personas.find((x) => x.personaId === a.personaId)
        if (!persona) return { refusal: 'That persona is not one of the chosen Page\'s (meta-messaging-setup view personas).' }
        personaName = persona.name
      }
      return conversationMessageDraft(p, { mode: a.mode ?? 'response', words: wordsOf(a), personaId: a.personaId ?? null, personaName, replyToMessageId: a.replyToMessageId ?? null, notification: a.notification ?? null }, now)
    }
    case 'private-reply':
      return privateReplyDraft(await livePrivateReplyTarget(chosen, { platform: a.platform, commentId: a.commentId ?? null, postId: a.postId ?? null, adId: a.adId ?? null }), wordsOf(a), now)
    case 'sender-action':
      return senderActionDraft(await person(), a.senderAction!, { messageId: a.messageId ?? null, reaction: a.reaction ?? null }, now)
    case 'instant-form': {
      const p = await person()
      return instantFormDraft(p, await liveLeadForm(chosen, need(a.formId, 'Name the lead form (formId).')), a.mode ?? 'response', now)
    }
    case 'creator-message': {
      const creator = await liveCreator(chosen, need(a.creatorUsername, 'Name the creator (creatorUsername).'))
      return creatorMessageDraft(creator, pageOf(chosen), chosen.instagramId!, wordsOf(a))
    }
    case 'handover': {
      const p = await person()
      let appName: string | null = null
      if (a.handoverTo === 'app') {
        const app = (await livePageApps(chosen)).find((x) => x.appId === a.appId)
        if (!app) return { refusal: 'That app is not installed on the chosen Page (Meta lists the Page\'s apps on its subscribed_apps edge): a conversation passes only to an app on the Page or to Meta\'s inboxes.' }
        appName = app.name
      }
      return handoverDraft(p, a.handover!, { kind: a.handover === 'pass' ? a.handoverTo ?? 'default' : 'default', appId: a.appId ?? null, appName }, a.metadata ?? null)
    }
  }
})

function messageFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const after = { ...(draft.after as MessageRecord) }
  const sent = done[0]?.result
  after.messageId = sent ? messageIdOf(sent) : null
  after.sent = done.length > 0
  return {
    data: { action: after.action, platform: after.platform, ...(after.messageId ? { messageId: after.messageId } : {}), note: after.action === 'handover' ? 'Meta changed who answers the conversation; a later handover changes it again.' : 'Sent: it cannot be recalled. meta-conversations view messages shows it in the conversation.' },
    before: { ...(draft.before as MessageRecord) },
    after,
    noUndo: 'A message cannot be recalled; a handover is changed by another handover.',
  }
}

const createMetaMessage: AgentTool = {
  name: META_MESSAGE_TOOL,
  title: 'Send a Meta message',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Gated as send-customer-message: a message reaches a person and cannot be recalled — never more than a person's own yes.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, F.ordersEdit, F.customersView],
  input: messageInput,
  description:
    'Write as the business to a person who wrote to it first, in a conversation of its chosen Facebook Page (Messenger) or its '
    + 'chosen Instagram account (Instagram Direct, through the Page it is linked to): a message (mode response or update inside '
    + 'Meta\'s 24-hour window — text, one media link Meta fetches, quick replies, a persona, a reply to one message; mode '
    + 'human-agent: a person\'s own non-promotional reply within 7 days of the person\'s last message, an App Review feature whose '
    + 'state no API reads, Meta\'s refusal is passed on and it is never re-sent as another kind; mode utility: an APPROVED Messenger '
    + 'utility template, any time, never marketing), ONE private reply to a comment or visitor post within 7 days, a sender action '
    + '("seen", typing, a reaction), an instant lead form inside a Messenger conversation, a creator message in Instagram\'s '
    + 'Partnership folder (App Review; 2 per 30 days before a reply), or a handover (pass to the Page or Instagram Inbox or an app '
    + 'on the Page, release, take — Conversation Routing). The ACCOUNT_UPDATE, POST_PURCHASE_UPDATE and CONFIRMED_EVENT_UPDATE tags '
    + 'are refused (Meta error 100 since 2026-04-27); Nexus cannot see a 7-day click-to-message ad window, so it holds to 24 hours. '
    + 'The person is named by Meta\'s scoped id from meta-conversations and checked to have a conversation with the business; a '
    + 'Page or account another business in Nexus uses is never written to; never a marketplace buyer (send-customer-message). The '
    + 'preview shows the EXACT words and the recipient\'s id; a message reaches the person at once and cannot be recalled (no undo). '
    + 'Standard access reaches only people with a role on the business\'s Meta app — real customers need Advanced Access (App '
    + 'Review): Meta\'s refusal says so in words. Meta has no check for any of these. Nothing spends. Stored: the request (its '
    + 'arguments and its preview) and Claude\'s record of the call keep the person\'s id and the words, for as long as Nexus keeps '
    + 'them (nothing deletes them today; the run and the Approvals page need them); the change record keeps the kind, the conversation and '
    + 'Meta\'s message id, never the words or the person\'s id; Nexus\'s call log to Meta neither. Each request is approved on its own '
    + '(never in a bulk approve). Its Claude rule is its own (Settings › AI › Claude › Rules): turning send-customer-message Off for '
    + 'Claude does not turn this Off — each is set on its own.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildMessage(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildMessage(args), messageFinish),
}

// ── set-meta-conversation-labels ─────────────────────────────────────────────────────────────────────────────────

const labelsInput = z.object({
  connectionId: metaConnectionArg,
  action: z.enum(LABEL_ACTIONS).describe('create (a new label of the chosen Page) · add (put a label on a person\'s Messenger conversation) · remove (take it off) · delete (the label, for good: confirmDelete)'),
  name: z.string().trim().min(1).max(L.labelName).optional().describe(`create: the label\'s name (at most ${L.labelName}; e.g. "return asked")`),
  labelId: metaIdArg('add / remove / delete: a label of the chosen Page (meta-conversations view labels)').optional(),
  personId: personArg.optional().describe('add / remove: the person (their Page-scoped id from meta-conversations view messenger; kept in the change record for the undo)'),
  confirmDelete: confirmDeleteArg,
  why: metaWhyArg,
})
type LabelsArgs = z.infer<typeof labelsInput>
const LABEL_ARGS: Readonly<Record<LabelsArgs['action'], readonly string[]>> = { create: ['name'], add: ['labelId', 'personId'], remove: ['labelId', 'personId'], delete: ['labelId', 'confirmDelete'] }

const buildLabels = (args: Record<string, unknown>): MetaDraftBuilder => refused(async (account) => {
  const a = args as unknown as LabelsArgs
  const extra = extraArgs(a as Record<string, unknown>, LABEL_ARGS[a.action], `action ${a.action}`)
  if (extra) return { refusal: extra }
  if (a.action === 'delete' && a.confirmDelete !== true) return { refusal: `Deleting a label is only on an explicit ask: confirmDelete: true. ${LABEL_DELETE_FINAL}` }
  const chosen = await messagingAccount(account.accountId)
  const live = await livePageLabels(chosen)
  if (a.action === 'create') return labelCreateDraft(live.pageId, live.labels, need(a.name, 'Name the label (name).'))
  const label = live.labels.find((l) => l.labelId === need(a.labelId, 'Name the label (labelId).'))
  if (!label) return { refusal: `That label is not one of the chosen Page's inbox labels${live.more ? ' (among the first 500)' : ''} (meta-conversations view labels).` }
  if (a.action === 'delete') return labelDeleteDraft(live.pageId, label)
  const person = await liveMessengerPerson(chosen, need(a.personId, 'Name the person (personId).'))
  return labelPersonDraft(a.action, label, person)
})

function labelsFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const after = { ...(draft.after as LabelRecord) }
  if (after.action === 'create') after.labelId = idOf(done[0]?.result.node?.id)
  return {
    data: { action: after.action, labelId: after.labelId, ...(after.labelName ? { name: after.labelName } : {}), ...(after.action === 'create' && !after.labelId ? { note: 'Meta made it but named no id: meta-conversations view labels shows it.' } : {}) },
    before: { ...(draft.before as LabelRecord) }, after,
  }
}

const LABEL_OPPOSITE: Partial<Record<LabelsArgs['action'], LabelsArgs['action']>> = { add: 'remove', remove: 'add' }
const labelsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as LabelRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const chosen = await messagingAccount(account.accountId)
      if (chosen.pageId !== after.pageId) return null
      if (after.action === 'create') {
        const live = await livePageLabels(chosen)
        return { ...after, exists: live.labels.some((l) => l.labelId === after.labelId), accountId: account.accountId, adAccountId: account.adAccountId }
      }
      // add / remove: Meta reads one person's labels only with their id in the path (never read): as recorded.
      return { ...after, accountId: account.accountId, adAccountId: account.adAccountId }
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as LabelRecord & { accountId?: string }
    const base = after.accountId ? { connectionId: after.accountId } : {}
    const why = `undo of an earlier ${after.action} (set-meta-conversation-labels)`
    if (after.action === 'create') {
      if (!after.labelId) return { refusal: 'This change kept no id of the label it made, so there is nothing to delete.' }
      return { tool: META_LABELS_TOOL, args: { ...base, action: 'delete', labelId: after.labelId, confirmDelete: true, why: `${why}: deletes the label Nexus made` } }
    }
    const opposite = LABEL_OPPOSITE[after.action]
    if (opposite && after.labelId && after.personId) return { tool: META_LABELS_TOOL, args: { ...base, action: opposite, labelId: after.labelId, personId: after.personId, why } }
    return { refusal: LABEL_DELETE_FINAL }
  },
}

const setMetaConversationLabels: AgentTool = {
  name: META_LABELS_TOOL,
  title: 'Change Meta inbox labels',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'delete' ? { reversibility: 'none' } : typeof args.action === 'string' ? { reversibility: 'full' } : null),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, F.ordersEdit, F.customersView],
  input: labelsInput,
  description:
    'The chosen Facebook Page\'s inbox labels (Messenger; they sort the Page\'s inbox, the person never sees them): make a label, '
    + 'put one on or take one off a person\'s conversation (the person: their Page-scoped id from meta-conversations, checked to '
    + 'have a conversation with the Page), delete a label (confirmDelete: true — final: the people who carried it lose it). Goes AS '
    + 'the Page (the gateway reads its own token; the MESSAGING task, pages_messaging, pages_manage_metadata, and a Page admin '
    + 'must have accepted Meta\'s Page Contact Terms). Nexus does not read one person\'s labels (Meta reads them only with the '
    + 'person\'s id in the request path, which Nexus\'s call log keeps). Meta has no check for these. Nothing spends. Undo: a label '
    + 'Nexus made is deleted, on ⇄ off; the person\'s id is kept in the change record for that undo.'
    + META_CHANGE_RULES,
  undo: labelsUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildLabels(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildLabels(args), labelsFinish),
}

// ── set-meta-message-templates ───────────────────────────────────────────────────────────────────────────────────

const partsArg = {
  header: z.object({
    text: z.string().min(1).max(L.headerText).describe(`the header text (at most ${L.headerText}; at most one placeholder: {{1}}, or {{name}} for NAMED)`),
    example: z.string().min(1).max(200).optional().describe('the placeholder\'s example (Meta approves no template without examples)'),
  }).optional().describe('a text header (a media header needs a file handle Nexus does not make: refused)'),
  body: z.object({
    text: z.string().min(1).max(L.bodyText).describe(`the body (at most ${L.bodyText}; placeholders {{1}}, {{2}}, … in order, or {{name}} for NAMED)`),
    examples: z.array(z.string().min(1).max(200)).max(L.examples).optional().describe('POSITIONAL: one example per placeholder, in order'),
    namedExamples: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).describe('the placeholder\'s name'), example: z.string().min(1).max(200).describe('its example') })).max(L.examples).optional().describe('NAMED: each placeholder\'s example'),
  }).optional().describe('the body (create, edit)'),
  footer: z.string().min(1).max(L.footerText).optional().describe(`WhatsApp: a footer line (at most ${L.footerText}; no placeholders)`),
  buttons: z.array(z.object({
    type: z.enum(BUTTON_TYPES).describe('url (a fixed https link), phone, postback (Messenger), quick-reply (WhatsApp)'),
    text: z.string().min(1).max(L.buttonText).describe(`the button's words (at most ${L.buttonText})`),
    url: httpsUrl('url: the link (no placeholder)').optional(),
    phone: z.string().regex(/^\+?[1-9]\d{6,14}$/, '+ and digits').optional().describe('phone: the number, international form'),
    payload: z.string().min(1).max(L.payload).optional().describe('postback: what the business\'s app receives'),
  })).min(1).max(L.whatsappButtons).optional().describe(`buttons (Messenger at most ${L.messengerButtons}; WhatsApp ${L.whatsappButtons}, at most 2 links and 1 phone)`),
}

const templatesInput = z.object({
  connectionId: metaConnectionArg,
  platform: z.enum(TEMPLATE_CHANNELS).describe('messenger (utility templates of the chosen Facebook Page) or whatsapp (templates and template groups of the business\'s own WhatsApp account)'),
  action: z.enum(TEMPLATE_ACTIONS).describe('create · edit (Messenger: new parts; Meta reviews again) · delete (one template: confirmDelete) · group-create · group-update · group-delete (WhatsApp template groups; confirmDelete)'),
  whatsappAccountId: metaIdArg('whatsapp: the WhatsApp account, when the portfolio owns several (meta-message-templates view whatsapp)').optional(),
  templateId: metaIdArg('edit / delete: the template (meta-message-templates)').optional(),
  name: z.string().regex(META_TEMPLATE_NAME, 'lower-case letters, digits and _').optional().describe('create: the template\'s name (lower-case letters, digits and _; unique per language)'),
  language: z.string().regex(META_TEMPLATE_LANGUAGE, 'a language code').optional().describe('create: its language (it, it_IT, de_DE, en_US, …): one template per language'),
  category: z.enum(['UTILITY', 'MARKETING']).optional().describe('create: UTILITY (order, shipping, account updates — Messenger takes only this) or MARKETING (WhatsApp); AUTHENTICATION is not offered (one-time codes)'),
  parameterFormat: z.enum(['POSITIONAL', 'NAMED']).optional().describe('create: placeholders {{1}}, {{2}}, … (POSITIONAL, default) or {{name}} (NAMED)'),
  ...partsArg,
  libraryTemplateName: z.string().regex(META_TEMPLATE_NAME).optional().describe('create (Messenger): copy one of Meta\'s library utility templates by its name instead of giving parts'),
  libraryButtons: z.array(z.object({
    type: z.enum(['url', 'phone']).describe('the library template\'s button kind'),
    url: httpsUrl('url: the base link').optional(),
    phone: z.string().regex(/^\+?[1-9]\d{6,14}$/).optional().describe('phone: the number'),
  })).min(1).max(L.messengerButtons).optional().describe('create with libraryTemplateName: the business\'s values for its buttons'),
  groupId: metaIdArg('group-update / group-delete: the template group').optional(),
  groupName: z.string().min(1).max(L.groupName).optional().describe(`group-create / group-update: the group's name (unique, at most ${L.groupName})`),
  description: z.string().min(1).max(L.groupDescription).optional().describe(`group-create / group-update: its description (at most ${L.groupDescription})`),
  templateIds: z.array(z.string().regex(/^\d{1,25}$/)).min(1).max(L.groupTemplates).optional().describe('group-create: the account\'s templates in the group (a template is in one group at a time)'),
  addTemplateIds: z.array(z.string().regex(/^\d{1,25}$/)).min(1).max(L.groupTemplates).optional().describe('group-update: templates to add'),
  removeTemplateIds: z.array(z.string().regex(/^\d{1,25}$/)).min(1).max(L.groupTemplates).optional().describe('group-update: templates to take off'),
  confirmDelete: confirmDeleteArg,
  why: metaWhyArg,
})
type TemplatesArgs = z.infer<typeof templatesInput>
const PART_KEYS = ['header', 'body', 'footer', 'buttons'] as const
const TEMPLATE_ARGS: Readonly<Record<TemplatesArgs['action'], readonly string[]>> = {
  create: ['platform', 'whatsappAccountId', 'name', 'language', 'category', 'parameterFormat', ...PART_KEYS, 'libraryTemplateName', 'libraryButtons'],
  edit: ['platform', 'templateId', ...PART_KEYS],
  delete: ['platform', 'whatsappAccountId', 'templateId', 'confirmDelete'],
  'group-create': ['platform', 'whatsappAccountId', 'groupName', 'description', 'templateIds'],
  'group-update': ['platform', 'whatsappAccountId', 'groupId', 'groupName', 'description', 'addTemplateIds', 'removeTemplateIds'],
  'group-delete': ['platform', 'whatsappAccountId', 'groupId', 'confirmDelete'],
}
const partsOf = (a: TemplatesArgs): TemplateParts | null => (a.body ? { body: a.body, ...(a.header ? { header: a.header } : {}), ...(a.footer !== undefined ? { footer: a.footer } : {}), ...(a.buttons ? { buttons: a.buttons } : {}) } : null)

const buildTemplates = (args: Record<string, unknown>): MetaDraftBuilder => refused(async (account) => {
  const a = args as unknown as TemplatesArgs
  const extra = extraArgs(a as Record<string, unknown>, TEMPLATE_ARGS[a.action], `action ${a.action}`)
  if (extra) return { refusal: extra }
  if ((a.action === 'delete' || a.action === 'group-delete') && a.confirmDelete !== true) return { refusal: 'Deleting is only on an explicit ask: confirmDelete: true (a deleted template or group cannot come back).' }
  if (a.platform === 'messenger' && a.action.startsWith('group-')) return { refusal: 'Template groups are WhatsApp\'s (platform whatsapp).' }
  if (a.platform === 'messenger' && a.whatsappAccountId) return { refusal: 'whatsappAccountId is for platform whatsapp.' }
  // Review B-F4 — never "delete and make it again": an approved template's name stays blocked 30 days after a delete.
  if (a.platform === 'whatsapp' && a.action === 'edit') return { refusal: 'Nexus does not edit WhatsApp templates yet. Meta allows an edit of an approved, rejected or paused template (WhatsApp Manager does it); deleting an approved template keeps its name blocked for 30 days, so it is no way to change one.' }
  if (a.platform === 'whatsapp' && (a.libraryTemplateName || a.libraryButtons)) return { refusal: 'Nexus copies Meta library templates for Messenger only.' }
  if (a.libraryButtons && !a.libraryTemplateName) return { refusal: 'libraryButtons go with libraryTemplateName.' }
  const chosen = await messagingAccount(account.accountId)
  const format: ParameterFormat = a.parameterFormat ?? 'POSITIONAL'
  if (a.platform === 'messenger') {
    const pageId = pageOf(chosen)
    if (a.action === 'create') {
      const name = need(a.name, 'Name the template (name).')
      const existing = (await livePageTemplates(chosen, name)).map((t) => ({ name: t.name, language: t.language }))
      return templateCreateDraft({ channel: 'messenger', ownerId: pageId, name, language: need(a.language, 'Name the template\'s language (language).'), category: a.category ?? 'UTILITY', format, parts: partsOf(a), library: a.libraryTemplateName ? { name: a.libraryTemplateName, buttons: a.libraryButtons ?? [] } : null, existing })
    }
    const template = await livePageTemplate(chosen, need(a.templateId, 'Name the template (templateId).'))
    if (a.action === 'edit') return templateEditDraft(pageId, template, need(partsOf(a), 'Give the template\'s new parts (body, and optionally header and buttons).'))
    return templateDeleteDraft('messenger', pageId, template)
  }
  const waba = await liveWhatsAppAccount(chosen, a.whatsappAccountId ?? null)
  const templates = await liveWhatsAppTemplates(chosen, waba)
  switch (a.action) {
    case 'create':
      return templateCreateDraft({ channel: 'whatsapp', ownerId: waba.wabaId, name: need(a.name, 'Name the template (name).'), language: need(a.language, 'Name the template\'s language (language).'), category: need(a.category, 'Name the category (UTILITY or MARKETING).'), format, parts: partsOf(a), library: null, existing: templates.map((t) => ({ name: t.name, language: t.language })) })
    case 'delete': {
      const t = templates.find((x) => x.templateId === need(a.templateId, 'Name the template (templateId).'))
      if (!t) return { refusal: 'That template is not one of this WhatsApp account\'s (among the first 500 Meta lists).' }
      return templateDeleteDraft('whatsapp', waba.wabaId, t)
    }
    case 'group-create':
      return groupCreateDraft(waba.wabaId, { name: need(a.groupName, 'Name the group (groupName).'), description: a.description ?? null, templateIds: a.templateIds ?? [] }, templates)
    case 'group-update':
      return groupUpdateDraft(waba.wabaId, await liveTemplateGroup(chosen, waba, need(a.groupId, 'Name the group (groupId).')), { name: a.groupName ?? null, description: a.description ?? null, add: a.addTemplateIds ?? [], remove: a.removeTemplateIds ?? [] }, templates)
    case 'group-delete':
      return groupDeleteDraft(waba.wabaId, await liveTemplateGroup(chosen, waba, need(a.groupId, 'Name the group (groupId).')))
    default:
      return { refusal: `${a.action} is not a WhatsApp template change.` }
  }
})

function templatesFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const after = { ...(draft.after as TemplateRecord) }
  const node = done[0]?.result.node ?? null
  if (after.action === 'create') { after.templateId = idOf(node?.id); after.status = typeof node?.status === 'string' ? node.status : null }
  if (after.action === 'edit') after.status = typeof node?.status === 'string' ? node.status : after.status ?? null
  if (after.action === 'group-create') after.groupId = idOf(node?.id)
  const rejected = typeof node?.rejection_reason === 'string' && node.rejection_reason !== 'NONE' ? node.rejection_reason : null
  return {
    data: {
      platform: after.channel, action: after.action, ...(after.templateId ? { templateId: after.templateId } : {}), ...(after.groupId ? { groupId: after.groupId } : {}),
      ...(after.status ? { status: after.status } : {}), ...(rejected ? { rejectionReason: rejected } : {}),
      note: after.action === 'create' || after.action === 'edit' ? 'Meta reviews the template (meta-message-templates shows its status and any rejection).' : 'meta-message-templates shows it now.',
    },
    before: { ...(draft.before as TemplateRecord) }, after,
  }
}

const templatesUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as TemplateRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const stamp = (r: TemplateRecord) => ({ ...r, accountId: account.accountId, adAccountId: account.adAccountId })
    try {
      const chosen = await messagingAccount(account.accountId)
      if (after.channel === 'messenger') {
        if (chosen.pageId !== after.pageId) return null
        if (after.action === 'create') return stamp({ ...after, exists: (await livePageTemplates(chosen)).some((t) => t.templateId === after.templateId) })
        if (after.action === 'edit') {
          const t = await livePageTemplate(chosen, after.templateId!)
          return stamp({ ...after, parts: partsFromMeta(t.components, after.parameterFormat ?? 'POSITIONAL', 'messenger'), status: after.status })
        }
        return stamp(after)
      }
      const waba = await liveWhatsAppAccount(chosen, after.wabaId ?? null)
      if (waba.wabaId !== after.wabaId) return null
      if (after.action === 'create') return stamp({ ...after, exists: (await liveWhatsAppTemplates(chosen, waba)).some((t) => t.templateId === after.templateId) })
      if (after.action === 'group-create') {
        try { await liveTemplateGroup(chosen, waba, after.groupId!); return stamp(after) } catch (err) { if (err instanceof MetaLiveRefusal) return stamp({ ...after, exists: false }); throw err }
      }
      if (after.action === 'group-update') {
        const g = await liveTemplateGroup(chosen, waba, after.groupId!)
        return stamp({ ...after, groupName: g.name, description: g.description, templateIds: [...g.templateIds].sort() })
      }
      return stamp(after)
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as TemplateRecord & { accountId?: string }
    const before = (change.before ?? {}) as TemplateRecord
    const base = { ...(after.accountId ? { connectionId: after.accountId } : {}), platform: after.channel, ...(after.channel === 'whatsapp' && after.wabaId ? { whatsappAccountId: after.wabaId } : {}) }
    const why = `undo of an earlier ${after.action} (set-meta-message-templates)`
    switch (after.action) {
      case 'create':
        if (!after.templateId) return { refusal: 'This change kept no id of the template it made, so there is nothing to delete.' }
        return { tool: META_TEMPLATES_TOOL, args: { ...base, action: 'delete', templateId: after.templateId, confirmDelete: true, why: `${why}: deletes the template Nexus made` } }
      case 'edit': {
        const old = before.parts
        if (!old) return { refusal: 'This edit has no undo: the template\'s old parts held something Nexus does not send.' }
        return { tool: META_TEMPLATES_TOOL, args: { ...base, action: 'edit', templateId: after.templateId, body: old.body, ...(old.header ? { header: old.header } : {}), ...(old.buttons ? { buttons: old.buttons } : {}), why } }
      }
      case 'group-create':
        if (!after.groupId) return { refusal: 'This change kept no id of the group it made, so there is nothing to delete.' }
        return { tool: META_TEMPLATES_TOOL, args: { ...base, action: 'group-delete', groupId: after.groupId, confirmDelete: true, why: `${why}: deletes the group Nexus made` } }
      case 'group-update': {
        const was = new Set(before.templateIds ?? [])
        const now = new Set(after.templateIds ?? [])
        const add = [...was].filter((id) => !now.has(id))
        const remove = [...now].filter((id) => !was.has(id))
        return {
          tool: META_TEMPLATES_TOOL,
          args: {
            ...base, action: 'group-update', groupId: after.groupId,
            ...(before.groupName && before.groupName !== after.groupName ? { groupName: before.groupName } : {}),
            ...(before.description && before.description !== after.description ? { description: before.description } : {}),
            ...(add.length ? { addTemplateIds: add } : {}), ...(remove.length ? { removeTemplateIds: remove } : {}), why,
          },
        }
      }
      default:
        return { refusal: 'A deleted template or group cannot come back (a new one is made, and Meta reviews a template again).' }
    }
  },
}

const setMetaMessageTemplates: AgentTool = {
  name: META_TEMPLATES_TOOL,
  title: 'Change Meta message templates',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'partial',
  consequencesFor: (args) => {
    if (args.action === 'delete' || args.action === 'group-delete') return { reversibility: 'none' }
    // Review A-N3 — a group's new name or description: its old one may have been empty, which Nexus cannot write back.
    if (args.action === 'group-update' && (args.groupName !== undefined || args.description !== undefined)) return { reversibility: 'partial' }
    if (args.action === 'group-create' || args.action === 'group-update') return { reversibility: 'full' }
    return typeof args.action === 'string' ? { reversibility: 'partial' } : null
  },
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, F.ordersEdit],
  input: templatesInput,
  description:
    'Message templates. Messenger (as the chosen Facebook Page; page_utility_messaging): make a UTILITY template (text header, '
    + 'body with {{1}} or {{name}} placeholders and their examples, link / phone / postback buttons — or a copy of one of Meta\'s '
    + 'library templates), edit one (new parts; Meta reviews it again), delete one (confirmDelete — always by its id AND name, never '
    + 'the name in every language). WhatsApp (the business\'s own WhatsApp account, owned by the chosen ad account\'s portfolio, '
    + 'never a shared one; whatsapp_business_management): make a MARKETING or UTILITY template (header, body, footer, quick-reply / '
    + 'link / phone buttons; AUTHENTICATION is not offered), delete one (confirmDelete; by hsm_id AND name; an approved name stays '
    + 'taken 30 days), template groups: make, change (name, description, templates added or taken off), delete (confirmDelete; '
    + 'the templates stay). No WhatsApp account: said in words (made in WhatsApp Manager). Meta reviews every template '
    + '(PENDING → APPROVED or REJECTED) and may change a WhatsApp template\'s category; the run shows Meta\'s status and rejection '
    + 'reason. Media headers need a file handle Nexus does not make: refused. Meta has no check for these. Nothing spends (Nexus '
    + 'sends no WhatsApp message). Undo: a template or group Nexus made is deleted; an edit writes the old parts back when Nexus '
    + 'can send them again; a group change is put back (a name or description that was empty before stays: Nexus sends no empty '
    + 'text); a delete has none.'
    + META_CHANGE_RULES,
  undo: templatesUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildTemplates(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildTemplates(args), templatesFinish),
}

// ── set-meta-messaging-setup ─────────────────────────────────────────────────────────────────────────────────────

/** Review A-B1 / S3 — what Nexus keeps of the WhatsApp code, and for how long, said as it is. */
export const WHATSAPP_CODE_KEPT = 'The code is kept encrypted with the request for as long as Nexus keeps the request (nothing deletes '
  + 'requests today) and shown nowhere — the Approvals list and edit form, Claude\'s record of the call and the audit rows show it '
  + 'masked; it is opened only to send it to Meta, and never reaches the change record or Nexus\'s call log. A conversation it '
  + 'was typed into keeps it as typed.'

const localeArg = z.string().regex(/^(default|[a-z]{2}_[A-Z]{2})$/, '"default" or a locale').describe('"default" (required once: everyone else) or a locale (it_IT, de_DE, …)')
const menuArg = z.array(z.object({
  locale: localeArg,
  composerInputDisabled: z.boolean().optional().describe('Messenger: true hides the text box (people only tap the menu)'),
  items: z.array(z.object({
    type: z.enum(['postback', 'web_url']).describe('postback (the business\'s app gets payload) or web_url (opens url)'),
    title: z.string().min(1).max(L.menuTitle).describe(`the item's words (at most ${L.menuTitle})`),
    payload: z.string().min(1).max(L.payload).optional().describe('postback: what the app receives'),
    url: httpsUrl('web_url: the link').optional(),
    webviewHeight: z.enum(['compact', 'tall', 'full']).optional().describe('web_url (Messenger only; Instagram has none): how tall the page opens (full is Meta\'s default)'),
  })).min(1).max(L.menuItems).describe(`the menu's items (at most ${L.menuItems})`),
})).min(1).max(L.menus)

const setupInput = z.object({
  connectionId: metaConnectionArg,
  section: z.enum(SETUP_SECTIONS).describe('profile (Messenger / Instagram profile: set and / or clear properties) · person-menu (one person\'s own persistent menu) · persona · nlp (Built-In NLP) · calling · welcome-flow · whatsapp-number (link a WhatsApp number to the Page) · messenger-ad-defaults (Meta cannot: answered in words)'),
  platform: platformArg.optional().describe('profile: messenger (default) or instagram (ice breakers and menu only)'),
  properties: z.object({
    getStarted: z.object({ payload: z.string().min(1).max(L.payload).describe('what the app receives when Get Started is tapped') }).optional().describe('the Get Started button'),
    greeting: z.array(z.object({ locale: localeArg, text: z.string().min(1).max(L.greeting).describe(`the welcome text (at most ${L.greeting}; {{user_first_name}} works)`) })).min(1).max(L.menus).optional().describe('the welcome screen\'s greeting per locale'),
    iceBreakers: z.array(z.object({ locale: localeArg, questions: z.array(z.object({ question: z.string().min(1).max(L.iceQuestion).describe('the question shown'), payload: z.string().min(1).max(L.payload).describe('what the app receives') })).min(1).max(L.iceBreakers).describe(`at most ${L.iceBreakers} questions`) })).min(1).max(L.menus).optional().describe('frequently asked questions shown when a chat opens'),
    persistentMenu: menuArg.optional().describe('the Page\'s persistent menu per locale'),
    allowlistedDomains: z.array(httpsUrl('a domain the Messenger webview may open')).min(1).max(L.domains).optional().describe('allowlisted domains (whitelisted_domains)'),
    accountLinkingUrl: httpsUrl('the account-linking page (https)').optional(),
    commands: z.array(z.object({ locale: localeArg, commands: z.array(z.object({ name: z.string().min(1).max(L.commandName).describe('the command word (no /)'), description: z.string().min(1).max(L.commandDescription).describe('what it does') })).min(1).max(L.commands).describe('the commands') })).min(1).max(L.commandSets).optional().describe('commands per locale'),
  }).optional().describe('profile: the properties to set (only these are overwritten)'),
  clear: z.array(z.enum(PROFILE_KEYS)).min(1).max(PROFILE_KEYS.length).optional().describe('profile: the properties to delete'),
  personId: personArg.optional().describe('person-menu: the person (kept in the change record for the undo)'),
  menu: menuArg.optional().describe('person-menu: their own menu (left out with clearMenu)'),
  clearMenu: z.literal(true).optional().describe('person-menu: true — take their own menu off (they see the Page\'s menu again)'),
  action: z.enum(['create', 'update', 'delete']).optional().describe('persona: create / delete · welcome-flow: create / update / delete'),
  personaId: metaIdArg('persona delete: the persona (meta-messaging-setup view personas)').optional(),
  personaName: z.string().min(1).max(L.personaName).optional().describe(`persona create: the name shown (at most ${L.personaName})`),
  pictureUrl: httpsUrl('persona create: the picture Meta fetches (at most 8 MB)').optional(),
  nlpEnabled: z.boolean().optional().describe('nlp: on or off'),
  nlpModel: z.enum(META_NLP_MODELS).optional().describe('nlp on: the language model (ITALIAN_STANDARD, GERMAN_STANDARD, FRENCH_STANDARD, SPANISH, ENGLISH, …)'),
  nBest: z.number().int().min(1).max(8).optional().describe('nlp on: how many other intents Meta adds'),
  calling: z.object({
    audio: z.boolean().optional().describe('audio calls on / off'),
    video: z.boolean().optional().describe('video calls on / off'),
    icon: z.boolean().optional().describe('the call icon in chats shown / hidden'),
    hours: z.object({
      timeZone: z.string().min(1).max(64).describe('the time zone (Europe/Rome)'),
      days: z.array(z.object({ day: z.enum(META_WEEK_DAYS).describe('the day'), open: z.string().regex(/^\d{4}$/).describe('opens, hhmm'), close: z.string().regex(/^\d{4}$/).describe('closes, hhmm') })).max(7).describe('the open days (the others are closed)'),
    }).optional().describe('call hours (they replace the old ones whole)'),
    routing: z.enum(['META', 'PARTNERS']).optional().describe('where incoming calls ring: META (Meta\'s inboxes) or PARTNERS (other apps)'),
  }).optional().describe('calling: what to change'),
  flowId: metaIdArg('welcome-flow update / delete: the flow (meta-messaging-setup view welcome-flows)').optional(),
  flowName: z.string().min(1).max(L.flowName).optional().describe('welcome-flow: its name'),
  flowPlatforms: z.array(z.enum(['messenger', 'instagram'])).min(1).max(2).optional().describe('welcome-flow: the platforms it shows on'),
  flowMessages: z.array(z.object({
    text: z.string().min(1).max(L.messengerText).describe('the message'),
    quickReplies: z.array(z.object({ title: z.string().min(1).max(L.quickReplyTitle).describe('the button'), payload: z.string().min(1).max(L.payload).describe('what the app receives') })).min(1).max(L.quickReplies).optional().describe('its quick replies'),
  })).min(1).max(L.flowMessages).optional().describe(`welcome-flow: the messages people get after clicking the ad (at most ${L.flowMessages})`),
  whatsappNumber: z.string().min(7).max(20).optional().describe('whatsapp-number: the number in international form (+39…)'),
  verificationCode: z.string().regex(/^\d{4,10}$/, 'digits').optional().describe('whatsapp-number step 2: the code WhatsApp sent to that number, read by the person on that phone (used once; kept encrypted with the request and shown nowhere)'),
  confirmDelete: confirmDeleteArg,
  why: metaWhyArg,
})
type SetupArgs = z.infer<typeof setupInput>
const SETUP_ARGS: Readonly<Record<SetupArgs['section'], readonly string[]>> = {
  profile: ['section', 'platform', 'properties', 'clear'],
  'person-menu': ['section', 'personId', 'menu', 'clearMenu'],
  persona: ['section', 'action', 'personaId', 'personaName', 'pictureUrl', 'confirmDelete'],
  nlp: ['section', 'nlpEnabled', 'nlpModel', 'nBest'],
  calling: ['section', 'calling'],
  'welcome-flow': ['section', 'action', 'flowId', 'flowName', 'flowPlatforms', 'flowMessages', 'confirmDelete'],
  'whatsapp-number': ['section', 'whatsappNumber', 'verificationCode'],
  'messenger-ad-defaults': ['section'],
}

const buildSetup = (args: Record<string, unknown>): MetaDraftBuilder => refused(async (account) => {
  const a = args as unknown as SetupArgs
  if (a.section === 'messenger-ad-defaults') return { refusal: AD_DEFAULTS_CANNOT }
  const extra = extraArgs(a as Record<string, unknown>, SETUP_ARGS[a.section], `section ${a.section}`)
  if (extra) return { refusal: extra }
  const chosen = await messagingAccount(account.accountId)
  const pageId = pageOf(chosen)
  switch (a.section) {
    case 'profile': {
      const platform = a.platform ?? 'messenger'
      const live = await readMessengerProfile(chosen, platform)
      return profileDraft(pageId, platform, live.body, (a.properties ?? {}) as ProfileInput, (a.clear ?? []) as ProfileKey[])
    }
    case 'person-menu': {
      if (!!a.menu === !!a.clearMenu) return { refusal: 'Give their menu (menu) or take it off (clearMenu: true), one of them.' }
      const person = await liveMessengerPerson(chosen, need(a.personId, 'Name the person (personId).'))
      const live = await readPersonMenu(chosen, person.personId)
      return personMenuDraft(person, live.body?.user_level_persistent_menu, a.clearMenu ? null : (a.menu as MenuInput))
    }
    case 'persona': {
      const live = await livePersonas(chosen)
      if (a.action === 'create') {
        if (a.personaId || a.confirmDelete) return { refusal: 'persona create takes personaName and pictureUrl.' }
        return personaCreateDraft(pageId, live.personas, need(a.personaName, 'Name the persona (personaName).'), need(a.pictureUrl, 'Give the persona\'s picture (pictureUrl, https).'))
      }
      if (a.action !== 'delete') return { refusal: 'persona takes action create or delete.' }
      if (a.personaName || a.pictureUrl) return { refusal: 'persona delete takes personaId and confirmDelete.' }
      if (a.confirmDelete !== true) return { refusal: 'Deleting a persona is only on an explicit ask: confirmDelete: true.' }
      const persona = live.personas.find((p) => p.personaId === need(a.personaId, 'Name the persona (personaId).'))
      if (!persona) return { refusal: 'That persona is not one of the chosen Page\'s (among the first 500).' }
      return personaDeleteDraft(pageId, persona)
    }
    case 'nlp':
      return nlpDraft(pageId, await lastNlpSetByNexus(pageId), { nlpEnabled: need(a.nlpEnabled, 'Say whether NLP is on (nlpEnabled).'), model: a.nlpModel ?? null, nBest: a.nBest ?? null })
    case 'calling': {
      const live = await readCallSettings(chosen)
      return callingDraft(pageId, live.body, need(a.calling, 'Give what to change (calling).') as CallingInput)
    }
    case 'welcome-flow': {
      const action = need(a.action, 'welcome-flow takes action create, update or delete.')
      if (action === 'delete' && a.confirmDelete !== true) return { refusal: 'Deleting a welcome flow is only on an explicit ask: confirmDelete: true.' }
      if (action !== 'delete' && a.confirmDelete) return { refusal: 'confirmDelete is for delete only.' }
      if (action === 'create' && a.flowId) return { refusal: 'A new flow takes no flowId.' }
      if (action === 'delete' && (a.flowName || a.flowPlatforms || a.flowMessages)) return { refusal: 'A delete takes flowId and confirmDelete only.' }
      const flows = (await readWelcomeFlows(chosen, null)).rows
      const flow: Partial<FlowInput> = { ...(a.flowName !== undefined ? { name: a.flowName } : {}), ...(a.flowPlatforms ? { platforms: a.flowPlatforms } : {}), ...(a.flowMessages ? { messages: a.flowMessages } : {}) }
      return flowDraft(pageId, action, flows, { flowId: a.flowId ?? null, flow })
    }
    case 'whatsapp-number':
      return whatsappNumberDraft(await livePageWhatsAppNumber(chosen), need(a.whatsappNumber, 'Name the WhatsApp number (whatsappNumber).'), a.verificationCode ?? null)
  }
  return { refusal: 'Unknown section.' }
})

function setupFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const after = { ...(draft.after as SetupRecord) }
  const node = done[0]?.result.node ?? null
  if (after.section === 'persona' && after.action === 'create') after.personaId = idOf(node?.id)
  if (after.section === 'welcome-flow' && after.action === 'create') after.flowId = idOf(node?.flow_id ?? node?.id)
  // A profile change in two requests (set, then clear) of which only the first was made: the record says so.
  if (after.section === 'profile' && done.length < draft.requests.length) {
    const cleared = done.some((d) => d.request.operation === 'messengerprofile.delete')
    const set = done.some((d) => d.request.operation === 'messengerprofile.set')
    for (const [key, value] of Object.entries(after.properties ?? {})) if ((value === null && !cleared) || (value !== null && !set)) delete (after.properties as Record<string, unknown>)[key]
  }
  return {
    data: {
      section: after.section, ...(after.personaId ? { personaId: after.personaId } : {}), ...(after.flowId ? { flowId: after.flowId } : {}),
      ...(after.section === 'whatsapp-number' && typeof node?.verification_status === 'string' ? { verificationStatus: node.verification_status } : {}),
      note: after.section === 'nlp' ? 'Meta has no read of this setting: Nexus keeps the value it set.' : 'meta-messaging-setup shows it now.',
    },
    before: { ...(draft.before as SetupRecord) }, after,
    ...(after.section === 'whatsapp-number' ? { noUndo: 'Meta has no API to unlink a WhatsApp number: a person does it in the Page\'s settings.' } : {}),
  }
}

const setupUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as SetupRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const stamp = (r: SetupRecord) => ({ ...r, accountId: account.accountId, adAccountId: account.adAccountId })
    try {
      const chosen = await messagingAccount(account.accountId)
      if (chosen.pageId !== after.pageId) return null
      switch (after.section) {
        case 'profile': {
          const platform = after.platform ?? 'messenger'
          const live = (await readMessengerProfile(chosen, platform)).body
          const properties: Record<string, unknown> = {}
          for (const key of Object.keys(after.properties ?? {}) as ProfileKey[]) {
            const v = profileValueFromMeta(key, live[PROFILE_META_KEY[key]], platform === 'instagram')
            properties[key] = v === undefined ? 'unknown' : v
          }
          return stamp({ ...after, properties })
        }
        case 'person-menu': {
          const live = await readPersonMenu(chosen, after.personId!)
          const raw = live.body?.user_level_persistent_menu
          const menu = raw === undefined || raw === null || (Array.isArray(raw) && !raw.length) ? null : menuFromMeta(raw, false) ?? 'unknown'
          return stamp({ ...after, menu })
        }
        case 'persona':
          return stamp({ ...after, exists: (await livePersonas(chosen)).personas.some((p) => p.personaId === after.personaId) })
        case 'calling': {
          const now = callingFromMeta((await readCallSettings(chosen)).body)
          const calling: Record<string, unknown> = {}
          for (const key of Object.keys(after.calling ?? {})) calling[key] = (now as Record<string, unknown>)[key] ?? null
          return stamp({ ...after, calling: calling as CallingInput })
        }
        case 'welcome-flow': {
          if (!after.flowId) return stamp(after)
          try {
            const row = (await readWelcomeFlows(chosen, after.flowId)).rows[0]
            if (after.action === 'create') return stamp({ ...after, exists: !!row })
            return stamp({ ...after, flow: row ? flowFromMeta(row) ?? 'unknown' : null })
          } catch (err) {
            if (err instanceof MetaLiveRefusal) return stamp({ ...after, exists: false, flow: null })
            throw err
          }
        }
        default:
          // nlp: Meta has no read of it — as recorded.
          return stamp(after)
      }
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as SetupRecord & { accountId?: string }
    const before = (change.before ?? {}) as SetupRecord
    const base = after.accountId ? { connectionId: after.accountId } : {}
    const why = `undo of an earlier ${after.section} change (set-meta-messaging-setup)`
    switch (after.section) {
      case 'profile': {
        const old = before.properties ?? {}
        const keys = Object.keys(after.properties ?? {}) as ProfileKey[]
        const unknown = keys.filter((k) => old[k] === 'unknown' || old[k] === undefined)
        if (unknown.length) return { refusal: `No undo for ${unknown.join(', ')}: Meta's old value held something Nexus does not send.` }
        const profile = Object.fromEntries(keys.filter((k) => old[k] !== null).map((k) => [k, old[k]]))
        const clear = keys.filter((k) => old[k] === null)
        return { tool: META_SETUP_TOOL, args: { ...base, section: 'profile', ...(after.platform === 'instagram' ? { platform: 'instagram' } : {}), ...(Object.keys(profile).length ? { properties: profile } : {}), ...(clear.length ? { clear } : {}), why } }
      }
      case 'person-menu':
        if (before.menu === 'unknown' || before.menu === undefined) return { refusal: 'No undo: the person\'s old menu held something Nexus does not send.' }
        return { tool: META_SETUP_TOOL, args: { ...base, section: 'person-menu', personId: after.personId, ...(before.menu === null ? { clearMenu: true } : { menu: before.menu }), why } }
      case 'persona':
        if (after.action !== 'create') return { refusal: 'A deleted persona cannot come back (a new one gets a new id; its old messages keep its name).' }
        if (!after.personaId) return { refusal: 'This change kept no id of the persona it made, so there is nothing to delete.' }
        return { tool: META_SETUP_TOOL, args: { ...base, section: 'persona', action: 'delete', personaId: after.personaId, confirmDelete: true, why: `${why}: deletes the persona Nexus made` } }
      case 'nlp':
        return { tool: META_SETUP_TOOL, args: { ...base, section: 'nlp', nlpEnabled: before.knownToNexus ? before.nlpEnabled === true : false, ...(before.knownToNexus && before.nlpEnabled && before.model ? { nlpModel: before.model } : {}), why: `${why}${before.knownToNexus ? '' : ': Meta cannot read it back and Nexus never set it before, so NLP goes off (Meta\'s default)'}` } }
      case 'calling': {
        const keys = Object.keys(after.calling ?? {})
        const old = (before.calling ?? {}) as Record<string, unknown>
        const missing = keys.filter((k) => old[k] === undefined)
        if (missing.length) return { refusal: `No undo for ${missing.join(', ')}: Meta answered no old value for it.` }
        return { tool: META_SETUP_TOOL, args: { ...base, section: 'calling', calling: Object.fromEntries(keys.map((k) => [k, old[k]])), why } }
      }
      case 'welcome-flow':
        if (after.action === 'create') {
          if (!after.flowId) return { refusal: 'This change kept no id of the flow it made, so there is nothing to delete.' }
          return { tool: META_SETUP_TOOL, args: { ...base, section: 'welcome-flow', action: 'delete', flowId: after.flowId, confirmDelete: true, why: `${why}: deletes the flow Nexus made` } }
        }
        if (after.action === 'update') {
          const old = before.flow
          if (!old || old === 'unknown') return { refusal: 'No undo: the flow\'s old messages held something Nexus does not send.' }
          return { tool: META_SETUP_TOOL, args: { ...base, section: 'welcome-flow', action: 'update', flowId: after.flowId, flowName: old.name, flowPlatforms: old.platforms, flowMessages: old.messages, why } }
        }
        return { refusal: 'A deleted welcome flow cannot come back (a new one gets a new id).' }
      default:
        return { refusal: 'Meta has no API to unlink a WhatsApp number: a person does it in the Page\'s settings.' }
    }
  },
}

const setMetaMessagingSetup: AgentTool = {
  name: META_SETUP_TOOL,
  title: 'Change Meta messaging setup',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'partial',
  consequencesFor: (args) => {
    if (args.section === 'whatsapp-number' || args.action === 'delete') return { reversibility: 'none' }
    if (args.section === 'messenger-ad-defaults') return null
    return typeof args.section === 'string' ? { reversibility: 'partial' } : null
  },
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, F.ordersEdit, F.customersView],
  // Review A-B1 — the WhatsApp code is a secret argument (secret-args.ts): sealed where the request is stored, masked in
  // every record and view (the Approvals list and edit form, Claude's record of the call, the audit rows, a planned undo).
  secretArgs: ['verificationCode'],
  input: setupInput,
  description:
    'The messaging setup of the chosen Facebook Page, made AS the Page: its Messenger profile (Get Started, greeting, ice breakers, '
    + 'persistent menu, allowlisted domains, account linking, commands — set and / or clear; Instagram: ice breakers and menu; 10 '
    + 'calls per 10 minutes; the old values are read first), one person\'s own persistent menu (set or take off; their Page-scoped '
    + 'id is kept in the change record for the undo), personas (make; delete on confirmDelete — soft: old messages keep the name), '
    + 'Built-In NLP on / off and its model (Meta cannot read it back: Nexus keeps the value it set), Messenger calling (audio, '
    + 'video, call icon, call hours, where calls ring), welcome-message flows for Click-to-Messenger / Instagram ads (make, change, '
    + 'delete on confirmDelete; not one an ad uses), and linking a WhatsApp number to the Page (step 1 the number — WhatsApp sends '
    + 'a code to it; step 2 with that code, read by the person on that phone, used once; no unlink by API). ' + WHATSAPP_CODE_KEPT + ' '
    + 'The Page\'s default ice breakers and quick replies for messaging ads cannot be changed by API (read-only fields: section '
    + 'messenger-ad-defaults answers so). Meta has no check for these. Nothing spends. Undo writes the old values back where Meta '
    + 'answered them in a form Nexus can send again (else the preview says there is none); what Nexus made is deleted.'
    + META_CHANGE_RULES,
  undo: setupUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildSetup(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildSetup(args), setupFinish),
}

export const META_ADS_MESSAGING_CHANGE_TOOLS: AgentTool[] = [createMetaMessage, setMetaConversationLabels, setMetaMessageTemplates, setMetaMessagingSetup]
