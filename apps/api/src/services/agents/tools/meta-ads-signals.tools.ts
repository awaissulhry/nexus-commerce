/**
 * Meta ads changes, step 32 (2026-10-21) — datasets (pixels), custom conversions and event setup on the business's chosen
 * Meta ad account and its business portfolio:
 *   create-meta-dataset        a dataset on the chosen ad account (one per account), in the business portfolio (Meta's SDK
 *                              route), or for the chosen Page's / Instagram account's conversations — SG-006 … SG-009
 *   set-meta-dataset           a dataset's name, automatic advanced matching, first-party cookies, data use; an event source
 *                              group (create, change, share with the chosen ad account); traffic permissions answer that Meta
 *                              cannot — BM-057, SG-010 … SG-013, SG-041
 *   set-meta-dataset-access    connect / disconnect the chosen ad account, share with / remove a partner portfolio, give one
 *                              of the portfolio's own people tasks, the businesses that may send its server events —
 *                              SG-014, SG-018, SG-019, SG-021, SG-022, SG-024
 *   set-meta-custom-conversion create (≤ 100 per ad account, counted first; its rule fixed for good), rename / describe /
 *                              default value, claim into the portfolio — SG-090 … SG-092, SG-094 (SG-091: the ad account
 *                              route, Meta documents no business-level create)
 *   set-meta-event-setup       READ ONLY: Meta's public API cannot create, change or delete event rules or parameter
 *                              extractors — it reads what is set up and says where it is done — SG-098, SG-099, SG-102, SG-103
 *   remove-meta-signal-items   delete custom conversions Nexus made (explicit ask); event rules and parameter extractors
 *                              answer that Meta cannot — SG-093, SG-100, SG-104
 * Each change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person approves it,
 * it runs as that person, and undo puts back what it replaced (or says what has no way back on Meta). A pixel another
 * business in Nexus uses, or one Nexus cannot check (step 11's verdict), is never changed; nothing goes to another Nexus
 * business's ad account, portfolio or people (marketing/meta-ads/signals-rule.ts; the gateway asks the same again).
 * Meta's own Ads MCP server has no dataset create or settings, no custom conversion create and no access tools at all;
 * its event-setup writes (ads_pixel_event_* / ads_pixel_parameter_*) run on Meta's side, without a preview or an approval.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder, type MetaRunOutcome } from './meta-ads-kit.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import type { MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import type { MetaChangeDraft } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { datasetsView } from '../../marketing/meta-ads/live-datasets.js'
import { chosenPixelIds } from '../../marketing/meta-ads/live-audiences.js'
import { connectablePixel, ownConversion, ownGroup, ownMessagingAccount, ownPartner, ownPerson, ownPortfolio, ownSignalPixel } from '../../marketing/meta-ads/signals-rule.js'
import { adSetsUsing, liveAdSetsUsing, livePromotedAdSets, liveConversion, liveConversions, livePixelConnected, livePixelPartners, livePixelPersonTasks, livePixelSettings, liveServerEventBusinesses } from '../../marketing/meta-ads/live-signals.js'
import {
  accessDraft, conversionClaimDraft, conversionCreateDraft, conversionUpdateDraft, datasetCreateDraft, EVENT_SETUP_CANNOT, groupDraft, jsonList, pixelSettingsDraft, removeDraft,
  signalView, TRAFFIC_PERMISSIONS_CANNOT, type AccessAction, type SignalItemKind, type SignalsRecord,
} from '../../marketing/meta-ads/change-signals.js'
import {
  AUTOMATIC_MATCHING_FIELDS, CONVERSION_ACTION_SOURCES, CONVERSION_EVENT_TYPES, conversionRuleProblem, DATA_USE_SETTINGS, FIRST_PARTY_COOKIE_STATUSES, MAX_GROUP_SOURCES, MAX_SERVER_EVENT_BUSINESSES,
  PARTNER_TASKS, PERSON_TASKS,
} from '../../gateway/meta-signals-rules.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from '../../gateway/meta-settings-rules.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys: a custom conversion's default value appears in its lines, sentences and steps. */
const CONVERSION_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, skipped: ADSPEND, steps: ADSPEND, fields: ADSPEND } as const

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Text a person types (the gateway's own patterns, meta-settings-rules.ts): any script, no control or format character. */
const typedText = (max: number, pattern: RegExp) => z.string().trim().min(1).max(max).regex(pattern, 'no control or format characters')
const idList = (what: string, max: number) => z.array(z.string().trim().regex(/^\d{1,20}$/, 'a Meta id is digits only')).max(max).describe(what)
const pixelArg = metaIdArg('the dataset (pixel) of the chosen ad account — meta-datasets view list')

// ── shared: the chosen account as step 11 reads it, refusals in words ─────────────────────────────────────────────

/** The chosen ad account as step 11's reads and the verdict take it (the same one the kit's account names). */
async function chosenFor(account: MetaChangeAccount): Promise<MetaChosenAccount> {
  const chosen = await metaChosenAccount(account.accountId)
  if (chosen.adAccountId !== account.adAccountId) throw new MetaLiveRefusal('The business\'s chosen Meta ad account changed while this was built; ask again.')
  return chosen
}

/** A builder that turns a refusal of the live reads or of the ownership rule into words. */
const guarded = (build: (chosen: MetaChosenAccount, account: MetaChangeAccount) => Promise<MetaChangeDraft | { refusal: string }>): MetaDraftBuilder => async (account) => {
  try {
    return await build(await chosenFor(account), account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

type Done = Array<{ request: MetaChangeDraft['requests'][number]; result: MetaChangeResult }>
const idOfNode = (node: Record<string, unknown> | null | undefined): string | null => (node && (typeof node.id === 'string' || typeof node.id === 'number') && /^\d{1,25}$/.test(String(node.id)) ? String(node.id) : null)

/**
 * The run's record: what the change replaced and what Meta read back for what it wrote (a field not read back: as sent);
 * a create records the id Meta answered (and `exists`: undo reads whether it still does).
 */
function signalsFinish(draft: MetaChangeDraft, done: Done, decorate?: (before: SignalsRecord, after: SignalsRecord, node: Record<string, unknown> | null) => void): MetaRunOutcome {
  const before = { ...(draft.before as SignalsRecord) }
  const planned = draft.after as SignalsRecord
  const node = done[0]?.result.node ?? null
  const fields = { ...planned.fields }
  if (!planned.created && node) for (const f of Object.keys(fields)) if (f in node) fields[f] = signalView(node[f])
  const createdId = planned.created ? idOfNode(node) : null
  const after: SignalsRecord = { ...planned, ...(createdId ? { id: createdId } : {}), fields: planned.created ? { ...fields, exists: createdId ? 'yes' : null } : fields }
  decorate?.(before, after, node)
  const pending = node && typeof node.pending_request_id === 'string'
  return {
    data: {
      id: after.id || null, fields: after.fields,
      ...(pending ? { pending: 'Meta made a sharing request: the partner sees the dataset once its business accepts it in Meta\'s business settings.' } : {}),
      ...(before.noUndo?.length ? { noUndo: before.noUndo } : {}),
    },
    before, after,
  }
}

/** Undo's request: the arguments the record holds for the tool that puts back what the change replaced. */
function recordedUndo(): ToolUndo['request'] {
  return (change: ToolChange) => {
    const before = (change.before ?? {}) as SignalsRecord & { accountId?: string }
    if (!before.undo) return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the change recorded no earlier values.'}` }
    return {
      tool: before.undo.tool,
      args: { ...(before.accountId ? { connectionId: before.accountId } : {}), ...before.undo.args, why: `undo of an earlier Meta change${before.noUndo?.length ? ` (stays as it is: ${before.noUndo.join(' ')})` : ''}`.slice(0, 300) },
    }
  }
}

/** Undo's "now", read in the business the call runs in: null when the account or the object can no longer be read. */
async function readNow(change: ToolChange, read: (chosen: MetaChosenAccount, after: SignalsRecord) => Promise<Record<string, string | null> | null>): Promise<unknown> {
  const after = (change.after ?? {}) as SignalsRecord & { accountId?: string; adAccountId?: string }
  // Nothing recorded to put back: no read (undo's request says why in words, not "it changed since").
  if (!((change.before ?? {}) as SignalsRecord).undo) return change.after
  const account = await recordAccount(after)
  if (!account) return null
  try {
    const chosen = await chosenFor(account)
    const fields = await read(chosen, after)
    return fields ? { ...after, fields } : null
  } catch (err) {
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
    throw err
  }
}

/** Where Nexus shows the change now (the kit's "meta-ads-live" sentence is about campaigns, ad sets and ads). */
const shows = (view: string) => async () => `meta-datasets ${view} shows it now (read live from Meta).`

const changeTool = {
  category: 'advertising' as const,
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

// ── create-meta-dataset ─────────────────────────────────────────────────────────────────────────────────────────

const LEVELS = ['adAccount', 'business', 'page', 'instagram'] as const

const buildDataset = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (chosen) => {
  const level = (args.level ?? 'adAccount') as (typeof LEVELS)[number]
  const name = String(args.name)
  if (level === 'adAccount') return datasetCreateDraft({ level, name }, { adAccountId: chosen.adAccountId, existing: await chosenPixelIds(chosen) })
  if (level === 'business') return datasetCreateDraft({ level, name }, { adAccountId: chosen.adAccountId, objectId: await ownPortfolio(chosen) })
  const id = (level === 'page' ? chosen.pageId : chosen.instagramId) ?? ''
  return datasetCreateDraft({ level, name }, { adAccountId: chosen.adAccountId, objectId: await ownMessagingAccount(chosen, level, id) })
})

const createMetaDataset: AgentTool = {
  name: 'create-meta-dataset',
  title: 'Create a Meta dataset (pixel)',
  ...changeTool,
  // A dataset cannot be deleted through Meta's API (ads-pixel reference: no delete; master SG-017).
  reversibility: 'none',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    level: z.enum(LEVELS).default('adAccount').describe('where Meta makes it: adAccount (default — the chosen ad account; Meta makes ONE there), business (the chosen ad account\'s business portfolio — Meta\'s SDK route, for a second dataset), page / instagram (the chosen Page\'s or Instagram account\'s conversations; needs Meta\'s page_events / instagram_manage_events after App Review)'),
    name: typedText(100, META_NAME_TEXT).describe('its name (as it shows in Events Manager)'),
    why: metaWhyArg,
  }),
  description:
    'Create a dataset (Meta pixel) for this business, only on the person\'s ask. level adAccount (default): on the chosen ad '
    + 'account — Meta makes one pixel per ad account and refuses a second (6200), so the preview refuses when the account '
    + 'already has one (often made by the shop platform\'s Meta app). business: in the chosen ad account\'s business '
    + 'portfolio (Meta documents it only in its SDK: its answer decides; a business admin accepts Meta\'s Business Tools '
    + 'terms first; connect it to the ad account after with set-meta-dataset-access) — never in a portfolio another '
    + 'business in Nexus also uses. page / instagram: a dataset for the chosen Page\'s or Instagram account\'s conversations '
    + '(Conversions API for business messaging; Meta answers the existing one if there is one, and needs page_events / '
    + 'instagram_manage_events, Advanced access). One request; it spends nothing. NO undo: Meta has no delete for a '
    + 'dataset. Meta has no check for this create (validate_only is not documented on it).'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildDataset(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildDataset(args), (draft, done) => signalsFinish(draft, done), shows('view list (or view portfolio)')),
}

// ── set-meta-dataset ────────────────────────────────────────────────────────────────────────────────────────────

const PIXEL_KEYS = ['name', 'automaticMatching', 'firstPartyCookieStatus', 'dataUse'] as const

const buildDatasetSettings = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (chosen) => {
  if (args.trafficPermissions !== undefined) return { refusal: TRAFFIC_PERMISSIONS_CANNOT }
  const group = args.eventSourceGroup as { action: 'create' | 'update' | 'share'; groupId?: string; name?: string; pixelIds?: string[] } | undefined
  const pixelParts = PIXEL_KEYS.filter((k) => args[k] !== undefined)
  if (group && (pixelParts.length || args.pixelId)) return { refusal: 'One change at a time: a dataset\'s settings (pixelId and its settings) or an event source group (eventSourceGroup), not both.' }
  if (group) {
    const portfolio = await ownPortfolio(chosen)
    if (group.action === 'create') {
      for (const id of group.pixelIds ?? []) await ownSignalPixel(chosen, id)
      return groupDraft(group, { portfolio, adAccountId: chosen.adAccountId })
    }
    if (!group.groupId) return { refusal: 'Name the event source group (eventSourceGroup.groupId).' }
    const found = await ownGroup(chosen, group.groupId, portfolio)
    if (group.action === 'update') for (const id of group.pixelIds ?? []) await ownSignalPixel(chosen, id)
    return groupDraft(group, { portfolio, adAccountId: chosen.adAccountId, group: found })
  }
  if (!args.pixelId) return { refusal: 'Name the dataset (pixelId from meta-datasets view list) and what to change.' }
  const pixelId = await ownSignalPixel(chosen, String(args.pixelId))
  const settings = await livePixelSettings(chosen, pixelId)
  // Data use moves which ad sets get the dataset's events: they are listed (away) or SPENDS MONEY (back).
  const adSetsUsing = args.dataUse !== undefined ? await liveAdSetsUsing(chosen, { pixelId }) : { adSets: [], more: false }
  return pixelSettingsDraft({
    pixelId,
    name: args.name as string | undefined,
    automaticMatching: args.automaticMatching as { enabled: boolean; fields?: string[] } | undefined,
    firstPartyCookieStatus: args.firstPartyCookieStatus as string | undefined,
    dataUse: args.dataUse as string | undefined,
  }, { settings, adSetsUsing })
})

const datasetUndo: ToolUndo = {
  current: (change) => readNow(change, async (chosen, after) => {
    if (after.part === 'pixel') {
      await ownSignalPixel(chosen, after.id)
      const s = await livePixelSettings(chosen, after.id)
      const live: Record<string, unknown> = {
        name: s.name, enable_automatic_matching: s.enableAutomaticMatching, automatic_matching_fields: s.automaticMatchingFields,
        first_party_cookie_status: s.firstPartyCookieStatus, data_use_setting: s.dataUseSetting,
      }
      return Object.fromEntries(Object.keys(after.fields).map((f) => [f, signalView(live[f])]))
    }
    if (after.part === 'group' && after.id) {
      const group = await ownGroup(chosen, after.id, await ownPortfolio(chosen))
      const live: Record<string, unknown> = { name: group.name, event_sources: group.pixelIds }
      return Object.fromEntries(Object.keys(after.fields).map((f) => [f, f in live ? signalView(live[f]) : after.fields[f]]))
    }
    return null
  }),
  request: recordedUndo(),
}

const setMetaDataset: AgentTool = {
  name: 'set-meta-dataset',
  title: 'Change a Meta dataset\'s settings',
  ...changeTool,
  // A pixel's settings and a group's change are put back by undo; a new group and a group's sharing cannot be (Meta).
  reversibility: 'partial',
  consequencesFor: (args) => {
    const group = args.eventSourceGroup as { action?: string } | undefined
    return group && (group.action === 'create' || group.action === 'share') ? { reversibility: 'none' } : null
  },
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    pixelId: pixelArg.optional(),
    name: typedText(100, META_NAME_TEXT).optional().describe('the dataset\'s new name'),
    automaticMatching: z.object({
      enabled: z.boolean().describe('automatic advanced matching on (true) or off (false)'),
      fields: z.array(z.enum(AUTOMATIC_MATCHING_FIELDS)).min(1).max(AUTOMATIC_MATCHING_FIELDS.length).optional().describe('with enabled true: the shopper details Meta may match on (em e-mail, ph phone, fn / ln names, ge, db birth date, ct, st, zp, country, external_id)'),
    }).optional().describe('automatic advanced matching: Meta hashes what shoppers type into the shop\'s forms in their browser (a GDPR decision; the shop platform\'s Meta app may manage it too)'),
    firstPartyCookieStatus: z.enum(FIRST_PARTY_COOKIE_STATUSES).optional().describe('first-party cookies: FIRST_PARTY_COOKIE_ENABLED, FIRST_PARTY_COOKIE_DISABLED (fewer matches), EMPTY (not set)'),
    dataUse: z.enum(DATA_USE_SETTINGS).optional().describe('ADVERTISING_AND_ANALYTICS, ANALYTICS_ONLY (Meta stops using its events for ads — the preview lists the ad sets that lose them) or EMPTY (not set)'),
    trafficPermissions: z.object({
      allowDomains: z.array(z.string().trim().min(1).max(253)).max(50).optional().describe('domains the dataset accepts events from'),
      blockDomains: z.array(z.string().trim().min(1).max(253)).max(50).optional().describe('domains it blocks'),
    }).optional().describe('traffic permissions — Meta cannot change them by API: the answer says where a person does it'),
    eventSourceGroup: z.object({
      action: z.enum(['create', 'update', 'share']).describe('create a group in the business portfolio, update one (name, datasets), or share one with the chosen ad account'),
      groupId: metaIdArg('the event source group (update, share)').optional(),
      name: typedText(100, META_NAME_TEXT).optional().describe('its name (create; update: a new name)'),
      pixelIds: idList(`its datasets, each a pixel of the chosen ad account (create; update: the full new list; at most ${MAX_GROUP_SOURCES})`, MAX_GROUP_SOURCES).optional(),
    }).optional().describe('an event source group (used by travel and claim audiences): instead of a dataset\'s settings'),
    why: metaWhyArg,
  }),
  description:
    'Change ONE dataset (pixel) of the chosen ad account that no other business in Nexus uses (pixelId; meta-datasets '
    + 'view list): its name, automatic advanced matching (on / off and which shopper details — a GDPR decision; the shop '
    + 'platform\'s Meta app may set it back), first-party cookies, data use (ANALYTICS_ONLY stops Meta using its events '
    + 'for ads: the preview lists the ad sets that lose them; back to ads is SPENDS MONEY when ad sets optimise on it — '
    + 'they deliver on it again). Or an event source group of the chosen ad account\'s '
    + 'business portfolio (eventSourceGroup): create one from the account\'s datasets, change its name or datasets, share '
    + 'it with the chosen ad account (Meta\'s SDK only for the change and the sharing; no way back for a new group or a '
    + 'share). Traffic permissions (allowed / blocked domains): Meta cannot change them by API — the answer says where a '
    + 'person does it. One request. Undo puts back the settings it replaced. Meta has no check for '
    + 'these changes.'
    + META_CHANGE_RULES,
  undo: datasetUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildDatasetSettings(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildDatasetSettings(args), (draft, done) => signalsFinish(draft, done), shows('view detail')),
}

