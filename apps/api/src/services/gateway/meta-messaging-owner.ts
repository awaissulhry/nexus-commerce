/**
 * Meta step 38 (2026-10-26) — the owner check of a messaging change (meta-messaging-rules.ts). Before the gateway reads the
 * chosen Page's token (meta-page-token.ts) — or, for WhatsApp, sends with the system-user token — the object the change names
 * must be, by its kind:
 *   messengerpage / messagingpage  the business's CHOSEN Facebook Page itself (its PAGE MetaAccountLink);
 *   instagrampage                  that Page, and Meta names the CHOSEN Instagram account as its instagram_business_account
 *                                  (Instagram Direct goes through the Page the account is linked to);
 *   pagelabel / persona            an inbox label / a persona the chosen Page lists (`<page>/custom_labels`, `<page>/personas`,
 *                                  their first 500), read with the Page's own token;
 *   messengertemplate              a utility template the chosen Page lists (`<page>/message_templates`, its first 500);
 *   waba                           a WhatsApp Business account the chosen ad account's OWN business portfolio owns
 *                                  (`<portfolio>/owned_whatsapp_business_accounts`), and that portfolio is no other Nexus
 *                                  business's (nexus_meta_links_taken PORTFOLIO);
 *   templategroup                  a template group whose `whatsapp_business_account` is such an account.
 * And every id inside the body, each confirmed before anything is sent:
 *   messageperson    the person a message, handover, label or menu is for: Meta answers a conversation of the chosen Page
 *                    (Messenger) or of the chosen Instagram account (Instagram Direct) with that person among its participants
 *                    (`<page>/conversations?platform=…&user_id=…` — the person's id in the query only), and the id is no Page
 *                    or Instagram account another Nexus business uses;
 *   messagecomment   a private reply's comment: step 37's own check (meta-comment-owner.ts) — a comment on a post of the chosen
 *                    Page, or on the chosen Instagram account's media;
 *   visitorpost      a visitor's post on the chosen Page (`<page id>_<post id>`, Meta answers it, written by someone else);
 *   messagepersona   a persona the chosen Page lists; messageleadform: a lead form of the chosen Page (step 36's check);
 *   pageapp          Meta's Page Inbox or Instagram Inbox app, or an app installed on the chosen Page (`<page>/subscribed_apps`);
 *   threadmessage    a message of the SAME conversation (its 20 newest: Meta answers no older message's details);
 *   creator          the messaging id Meta's creator marketplace answers for the creator the change names (`parent`: kind
 *                    `creator`, their username), on the chosen Instagram account, no Page or account another Nexus business uses;
 *   pagetemplate     a utility template of the chosen Page by its id, with the same name the body names;
 *   welcomeflow      a flow the chosen Page's welcome_message_flows answers by its id, not used in an ad;
 *   wabatemplate     a template the WhatsApp account lists (`<waba>/message_templates`, its first 500).
 * Every read goes through this gateway (its read gate, ledger and rate bucket): the Page's own reads with the Page's token
 * (meta-page-reads.ts), the others with the system-user token. Anything else — another business's Page, account, person,
 * comment, label, template, flow or WhatsApp account, a node of another kind, an id Meta cannot place — gets nothing sent,
 * and the sentence never names the other business's asset.
 */
import { metaChosenInstagramOf, metaChosenPageOf, metaChosenPortfolioOf, metaLinkTaken, metaPortfolioShared } from './account.js'
import type { MetaJudgedWrite } from './meta-calls.js'
import type { MetaCheckRead } from './meta-brand-safety-owner.js'
import { metaCommentOwnerProblem } from './meta-comment-owner.js'
import { META_INSTAGRAM_INBOX_APP, META_MESSAGING_PAGE_KINDS, META_PAGE_INBOX_APP, META_WHATSAPP_KINDS } from './meta-messaging-rules.js'