// ── set-meta-dataset-access ─────────────────────────────────────────────────────────────────────────────────────

const ACCESS_ACTIONS = ['connect-ad-account', 'disconnect-ad-account', 'share-with-partner', 'remove-partner', 'assign-person', 'server-event-partners'] as const

const buildAccess = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (chosen) => {
  const action = args.action as AccessAction
  const req = {
    pixelId: String(args.pixelId), action,
    partnerBusinessId: args.partnerBusinessId as string | undefined, partnerTasks: args.partnerTasks as string[] | undefined,
    personId: args.personId as string | undefined, personTasks: args.personTasks as string[] | undefined,
    serverEventBusinessIds: args.serverEventBusinessIds as string[] | undefined,
  }
  const portfolio = await ownPortfolio(chosen)
  const pixelId = action === 'connect-ad-account' ? (await connectablePixel(chosen, req.pixelId)).pixelId : await ownSignalPixel(chosen, req.pixelId)
  const settings = await livePixelSettings(chosen, pixelId)
  const facts = { pixelId, pixelName: settings.name, adAccountId: chosen.adAccountId, portfolio, ownerBusinessId: settings.ownerBusinessId }
  switch (action) {
    case 'connect-ad-account':
      return accessDraft(req, { ...facts, connected: await livePixelConnected(chosen, pixelId, portfolio), adSetsUsing: await liveAdSetsUsing(chosen, { pixelId }) })
    case 'disconnect-ad-account':
      return accessDraft(req, { ...facts, connected: await livePixelConnected(chosen, pixelId, portfolio), adSetsUsing: await liveAdSetsUsing(chosen, { pixelId }) })
    case 'share-with-partner':
    case 'remove-partner': {
      if (req.partnerBusinessId) req.partnerBusinessId = await ownPartner(req.partnerBusinessId, portfolio)
      return accessDraft(req, { ...facts, partners: await livePixelPartners(chosen, pixelId) })
    }
    case 'assign-person': {
      if (req.personId) req.personId = await ownPerson(chosen, req.personId, portfolio)
      return accessDraft(req, { ...facts, personTasks: req.personId ? await livePixelPersonTasks(chosen, pixelId, portfolio, req.personId) : undefined })
    }
    case 'server-event-partners': {
      for (const id of req.serverEventBusinessIds ?? []) await ownPartner(id, portfolio)
      return accessDraft(req, { ...facts, serverEventBusinesses: await liveServerEventBusinesses(chosen, pixelId) })
    }
  }
})

const accessUndo: ToolUndo = {
  current: (change) => readNow(change, async (chosen, after) => {
    const portfolio = await ownPortfolio(chosen)
    const field = Object.keys(after.fields)[0]
    if (field === 'connected') {
      await connectablePixel(chosen, after.id)
      const connected = await livePixelConnected(chosen, after.id, portfolio)
      return connected === null ? null : { connected: connected ? 'yes' : 'no' }
    }
    await ownSignalPixel(chosen, after.id)
    if (field === 'partner') {
      const partners = await livePixelPartners(chosen, after.id)
      const partner = ((change.before ?? {}) as SignalsRecord).undo?.args.partnerBusinessId
      if (!partners || typeof partner !== 'string') return null
      return { partner: partners.includes(partner) ? 'yes' : after.fields.partner === 'pending' ? 'pending' : 'no' }
    }
    if (field === 'tasks') {
      const person = ((change.before ?? {}) as SignalsRecord).undo?.args.personId
      if (typeof person !== 'string') return null
      const tasks = await livePixelPersonTasks(chosen, after.id, portfolio, person)
      return tasks === undefined ? null : { tasks: tasks ? jsonList(tasks) : null }
    }
    if (field === 'server_events_business_ids') {
      const ids = await liveServerEventBusinesses(chosen, after.id)
      return ids ? { server_events_business_ids: jsonList(ids) } : null
    }
    return null
  }),
  request: recordedUndo(),
}