type Problem = { code: string; sentence: string } | null
type Row = Record<string, unknown>
const idOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): Row[] => (Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]).map(obj).filter((r): r is Row => !!r) : Array.isArray(v) ? (v as unknown[]).map(obj).filter((r): r is Row => !!r) : [])
const NOT_SENT = 'Nothing was sent to Meta:'
const meta = (words: string | null) => (words ? ` (Meta: ${words})` : '')
const refuse = (sentence: string): Problem => ({ code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOT_SENT} ${sentence}` })
const notChosen = (sentence: string): Problem => ({ code: 'META_PAGE_NOT_CHOSEN', sentence: `${NOT_SENT} ${sentence}` })
const unconfirmed = (sentence: string, words: string | null): Problem => ({ code: 'META_PAGE_UNCONFIRMED', sentence: `${NOT_SENT} ${sentence}${meta(words)}.` })
/** At most this many ids inside one messaging body are checked (a send names at most 4). */
const MAX_BODY_IDS = 10
const PAGE_ID = /^\d{1,25}$/

/** A Meta list's own ids (fields), page by page on Meta's cursor (never its next link), up to `maxPages` of 100; null when unread. */
async function listed(read: MetaCheckRead, path: string, extra: Record<string, string> = {}, fields = 'id', maxPages = 5): Promise<{ rows: Row[]; more: boolean } | null> {
  const rows: Row[] = []
  let after: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const answer = await read(path, { fields, limit: '100', ...extra, ...(after ? { after } : {}) })
    if (!answer.body || !Array.isArray(answer.body.data)) return null
    rows.push(...rowsOf(answer.body))
    const paging = obj(answer.body.paging)
    after = typeof obj(paging?.cursors)?.after === 'string' && paging?.next ? obj(paging.cursors)!.after as string : null
    if (!after) return { rows, more: false }
  }
  return { rows, more: true }
}

/** Is it in the list? `null` = Nexus could not read the list (refused as unconfirmed). */
async function inList(read: MetaCheckRead, path: string, id: string, what: string, extra: Record<string, string> = {}): Promise<Problem> {
  const list = await listed(read, path, extra)
  if (!list) return unconfirmed(`Nexus could not read ${what} to confirm ${id} is one of them`, null)
  if (list.rows.some((r) => idOf(r.id) === id)) return null
  return list.more ? unconfirmed(`${id} is not among the first 500 of ${what}, so Nexus could not confirm it is one of them`, null) : notChosen(`${id} is not one of ${what}.`)
}

/** The chosen Instagram account, and Meta names it as the chosen Page's instagram_business_account. */
async function instagramOnPage(connectionId: string, pageId: string, read: MetaCheckRead): Promise<{ instagramId: string } | { problem: Problem }> {
  const instagramId = await metaChosenInstagramOf(connectionId)
  if (!instagramId) return { problem: { code: 'META_INSTAGRAM_NOT_CHOSEN', sentence: `${NOT_SENT} this business has no Instagram account chosen through this Meta connection, so Nexus sends no Instagram message.` } }
  const answer = await read(pageId, { fields: 'id,instagram_business_account' })
  if (!answer.body) return { problem: unconfirmed('Nexus could not confirm which Instagram account the chosen Facebook Page is linked to', answer.words) }
  if (idOf(answer.body.id) !== pageId || idOf(obj(answer.body.instagram_business_account)?.id) !== instagramId) {
    return { problem: { code: 'META_INSTAGRAM_NOT_CHOSEN', sentence: `${NOT_SENT} the chosen Instagram account is not the one Meta links to the chosen Facebook Page, and Instagram Direct goes through that Page.` } }
  }
  return { instagramId }
}

/** Why this messaging change made as the chosen Page is refused for this connection, or null. `kind` is a META_MESSAGING_PAGE_KINDS one. */
export async function metaMessagingOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string, read: MetaCheckRead, parent?: { kind: string; id: string }): Promise<Problem> {
  const id = write.objectId
  if (!META_MESSAGING_PAGE_KINDS.has(kind) || !(write.kinds as readonly string[] | undefined)?.includes(kind)) {
    return refuse(`a messaging change names the kind of object it changes (the chosen Page as it messages, its messaging setup, a label, persona or utility template of it), and ${id} is not named so.`)
  }
  if (write.auth !== 'page') return refuse('a messaging change of the Facebook Page goes with the Page\'s own token only.')
  const pageId = await metaChosenPageOf(connectionId)
  if (!pageId) return notChosen('this business has no Facebook Page chosen through this Meta connection, so Nexus sends no message and changes no messaging setup.')
  let instagramId: string | null = null
  switch (kind) {
    case 'messengerpage':
    case 'messagingpage':
      if (id !== pageId) return notChosen(`${id} is not the Facebook Page this business chose through this connection.`)
      break
    case 'instagrampage': {
      if (id !== pageId) return notChosen(`${id} is not the Facebook Page this business chose through this connection.`)
      const linked = await instagramOnPage(connectionId, pageId, read)
      if ('problem' in linked) return linked.problem
      instagramId = linked.instagramId
      break
    }
    case 'pagelabel': {
      const problem = await inList(read, `${pageId}/custom_labels`, id, 'the chosen Page\'s inbox labels')
      if (problem) return problem
      break
    }
    case 'persona': {
      const problem = await inList(read, `${pageId}/personas`, id, 'the chosen Page\'s personas')
      if (problem) return problem
      break
    }
    default: {
      const problem = await inList(read, `${pageId}/message_templates`, id, 'the chosen Page\'s utility templates')
      if (problem) return problem
    }
  }
  return bodyIdsProblem(connectionId, write, kind, pageId, instagramId, read, parent)
}

async function bodyIdsProblem(connectionId: string, write: MetaJudgedWrite, kind: string, pageId: string, instagramId: string | null, read: MetaCheckRead, parent?: { kind: string; id: string }): Promise<Problem> {
  const ids = write.ids ?? []
  if (ids.length > MAX_BODY_IDS) return refuse(`a messaging change names at most ${MAX_BODY_IDS} ids inside its body.`)
  const platform: 'messenger' | 'instagram' = kind === 'instagrampage' ? 'instagram' : 'messenger'
  let conversationId: string | null = null
  const inside = (problem: Problem): Problem => (problem ? { code: problem.code, sentence: problem.sentence.replace(`${NOT_SENT} `, `${NOT_SENT} inside this change, `) } : null)
  for (const inner of ids) {
    switch (inner.kind) {
      case 'messageperson': {
        if (!PAGE_ID.test(inner.id)) return refuse('inside this change, the person is a scoped id (digits).')
        if (await metaLinkTaken('PAGE', inner.id) || await metaLinkTaken('INSTAGRAM', inner.id)) return refuse('inside this change, the person is a Page or Instagram account another business in Nexus uses: Nexus never messages it.')
        const business = platform === 'instagram' ? instagramId : pageId
        const answer = await read(`${pageId}/conversations`, { platform, user_id: inner.id, fields: 'id,participants', limit: '5' })
        if (!answer.body) return unconfirmed(`Nexus could not confirm that the person has a ${platform === 'instagram' ? 'Instagram Direct' : 'Messenger'} conversation with the chosen ${platform === 'instagram' ? 'Instagram account' : 'Facebook Page'}`, answer.words)
        const found = rowsOf(answer.body).find((r) => { const people = rowsOf(r.participants).map((p) => idOf(p.id)); return people.includes(inner.id) && !!business && people.includes(business) })
        if (!found) return refuse(`inside this change, the person has no ${platform === 'instagram' ? 'Instagram Direct' : 'Messenger'} conversation with the chosen ${platform === 'instagram' ? 'Instagram account' : 'Facebook Page'} that Meta answers: Nexus writes only to a person who wrote to the business first.`)
        conversationId = idOf(found.id)
        continue
      }
      case 'messagecomment': {
        const problem = await metaCommentOwnerProblem(connectionId, { ...write, objectId: inner.id, ids: undefined, kinds: [platform === 'instagram' ? 'igcomment' : 'fbcomment'] }, platform === 'instagram' ? 'igcomment' : 'fbcomment', read)
        if (problem) return inside(problem)
        continue
      }
      case 'visitorpost': {
        if (platform !== 'messenger' || !new RegExp(`^${pageId}_\\d{1,25}$`).test(inner.id)) return notChosen(`inside this change, ${inner.id} is not a post on the Facebook Page this business chose.`)
        const answer = await read(inner.id, { fields: 'id,from{id}' })
        if (!answer.body) return unconfirmed(`Nexus could not read post ${inner.id} of the chosen Page`, answer.words)
        if (idOf(answer.body.id) !== inner.id) return unconfirmed(`Meta answered another object than post ${inner.id}`, null)
        if (idOf(obj(answer.body.from)?.id) === pageId) return refuse(`inside this change, post ${inner.id} was written by the chosen Page itself: a private reply goes to a person's visitor post or comment.`)
        continue
      }
      case 'messagepersona': {
        if (platform !== 'messenger') return refuse('inside this change, a persona is a Messenger one (Meta has no personas for Instagram Direct).')
        const problem = await inList(read, `${pageId}/personas`, inner.id, 'the chosen Page\'s personas')
        if (problem) return inside(problem)
        continue
      }
      case 'messageleadform': {
        const { metaLeadFormOfPageProblem } = await import('./meta-page-owner.js')
        const problem = await metaLeadFormOfPageProblem(inner.id, pageId, read)
        if (problem) return inside(problem)
        continue
      }
      case 'pageapp': {
        if (inner.id === META_PAGE_INBOX_APP || inner.id === META_INSTAGRAM_INBOX_APP) continue
        const problem = await inList(read, `${pageId}/subscribed_apps`, inner.id, 'the apps installed on the chosen Page')
        if (problem) return inside(problem)
        continue
      }
      case 'threadmessage': {
        if (!conversationId) return refuse('inside this change, a message id goes with the person of the same conversation.')
        const answer = await read(`${conversationId}/messages`, { fields: 'id', limit: '20' })
        if (!answer.body) return unconfirmed('Nexus could not read the conversation\'s newest messages to confirm the message is one of them', answer.words)
        if (!rowsOf(answer.body).some((r) => idOf(r.id) === inner.id)) return refuse('inside this change, that message is not one of the 20 newest of this conversation (Meta answers no older one).')
        continue
      }
      case 'creator': {
        if (platform !== 'instagram' || !instagramId) return refuse('inside this change, a creator is messaged on Instagram only.')
        const username = parent?.kind === 'creator' && /^[A-Za-z0-9._]{1,30}$/.test(parent.id) ? parent.id : null
        if (!username) return refuse('a creator message names the creator (their Instagram username).')
        const answer = await read(`${instagramId}/creator_marketplace_creators`, { username, fields: 'id,page_id,messaging_id' })
        if (!answer.body) return unconfirmed(`Nexus could not read the creator @${username} from Meta's creator marketplace`, answer.words)
        const creator = rowsOf(answer.body).find((r) => idOf(r.messaging_id) === inner.id)
        if (!creator) return refuse(`inside this change, ${inner.id} is not the messaging id Meta's creator marketplace answers for @${username} (Meta gives none for a creator who is not onboarded, has more than 250,000 followers or opted out).`)
        const creatorId = idOf(creator.id)
        const creatorPage = idOf(creator.page_id)
        if ((creatorId && await metaLinkTaken('INSTAGRAM', creatorId)) || (creatorPage && await metaLinkTaken('PAGE', creatorPage))) return refuse('inside this change, that creator is an Instagram account or Page another business in Nexus uses: Nexus never messages it.')
        continue
      }
      case 'pagetemplate': {
        const name = new URLSearchParams(write.body).get('name')
        const list = await listed(read, `${pageId}/message_templates`, {}, 'id,name')
        if (!list) return unconfirmed('Nexus could not read the chosen Page\'s utility templates', null)
        const row = list.rows.find((r) => idOf(r.id) === inner.id)
        if (!row) return list.more ? unconfirmed(`template ${inner.id} is not among the first 500 of the chosen Page's templates`, null) : notChosen(`inside this change, template ${inner.id} is not one of the chosen Page's.`)
        if (row.name !== name) return refuse(`inside this change, template ${inner.id} is named "${String(row.name)}", not "${name}".`)
        continue
      }
      case 'welcomeflow': {
        const answer = await read(`${pageId}/welcome_message_flows`, { flow_id: inner.id, fields: 'id,is_used_in_ad' })
        if (!answer.body) return unconfirmed(`Nexus could not read welcome flow ${inner.id} of the chosen Page`, answer.words)
        const flow = rowsOf(answer.body).find((r) => idOf(r.id) === inner.id)
        if (!flow) return notChosen(`inside this change, ${inner.id} is not a welcome flow of the chosen Page that Meta answers.`)
        if (flow.is_used_in_ad === true) return refuse(`inside this change, welcome flow ${inner.id} is used in an ad: Meta lets no one change or delete it then.`)
        continue
      }
      default:
        return refuse('this change names an id inside its body that Nexus does not check.')
    }
  }
  return null
}