const setMetaDatasetAccess: AgentTool = {
  name: 'set-meta-dataset-access',
  title: 'Who may use a Meta dataset',
  ...changeTool,
  reversibility: 'partial',
  // Removing a partner has no way back here (sharing again is a new share the partner may have to accept).
  consequencesFor: (args) => (args.action === 'remove-partner' ? { reversibility: 'none' } : null),
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    pixelId: pixelArg,
    action: z.enum(ACCESS_ACTIONS).describe('connect-ad-account / disconnect-ad-account (the CHOSEN ad account only), share-with-partner / remove-partner (a partner business portfolio), assign-person (one of the portfolio\'s own people or system users), server-event-partners (the portfolios that may send its server events)'),
    partnerBusinessId: metaIdArg('the partner business portfolio (share-with-partner, remove-partner) — never one another business in Nexus uses').optional(),
    partnerTasks: z.array(z.enum(PARTNER_TASKS)).min(1).max(PARTNER_TASKS.length).optional().describe('share-with-partner: what it may do — ADVERTISE (use it in its ads), ANALYZE, UPLOAD (send events), EDIT (change its settings; Meta limits it)'),
    personId: metaIdArg('assign-person: the person (business-scoped id) or system user of the chosen ad account\'s business portfolio').optional(),
    personTasks: z.array(z.enum(PERSON_TASKS)).min(1).max(PERSON_TASKS.length).optional().describe('assign-person: ADVERTISE, ANALYZE, UPLOAD, EDIT, AA_ANALYZE'),
    serverEventBusinessIds: idList(`server-event-partners: the FULL list of business portfolios that may send this dataset's server events after the change ([] for none; at most ${MAX_SERVER_EVENT_BUSINESSES})`, MAX_SERVER_EVENT_BUSINESSES).optional(),
    why: metaWhyArg,
  }),
  description:
    'Change who may use ONE dataset (pixel) of the chosen ad account that no other business in Nexus uses: connect it to '
    + 'the chosen ad account (also a dataset its business portfolio owns that is not on the account yet) or disconnect it '
    + '(the preview lists the ad sets that optimise on it and lose its events; connecting is SPENDS MONEY when ad sets of '
    + 'the account optimise on it — they deliver on it again); share it with a partner business portfolio '
    + '(an agency: ADVERTISE, ANALYZE, UPLOAD, EDIT; the partner may have to accept) or remove a partner (Meta asks a '
    + 'business admin\'s own token for that and may refuse the system user); give one of the portfolio\'s own people or '
    + 'system users tasks on it; set the business portfolios that may send its server events. Never another ad account, '
    + 'and never an ad account, portfolio or person of another business in Nexus. One request. Undo puts '
    + 'back what it replaced where Meta has a way (no removal of a person or a partner\'s old tasks by API: said). Meta has '
    + 'no check for these changes.'
    + META_CHANGE_RULES,
  undo: accessUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildAccess(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildAccess(args), (draft, done) => signalsFinish(draft, done, (_before, after, node) => {
    if ('partner' in after.fields && after.fields.partner === 'yes' && node && typeof node.pending_request_id === 'string') after.fields.partner = 'pending'
  }), shows('view access')),
}