/**
 * Why this WhatsApp template or template-group change is refused for this connection, or null: the account must be one the
 * chosen ad account's OWN portfolio owns and no other Nexus business shares; every template it names one of that account's.
 */
export async function metaWhatsAppOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string, read: MetaCheckRead): Promise<Problem> {
  const id = write.objectId
  if (!META_WHATSAPP_KINDS.has(kind) || !(write.kinds as readonly string[] | undefined)?.includes(kind)) return refuse(`a WhatsApp change names the kind of object it changes (the WhatsApp account, a template group of it), and ${id} is not named so.`)
  if (write.auth) return refuse('a WhatsApp template change goes with the business\'s system-user token only.')
  const portfolio = await metaChosenPortfolioOf(connectionId)
  if (!portfolio) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOT_SENT} the chosen ad account names no Meta business portfolio, so Nexus can confirm no WhatsApp account as this business's.` }
  if (await metaPortfolioShared(portfolio)) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOT_SENT} another business in Nexus uses an ad account of this Meta business portfolio, so its WhatsApp accounts are not changed here (they could be that business's).` }
  const accounts = await listed(read, `${portfolio}/owned_whatsapp_business_accounts`)
  if (!accounts) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOT_SENT} Nexus could not read the WhatsApp accounts the chosen ad account's portfolio owns (Meta lists them only to an admin system user with business_management).` }
  const own = new Set(accounts.rows.map((r) => idOf(r.id)).filter((x): x is string => !!x))
  let waba: string
  if (kind === 'waba') {
    if (!own.has(id)) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOT_SENT} ${id} is not a WhatsApp account the chosen ad account's business portfolio owns.` }
    waba = id
  } else {
    const group = await read(id, { fields: 'id,whatsapp_business_account{id}' })
    if (!group.body) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOT_SENT} Nexus could not read template group ${id}${meta(group.words)}.` }
    const owner = idOf(obj(group.body.whatsapp_business_account)?.id)
    if (idOf(group.body.id) !== id || !owner || !own.has(owner)) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOT_SENT} template group ${id} is not one of a WhatsApp account the chosen ad account's business portfolio owns.` }
    waba = owner
  }
  const inner = write.ids ?? []
  if (inner.length > 200) return refuse('a WhatsApp change names at most 200 templates inside its body.')
  if (!inner.length) return null
  if (inner.some((x) => x.kind !== 'wabatemplate' || !PAGE_ID.test(x.id))) return refuse('this change names an id inside its body that Nexus does not check.')
  // `summary` makes this read the WhatsApp account's (a Page-shaped template read goes with the chosen Page's token only).
  const templates = await listed(read, `${waba}/message_templates`, { summary: 'total_count' })
  if (!templates) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOT_SENT} Nexus could not read the WhatsApp account's templates to confirm the ones this change names.` }
  const ownTemplates = new Set(templates.rows.map((r) => idOf(r.id)))
  const foreign = inner.find((x) => !ownTemplates.has(x.id))
  if (foreign) {
    return templates.more
      ? { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOT_SENT} template ${foreign.id} is not among the WhatsApp account's first 500 templates, so Nexus could not confirm it is one of them.` }
      : { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOT_SENT} inside this change, template ${foreign.id} is not one of this WhatsApp account's templates.` }
  }
  return null
}