// ── set-meta-custom-conversion ──────────────────────────────────────────────────────────────────────────────────

/** A custom conversion's rule: one JSON object, judged whole by the gateway's own rule (meta-signals-rules.ts). */
const ruleSchema = z.record(z.string().max(40), z.unknown()).superRefine((rule, ctx) => {
  const problem = conversionRuleProblem(rule)
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
})

const buildConversion = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (chosen) => {
  const action = (args.action ?? 'create') as 'create' | 'update' | 'claim'
  if (action === 'create') {
    for (const k of ['name', 'pixelId', 'rule', 'eventType'] as const) if (args[k] === undefined) return { refusal: 'A new custom conversion needs its name, its dataset (pixelId), its rule and its event type (eventType).' }
    const pixelId = await ownSignalPixel(chosen, String(args.pixelId))
    const [{ rows, complete }, settings] = await Promise.all([liveConversions(chosen), livePixelSettings(chosen, pixelId)])
    return conversionCreateDraft({
      name: String(args.name), pixelId, rule: args.rule, eventType: String(args.eventType),
      defaultValueCents: args.defaultValueCents as number | undefined, description: args.description as string | undefined, actionSource: args.actionSource as string | undefined,
    }, { adAccountId: chosen.adAccountId, currency: chosen.currency, conversions: rows, complete, pixelName: settings.name })
  }
  if (!args.customConversionId) return { refusal: 'Name the custom conversion (customConversionId from meta-datasets view custom-conversions).' }
  const { id } = await ownConversion(chosen, String(args.customConversionId))
  const row = await liveConversion(chosen, id)
  if (action === 'claim') return conversionClaimDraft({ row, portfolio: await ownPortfolio(chosen) })
  const adSetsUsing = args.defaultValueCents !== undefined ? await liveAdSetsUsing(chosen, { customConversionId: id }) : { adSets: [], more: false }
  return conversionUpdateDraft({ customConversionId: id, name: args.name as string | undefined, description: args.description as string | undefined, defaultValueCents: args.defaultValueCents as number | undefined }, { row, currency: chosen.currency, adSetsUsing })
})

const conversionUndo: ToolUndo = {
  current: (change) => readNow(change, async (chosen, after) => {
    if (!after.id) return null
    if (after.created) {
      // A custom conversion this change made: does it still exist (deleted since: nothing to undo)?
      try { await ownConversion(chosen, after.id) } catch (err) { if (err instanceof MetaReadError && err.failure.notFound) return { ...after.fields, exists: null }; throw err }
      return { ...after.fields, exists: 'yes' }
    }
    if ('claimed' in after.fields) return { ...after.fields }
    await ownConversion(chosen, after.id)
    const row = await liveConversion(chosen, after.id)
    const live: Record<string, unknown> = { name: row.name, description: row.description, default_conversion_value: row.defaultValue }
    return Object.fromEntries(Object.keys(after.fields).map((f) => [f, signalView(live[f])]))
  }),
  request: recordedUndo(),
}

const setMetaCustomConversion: AgentTool = {
  name: 'set-meta-custom-conversion',
  title: 'Create or change a custom conversion',
  ...changeTool,
  reversibility: 'partial',
  // A claim into the portfolio has no way back (no unclaim edge).
  consequencesFor: (args) => (args.action === 'claim' ? { reversibility: 'none' } : null),
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: CONVERSION_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(['create', 'update', 'claim']).default('create').describe('create (default) a custom conversion on the chosen ad account; update one\'s name, description or default value; claim one into the business portfolio'),
    customConversionId: metaIdArg('update, claim: the custom conversion of the chosen ad account (meta-datasets view custom-conversions)').optional(),
    name: typedText(100, META_NAME_TEXT).optional().describe('create: its name; update: a new name'),
    pixelId: pixelArg.optional().describe('create: the dataset (pixel) whose events it counts — one of the chosen ad account\'s that no other business in Nexus uses'),
    rule: ruleSchema.optional().describe('create: which events count (fixed for good once made) — Meta\'s rule as JSON: {"and"|"or": [rules]} or {"url"|"event"|"<custom-data key>": {"<operator>": value}}; operators i_contains, i_not_contains, contains, not_contains, eq, neq, lt, lte, gt, gte (numbers), regex_match; at most 3 levels and 10 conditions. E.g. {"or":[{"url":{"i_contains":"thank-you"}}]} or {"and":[{"event":{"eq":"Purchase"}},{"value":{"gt":100}}]}'),
    eventType: z.enum(CONVERSION_EVENT_TYPES).optional().describe('create: the standard event it counts as (PURCHASE, LEAD, ADD_TO_CART, … OTHER)'),
    defaultValueCents: z.number().int().min(0).max(100_000_000).optional().describe('create / update: the value of one conversion when its event carries none, in minor units of the ad account currency (cents for EUR) — what value-based bidding counts'),
    description: typedText(500, META_STRICT_TEXT).optional().describe('create / update: its description'),
    actionSource: z.enum(CONVERSION_ACTION_SOURCES).optional().describe('create: where its events happen (website, app, physical_store, …; Meta\'s SDK)'),
    why: metaWhyArg,
  }),
  description:
    'Custom conversions of the business\'s chosen Meta ad account. create: one from a dataset (pixel) of the chosen ad '
    + 'account that no other business in Nexus uses, with a rule on the page address, the event or its custom data (e.g. '
    + 'URL contains "/thank-you", or Purchase with value > 100), its event type, a default value and a description — '
    + 'Meta allows at most 100 per ad account (Nexus counts them first and refuses the 101st), and its RULE CAN NEVER '
    + 'CHANGE after it is made. update: its name, description or default value only (a flagged one Meta refuses). claim: '
    + 'into the chosen ad account\'s business portfolio (no way back). A default-value raise while ad sets optimise on it '
    + 'is SPENDS MONEY (value-based bidding counts each conversion for more; the line says when none of them is on, so '
    + 'nothing spends yet). Amounts in minor units of the account currency. One request. Undo of a create deletes it '
    + '(remove-meta-signal-items, a person approves); of an update puts back what it replaced. Meta has no check for these '
    + 'changes. (Meta documents no business-level create: Nexus makes them on the ad account.)'
    + META_CHANGE_RULES,
  undo: conversionUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildConversion(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildConversion(args), (draft, done) => signalsFinish(draft, done, (before, after) => {
    // A create: its undo deletes exactly the custom conversion it made (remove-meta-signal-items finds it in this record).
    if (after.created && after.id) {
      after.customConversionId = after.id
      before.undo = { tool: 'remove-meta-signal-items', args: { items: [{ kind: 'customConversion', id: after.id }], confirmDelete: true } }
    }
  }), shows('view custom-conversions')),
}

// ── set-meta-event-setup (read only: Meta cannot) ───────────────────────────────────────────────────────────────

const setMetaEventSetup: AgentTool = {
  name: 'set-meta-event-setup',
  title: 'Meta event setup (read only)',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    connectionId: metaConnectionArg,
    pixelId: metaIdArg('the dataset (pixel) of the chosen ad account; default: its only pixel').optional(),
    want: z.enum(['create-rule', 'change-rule', 'delete-rule', 'create-parameter', 'change-parameter', 'delete-parameter']).optional().describe('what the person wanted to do (event rule = an event fired on a button or page; parameter = a value read from the page)'),
    currentDomain: z.string().trim().min(1).max(260).optional().describe('only the parameter extractors of this web address (https://shop.example)'),
  }),
  description:
    'Event setup of a dataset (Meta\'s event setup tool: rules that fire an event on a button or page, and the parameters '
    + 'an event reads from the page). Meta CANNOT change these by API: its public Marketing API reads them but has no '
    + 'create, change or delete (v26 reference ads-pixel/event_rules and ads-pixel/extractors; the SDK has no write). This '
    + 'answers that, shows what is set up now (the chosen ad account\'s pixel that no other business in Nexus uses) and '
    + 'where a person does it (Events Manager › Settings › Event setup tool). To count a page visit or an event with '
    + 'conditions as a conversion, set-meta-custom-conversion does it through Meta\'s API. Read only.',
  async handler(args): Promise<ToolResult> {
    try {
      const setup = await datasetsView({ connectionId: typeof args.connectionId === 'string' ? args.connectionId : null, view: 'event-setup', pixelId: typeof args.pixelId === 'string' ? args.pixelId : null, currentDomain: typeof args.currentDomain === 'string' ? args.currentDomain : null })
      return {
        ok: true,
        data: {
          metaCannot: EVENT_SETUP_CANNOT,
          ...(args.want ? { asked: args.want } : {}),
          instead: 'To count a page visit, a button\'s event or an event with conditions (e.g. Purchase over 100) as its own conversion, set-meta-custom-conversion (create) does it through Meta\'s API from this dataset\'s events.',
          eventSetup: setup,
        },
      }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return { ok: false, error: `${err.message} (${EVENT_SETUP_CANNOT})` }
      throw err
    }
  },
}

// ── remove-meta-signal-items ────────────────────────────────────────────────────────────────────────────────────

/**
 * At most this many items, sized for Meta's Limited access tier (about 60 points per 5 minutes; a read 1, a change 3): each
 * custom conversion is read twice and its dataset checked (about 6 reads, once per dataset) at each of preview, re-check,
 * run and the gateway's own check, the account's ad sets once per build, and each delete is a change.
 */
const MAX_REMOVE = 4

const buildRemove = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (chosen) => {
  if (args.confirmDelete !== true) return { refusal: 'Deleting happens only on the person\'s explicit ask: confirmDelete must be true.' }
  const items = (args.items as Array<{ kind: SignalItemKind; id: string }>) ?? []
  const conversions: Array<{ row: Awaited<ReturnType<typeof liveConversion>>; adSetsUsing: Awaited<ReturnType<typeof liveAdSetsUsing>> }> = []
  const seen = new Set<string>()
  let promoted: Awaited<ReturnType<typeof livePromotedAdSets>> | null = null
  for (const item of items) {
    if (item.kind !== 'customConversion' || seen.has(item.id)) continue
    seen.add(item.id)
    const { id } = await ownConversion(chosen, item.id, { nexusMade: true })
    promoted ??= await livePromotedAdSets(chosen)
    conversions.push({ row: await liveConversion(chosen, id), adSetsUsing: adSetsUsing(promoted, { customConversionId: id }) })
  }
  return removeDraft(items, { conversions })
})

const removeMetaSignalItems: AgentTool = {
  name: 'remove-meta-signal-items',
  title: 'Delete Meta custom conversions',
  ...changeTool,
  // Deleting is final: Meta has no undo, a custom conversion made again gets a new id.
  reversibility: 'none',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    items: z.array(z.object({
      kind: z.enum(['customConversion', 'eventRule', 'parameterExtractor']).describe('customConversion (deleted when Nexus made it), eventRule or parameterExtractor (Meta cannot delete these by API: the answer says so)'),
      id: metaIdArg('its id (meta-datasets view custom-conversions or event-setup)'),
    })).min(1).max(MAX_REMOVE).describe(`what to delete (at most ${MAX_REMOVE})`),
    confirmDelete: z.literal(true).describe('true: the person explicitly asked to delete these, for good'),
    why: metaWhyArg,
  }),
  description:
    'Delete custom conversions of the chosen ad account FOR GOOD, only on the person\'s explicit ask (confirmDelete: '
    + 'true) and only ones Nexus made (set-meta-custom-conversion; its records prove it) whose dataset no other business '
    + 'in Nexus uses. The preview lists the ad sets that optimise on each and lose their conversion event. One request per '
    + 'custom conversion, in order. Event rules and parameter extractors: Meta cannot delete them by API (v26 reference: '
    + '"can\'t perform"; the SDK has no delete) — the answer says where a person does it. NO undo: Meta has none, and one '
    + 'made again gets a new id and no history. Meta has no check for a delete.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildRemove(args), (draft, done) => {
    const made = new Set(done.map(({ request }) => request.objectId))
    const before = draft.before as { items: Array<{ id: string }> }
    return {
      data: { deleted: [...made] },
      before: { items: before.items.filter((i) => made.has(i.id)) },
      after: { items: [...made].map((id) => ({ id, deleted: true })) },
    }
  }, shows('view custom-conversions')),
}

export const META_ADS_SIGNALS_TOOLS: AgentTool[] = [createMetaDataset, setMetaDataset, setMetaDatasetAccess, setMetaCustomConversion, setMetaEventSetup, removeMetaSignalItems]
