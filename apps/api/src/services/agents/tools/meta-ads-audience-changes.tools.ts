/**
 * Meta ads changes, step 31 — the business's audiences on its chosen Meta ad account (Owner decision D8):
 *   create-meta-audience        a customer list (EMPTY: Nexus adds nobody — no consent field) or value-based seed, a website,
 *                               engagement, offline, video viewers or catalog product audience, a lookalike (tiers)
 *   set-meta-audience           name, description, rule, opt-out link, lookalike size, customer-file source, labels,
 *                               retention, product set, allowed domains, use; the account's existing-customer audiences
 *                               (the WHOLE list, read first for the undo) and audience-type URL tags
 *   set-meta-audience-members   take the people who opted out of the business's e-mail out of one customer list or out of
 *                               EVERY customer list of the account (hashed, ≤ 10,000 per request); add / replace refused (D8)
 *   set-meta-audience-sharing   share / unshare with ad accounts no other Nexus business uses
 *   remove-meta-audience        delete for good (lookalikes first), only on the person's explicit ask
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person
 * approves it, it runs as that person request by request, and undo puts back what can be put back (or says why not).
 * An audience another account owns, or one shared with an ad account another business in Nexus uses, is never changed.
 * Meta's own MCP tools (ads_create_custom_audience, ads_update_custom_audience, ads_update_custom_audience_users,
 * ads_delete_custom_audience) change an audience without a preview of the ads it touches, an approval or an undo, and have
 * no replace, sharing, existing-customer, product-audience or opt-out-everywhere tool; these do.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { ownAudience } from '../../marketing/meta-ads/live-audiences.js'
import type { MetaChangeDraft } from '../../marketing/meta-ads/change-draft.js'
import type { MetaWriteBodyId } from '../../gateway/meta-calls.js'
import {
  changeableAudience, chosenOf, liveAudienceDetail, liveExistingCustomerUsers, liveAudienceSharing, liveAudienceTypeTags, liveAudienceUse, liveAudiencesNamed, liveIdProblems, liveTerms,
} from '../../marketing/meta-ads/live-audience-change.js'
import { optedOutPeople, memberCounts, NO_CONSENT } from '../../marketing/meta-ads/audience-members.js'
import {
  audienceFieldView, COMPARED_AUDIENCE_FIELDS, CREATE_KINDS, createAudienceDraft, MAX_DELETES, MEMBER_MODES, membersDraft, removeDraft, setAudienceDraft, shareDraft,
  type AudienceCreateRecord, type AudienceCreateRequest, type AudienceMembersRequest, type AudienceRemoveRequest, type AudienceSetRecord, type AudienceSetRequest,
  type AudienceShareRecord, type AudienceShareRequest,
} from '../../marketing/meta-ads/change-audiences.js'
import {
  AGGREGATION_OPERATORS, AGGREGATION_TYPES, audienceRuleIds, AUDIENCE_LABELS, AUDIENCE_SOURCE_TYPES, CUSTOMER_FILE_SOURCES, FILTER_OPERATORS, LOOKALIKE_TYPES,
  MAX_RETENTION_SECONDS, OPT_OUT_LINK, PRODUCT_EVENTS, RULE_FIELD, RULE_SET_OPERATORS, SHARE_PERMISSIONS, USE_FOR_PRODUCTS, VIDEO_EVENTS,
} from '../../gateway/meta-audience-rules.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from '../../gateway/meta-settings-rules.js'

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

const ID = /^\d{1,20}$/
const idArg = (what: string) => z.string().trim().regex(ID, 'a Meta id is digits only').describe(what)
const idList = (what: string, max: number) => z.array(z.string().trim().regex(ID, 'a Meta id is digits only')).max(max).describe(what)
const nameArg = z.string().trim().min(1).max(200).regex(META_NAME_TEXT, 'no control or format characters').describe('the audience\'s name (emoji allowed)')
const descriptionArg = z.string().trim().min(1).max(1000).regex(META_STRICT_TEXT, 'no control or format characters').describe('its description')
const labelsArg = z.array(z.enum(AUDIENCE_LABELS)).min(1).max(AUDIENCE_LABELS.length).describe('customer-lifecycle labels (value rules and customer goals read them)')
const optOutArg = z.string().trim().regex(OPT_OUT_LINK, 'an http(s) link').describe('the opt-out link people can use (https://…)')

const ruleValue = z.union([z.string().max(1000), z.number(), z.array(z.union([z.string().max(1000), z.number()])).min(1).max(100)])
  .describe('a value: text, a number, or a list of them (is_any, in_range)')
const ruleCondition = z.strictObject({
  field: z.string().regex(RULE_FIELD).describe('url, domain, path, event, device_type, or a custom-data key (custom_data.value, content_ids …)'),
  operator: z.enum(FILTER_OPERATORS).describe('Meta\'s operator; an event filter takes = only'),
  value: ruleValue,
})
const ruleInnerFilter = z.strictObject({
  operator: z.enum(RULE_SET_OPERATORS).describe('and / or'),
  filters: z.array(ruleCondition).min(1).max(100).describe('its filters'),
})
const ruleFilter = z.strictObject({
  operator: z.enum(RULE_SET_OPERATORS).describe('and / or'),
  filters: z.array(z.union([ruleCondition, ruleInnerFilter])).min(1).max(100).describe('filters, or a filter set of filters (two levels at most; at most 100 filters in a rule)'),
}).describe('which events of the source count')
const ruleAggregation = z.strictObject({
  type: z.enum(AGGREGATION_TYPES).describe('count, sum, avg, min or max (time_spent and last_event_time_field need a config Meta does not document: not sent)'),
  field: z.string().regex(RULE_FIELD).optional().describe('the custom-data key it adds up (not for count)'),
  operator: z.enum(AGGREGATION_OPERATORS).describe('= != > >= < <= in_range not_in_range'),
  value: ruleValue,
  method: z.enum(['absolute', 'percentile']).optional().describe('percentile takes in_range / not_in_range'),
}).describe('how often or how much (top spenders, ≥ N visits)')
const ruleItem = z.strictObject({
  event_sources: z.array(z.strictObject({
    id: z.string().regex(ID).describe('the source: the ad account\'s pixel (website, offline), the chosen Page or Instagram account, a lead form or Instant Experience of the chosen Page'),
    type: z.enum(AUDIENCE_SOURCE_TYPES).describe('pixel, offline_events, page, ig_business, lead, ig_lead_generation, canvas, shopping_page, shopping_ig'),
  })).min(1).max(10).describe('its event sources'),
  retention_seconds: z.number().int().min(0).max(MAX_RETENTION_SECONDS).describe('how long a person stays (seconds; website ≤ 365 days, lead forms ≤ 90, Page / Instagram / Instant Experiences ≤ 730; 0 only for page_liked)'),
  filter: ruleFilter.describe('which events of the source count (required — every visitor: {"operator":"and","filters":[{"field":"url","operator":"i_contains","value":""}]})'),
  aggregation: ruleAggregation.optional(),
})
const ruleSet = z.strictObject({ operator: z.enum(RULE_SET_OPERATORS).describe('and / or'), rules: z.array(ruleItem).min(1).max(10).describe('its rules (10 at most, inclusions and exclusions together)') })
const ruleArg = z.strictObject({ inclusions: ruleSet.describe('who is in it'), exclusions: ruleSet.optional().describe('who is kept out') })
  .describe('the audience rule in Meta\'s own syntax (audiences/guides/audience-rules): {inclusions:{operator, rules:[{event_sources:[{id,type}], retention_seconds, filter:{operator, filters:[{field, operator, value}]}, aggregation}]}, exclusions}')
const productRules = (what: string) => z.array(z.strictObject({
  event: z.enum(PRODUCT_EVENTS).describe('Search, ViewContent, AddToCart or Purchase'),
  days: z.number().int().min(1).max(365).describe('over the last this many days'),
})).min(1).max(10).describe(what)

const ADS_MANAGE = F.adsCampaignsManage

/** A builder that turns a refusal of the live reads (not the account's, another business's, not that kind) into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}
const requestOf = <T>(args: Record<string, unknown>): T => {
  const { connectionId: _c, why: _w, confirmDelete: _d, ...rest } = args
  return rest as T
}
type Done = Array<{ request: MetaChangeDraft['requests'][number]; result: { node: Record<string, unknown> | null } }>

// ── create-meta-audience ────────────────────────────────────────────────────────────────────────────────────────

/** The ids a new audience names inside it (each checked to be this business's, here and at the gateway). */
function createIds(r: AudienceCreateRequest): MetaWriteBodyId[] {
  const ids: MetaWriteBodyId[] = []
  if (r.rule) ids.push(...audienceRuleIds(r.rule))
  for (const id of r.video?.videoIds ?? []) ids.push({ id, kind: 'sourcevideo' })
  if (r.catalog) {
    ids.push({ id: r.catalog.productSetId, kind: 'productset' })
    if (r.catalog.pixelId) ids.push({ id: r.catalog.pixelId, kind: 'pixel' })
  }
  for (const id of [...(r.lookalike?.campaignIds ?? []), ...(r.lookalike?.adSetIds ?? [])]) ids.push({ id, kind: 'campaignOrAdset' })
  return ids
}

const buildCreate = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = requestOf<AudienceCreateRequest>(args)
  const chosen = await chosenOf(account.accountId)
  const terms = await liveTerms(chosen)
  // Refused before anything else is read when the terms are not signed.
  if (!terms.signed) return createAudienceDraft(request, { adAccountId: chosen.adAccountId, terms, sameName: { ids: [], checked: false }, seed: null, pageId: chosen.pageId, idProblems: [] })
  const seed = request.lookalike?.seedAudienceId ? (await changeableAudience(chosen, request.lookalike.seedAudienceId)).audience : null
  const idProblems = await liveIdProblems(chosen, createIds(request))
  const names = request.kind === 'lookalike' && request.lookalike?.tiers?.length
    ? request.lookalike.tiers.map((t) => `${request.name} ${t.fromPercent}-${t.toPercent}%`) : [request.name]
  const sameName = await liveAudiencesNamed(chosen, names)
  return createAudienceDraft(request, { adAccountId: chosen.adAccountId, terms, sameName, seed, pageId: chosen.pageId, idProblems })
})

function createFinish(draft: MetaChangeDraft, done: Done) {
  const planned = (draft.after as AudienceCreateRecord).created
  const created = done.map(({ request, result }) => {
    const id = result.node && (typeof result.node.id === 'string' || typeof result.node.id === 'number') ? String(result.node.id) : null
    const plan = planned[request.step - 1]
    return { audienceId: id, name: plan?.name ?? request.params.name ?? '', kind: plan?.kind ?? 'customer_list' }
  })
  const record: AudienceCreateRecord = { created }
  return { data: { created }, before: { created: [] } satisfies AudienceCreateRecord, after: record }
}

const createUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AudienceCreateRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const chosen = await chosenOf(account.accountId)
    const still: AudienceCreateRecord['created'] = []
    for (const c of after.created ?? []) {
      if (!c.audienceId) { still.push(c); continue }
      try {
        const own = await ownAudience(chosen, c.audienceId)
        if (!own.sharedIn) still.push(c)
      } catch (err) {
        if (!(err instanceof MetaLiveRefusal)) throw err
      }
    }
    return { ...after, created: still, accountId: account.accountId, adAccountId: account.adAccountId }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as AudienceCreateRecord & { accountId?: string }
    const ids = (after.created ?? []).map((c) => c.audienceId).filter((id): id is string => !!id)
    if (!ids.length) return { refusal: 'This change recorded no audience Meta made, so there is nothing to delete.' }
    return {
      tool: 'remove-meta-audience',
      args: { ...(after.accountId ? { connectionId: after.accountId } : {}), audienceIds: ids.slice(0, MAX_DELETES), confirmDelete: true, why: 'undo of an earlier create-meta-audience: delete the audiences it made' },
    }
  },
}

const createMetaAudience: AgentTool = {
  name: 'create-meta-audience',
  title: 'Create a Meta audience',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Undo deletes what it made (remove-meta-audience); an audience no ad uses yet goes without a trace.
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  requires: [ADS_MANAGE],
  input: z.object({
    connectionId: metaConnectionArg,
    kind: z.enum(CREATE_KINDS).describe('customer_list (EMPTY: Nexus adds nobody), value_seed (an empty value-based list), website (pixel rule), engagement (Page, Instagram, lead forms, Instant Experiences, shops), offline (dataset events), video (viewers), catalog (product viewers / carters / buyers), lookalike'),
    name: nameArg,
    description: descriptionArg.optional(),
    customerFileSource: z.enum(CUSTOMER_FILE_SOURCES).optional().describe('customer_list, value_seed: how the people were collected (default USER_PROVIDED_ONLY)'),
    retentionDays: z.number().int().min(1).max(180).optional().describe('customer_list, value_seed, website: keep people this many days (1–180; a customer list without it keeps them for good)'),
    labels: labelsArg.optional().describe('customer_list, website: customer-lifecycle labels'),
    optOutLink: optOutArg.optional().describe('customer_list, value_seed: the opt-out link'),
    rule: ruleArg.optional().describe('website (pixel sources), engagement (page, ig_business, lead, ig_lead_generation, canvas, shopping_page, shopping_ig), offline (offline_events with the ad account\'s pixel / dataset): the rule in Meta\'s syntax'),
    prefill: z.boolean().optional().describe('website, engagement, video: include people from before it was made (Meta\'s default true; at most 180 days back)'),
    video: z.strictObject({
      videoIds: z.array(z.string().trim().regex(ID)).min(1).max(20).describe('videos of the chosen Page or the ad account\'s library'),
      event: z.enum(VIDEO_EVENTS).describe('how much of it they watched'),
    }).optional().describe('video: who watched these videos'),
    catalog: z.strictObject({
      productSetId: idArg('a product set of the chosen ad account\'s business portfolio\'s catalog'),
      include: productRules('who is in it: what they did with the products, over how many days'),
      exclude: productRules('who is kept out (matched per product group)').optional(),
      pixelId: idArg('the ad account\'s pixel connected to the catalog').optional(),
    }).optional().describe('catalog: people who searched, viewed, carted or bought products of a product set'),
    lookalike: z.strictObject({
      seedAudienceId: idArg('a seed audience of the ad account (at least 100 people; a value-based list for a value lookalike)').optional(),
      campaignIds: idList('campaigns whose converters it learns from', 50).optional(),
      adSetIds: idList('ad sets whose converters it learns from', 50).optional(),
      pageFans: z.literal(true).optional().describe('the chosen Page\'s fans'),
      type: z.enum(LOOKALIKE_TYPES).optional().describe('similarity (about the closest 1%), reach (about 5%), or custom_ratio (a value lookalike, with percent)'),
      percent: z.number().int().min(1).max(20).optional().describe('its size: the closest this many percent (1–20)'),
      fromPercent: z.number().int().min(0).max(19).optional().describe('with percent: start there (from 1% to 3%: fromPercent 1, percent 3)'),
      tiers: z.array(z.strictObject({ fromPercent: z.number().int().min(0).max(19).describe('from'), toPercent: z.number().int().min(1).max(20).describe('to') })).min(1).max(5).optional()
        .describe('non-overlapping tiers, each its own lookalike (0–1%, 1–3%, 3–5%)'),
      allowInternationalSeeds: z.boolean().optional().describe('let Meta find seed people in other countries when one country has too few'),
    }).optional().describe('lookalike: its source and size (never a country: Meta ignores it since v26 — the ad set\'s locations decide)'),
    why: metaWhyArg,
  }),
  description:
    'Create ONE audience on the business\'s chosen Meta ad account (a lookalike with tiers: one per tier): a customer list '
    + '(EMPTY — Nexus adds nobody: its customers carry no marketing consent, D8) or a value-based seed; a website audience '
    + '(a rule over the ad account\'s own pixel: events, URLs, custom data, how often, how much); an engagement audience '
    + '(the chosen Page or Instagram account, a lead form or Instant Experience of the Page, its shops); an offline audience '
    + '(events of its dataset); video viewers (videos of the Page or the ad account); a catalog product audience (a product '
    + 'set of its portfolio\'s catalog); a lookalike of a seed audience, of campaigns\' or ad sets\' converters, or of the '
    + 'Page\'s fans (similarity, reach, 1–20%, tiers, value-based; converters and fans take a percent or tiers). Every id it names must be this business\'s (never one '
    + 'another business in Nexus uses). Refused until a person signs Meta\'s Custom Audience terms for the ad account (the '
    + 'link is in the answer). No audience spends anything until an ad set uses it. Not here: Messenger / WhatsApp '
    + 'subscriber lists (Meta\'s SDK only), saved audiences (Meta has no API), Meta\'s identical-audience fetch (undo would '
    + 'then delete one it did not make). Meta has no check for it. Undo deletes what it made.'
    + META_CHANGE_RULES,
  undo: createUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildCreate(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildCreate(args), createFinish),
}

// ── set-meta-audience ───────────────────────────────────────────────────────────────────────────────────────────

const AUDIENCE_FIELD_ARGS = ['name', 'description', 'rule', 'optOutLink', 'lookalike', 'customerFileSource', 'labels', 'retentionDays', 'productSetId', 'allowedDomains', 'useInCampaigns', 'useForProducts'] as const

const buildSet = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = requestOf<AudienceSetRequest>(args)
  const chosen = await chosenOf(account.accountId)
  const audienceAsked = AUDIENCE_FIELD_ARGS.some((f) => request[f] !== undefined)
  const audience = audienceAsked && request.audienceId ? (await changeableAudience(chosen, request.audienceId)).audience : null
  const use = audience ? await liveAudienceUse(chosen, audience.id) : null
  const terms = request.existingCustomers !== undefined ? await liveTerms(chosen) : null
  const tags = request.audienceTypeTags !== undefined ? await liveAudienceTypeTags(chosen) : null
  const existingUsers = request.existingCustomers !== undefined ? await liveExistingCustomerUsers(chosen) : null
  const ids: MetaWriteBodyId[] = [
    ...(request.rule ? audienceRuleIds(request.rule) : []),
    ...(request.productSetId ? [{ id: request.productSetId, kind: 'productset' as const }] : []),
    ...(request.existingCustomers ?? []).map((id) => ({ id, kind: 'customaudience' as const })),
  ]
  const idProblems = await liveIdProblems(chosen, ids)
  return setAudienceDraft(request, { adAccountId: chosen.adAccountId, audience, use, terms, tags, idProblems, existingUsers })
})

function setFinish(draft: MetaChangeDraft, done: Done) {
  const before = draft.before as AudienceSetRecord
  const planned = draft.after as AudienceSetRecord
  // What did not happen is not recorded as written (its request was refused): only the requests Meta made.
  const made = new Set(done.map((d) => d.request.objectKind))
  const fields = Object.fromEntries(Object.entries(planned.fields).filter(([k]) => (k === 'existing_customers' || k === 'custom_audience_info' ? made.has('adaccount') : made.has('customaudience'))))
  const after: AudienceSetRecord = { ...planned, fields }
  // Undo puts back only what Meta made: the audience's arguments when its request ran, the account's when that one did.
  const undo = before.undo ? Object.fromEntries(Object.entries(before.undo).filter(([k]) => (k === 'existingCustomers' || k === 'audienceTypeTags' ? made.has('adaccount') : made.has('customaudience')))) : null
  const kept: AudienceSetRecord = {
    ...before,
    fields: Object.fromEntries(Object.entries(before.fields).filter(([k]) => k in fields)),
    undo: undo && Object.keys(undo).some((k) => k !== 'audienceId') ? undo : null,
  }
  return { data: { audienceId: planned.audienceId, fields, ...(before.noUndo.length ? { noUndo: before.noUndo } : {}) }, before: kept, after }
}

const setUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AudienceSetRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const chosen = await chosenOf(account.accountId)
    const fields: Record<string, unknown> = { ...after.fields }
    const compared = Object.keys(fields).filter((k) => (COMPARED_AUDIENCE_FIELDS as readonly string[]).includes(k))
    if (compared.length && after.audienceId) {
      const a = await liveAudienceDetail(chosen, after.audienceId)
      const live: Record<string, unknown> = {
        name: a.name, description: a.description, opt_out_link: a.optOutLink, customer_file_source: a.customerFileSource, retention_days: a.retentionDays, audience_labels: a.labels,
      }
      for (const k of compared) fields[k] = audienceFieldView(k, live[k])
    }
    if ('existing_customers' in fields) {
      const terms = await liveTerms(chosen)
      fields.existing_customers = terms.existingCustomers ? [...terms.existingCustomers].sort() : null
    }
    if ('custom_audience_info' in fields) fields.custom_audience_info = await liveAudienceTypeTags(chosen)
    return { ...after, fields, accountId: account.accountId, adAccountId: account.adAccountId }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as AudienceSetRecord & { accountId?: string }
    if (!before.undo) return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the change recorded no earlier values.'}` }
    return {
      tool: 'set-meta-audience',
      args: {
        ...(before.accountId ? { connectionId: before.accountId } : {}),
        ...before.undo,
        why: `undo of an earlier Meta audience change${before.noUndo?.length ? ` (stays as it is: ${before.noUndo.join(' ')})` : ''}`.slice(0, 300),
      },
    }
  },
}

const setMetaAudience: AgentTool = {
  name: 'set-meta-audience',
  title: 'Change a Meta audience',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Most parts are put back by undo; a new rule's people stay until they expire, and fields Meta gives no read-back of are said.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [ADS_MANAGE],
  input: z.object({
    connectionId: metaConnectionArg,
    audienceId: metaIdArg('the audience (the chosen ad account\'s own; meta-audiences view list)').optional(),
    name: nameArg.optional(),
    description: descriptionArg.optional(),
    rule: ruleArg.optional().describe('a website, engagement or offline audience\'s new rule (Meta\'s syntax; its sources as its kind\'s)'),
    optOutLink: optOutArg.optional(),
    lookalike: z.strictObject({
      type: z.enum(LOOKALIKE_TYPES).optional().describe('similarity, reach or custom_ratio'),
      percent: z.number().int().min(1).max(20).optional().describe('its size in percent (1–20)'),
      fromPercent: z.number().int().min(0).max(19).optional().describe('with percent: where it starts'),
      allowInternationalSeeds: z.boolean().optional().describe('seed people from other countries'),
    }).optional().describe('a lookalike\'s size (its source never changes; Meta\'s answer decides what may change once it is built)'),
    customerFileSource: z.enum(CUSTOMER_FILE_SOURCES).optional().describe('a customer list: how its people were collected'),
    labels: labelsArg.optional().describe('customer list, website or app audience: its labels (the whole list)'),
    retentionDays: z.number().int().min(1).max(180).optional().describe('a customer list: keep people this many days (Meta\'s SDK only on an update)'),
    productSetId: idArg('a catalog audience: its product set (of the portfolio\'s catalog)').optional(),
    allowedDomains: z.array(z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)).min(1).max(50).optional().describe('the domains it is restricted to (Meta documents it by name only)'),
    useInCampaigns: z.boolean().optional().describe('Meta\'s use_in_campaigns switch (documented by name only)'),
    useForProducts: z.array(z.enum(USE_FOR_PRODUCTS)).min(1).max(2).optional().describe('what it may be used for: ADS, MARKETING_MESSAGES'),
    existingCustomers: idList('the ad account\'s existing-customer audiences: the WHOLE list it becomes (its own website, customer-list, catalog or offline audiences; [] for none)', 100).optional(),
    audienceTypeTags: z.strictObject({
      paramName: z.string().trim().regex(/^[A-Za-z0-9_]{1,100}$/).describe('the URL parameter\'s name (e.g. audience_type)'),
      newCustomerTag: z.string().trim().regex(/^[A-Za-z0-9_]{1,100}$/).optional().describe('its value for new customers (e.g. prospecting)'),
      existingCustomerTag: z.string().trim().regex(/^[A-Za-z0-9_]{1,100}$/).optional().describe('its value for existing customers (e.g. retargeting)'),
    }).optional().describe('the ad account\'s audience-type URL tags on Advantage+ ad clicks'),
    why: metaWhyArg,
  }),
  description:
    'Change ONE audience of the business\'s chosen Meta ad account (its own; never one another account owns or one shared '
    + 'with an ad account another business in Nexus uses): name, description, the rule of a website, engagement or offline '
    + 'audience (the people the old rule found stay until their retention ends), opt-out link, a lookalike\'s size, a '
    + 'customer list\'s source and retention, labels, a catalog audience\'s product set, allowed domains and what it may be '
    + 'used for. And the ad account\'s existing-customer audiences (the WHOLE list — read first, so undo can put it back) '
    + 'and its audience-type URL tags. ANY change of who is in an audience that ads use (here or in an account it is '
    + 'shared with) — its rule, lookalike size, retention, product set, allowed domains — is SPENDS MONEY in either '
    + 'direction (an ad set may target it or exclude it), and so are new labels value rules may raise bids for and a new '
    + 'existing-customer list that active ad sets read (they are listed). A flagged customer list or lookalike cannot be edited '
    + '(Meta). Not here: a catalog audience\'s events (inclusions / exclusions are in Meta\'s SDK update only, not its '
    + 'documented one: make a new catalog audience with create-meta-audience and delete the old one), the labels of an audience another account shares in (Nexus never changes another account\'s '
    + 'audience), the fields of travel / auto / listing claim audiences (claim_objective, content_type, event_source_group, '
    + 'event_sources) and the separate rule_aggregation string (Nexus sends aggregation inside the rule). Meta has no check '
    + 'for it. Undo puts back what it replaced (what has no way back is said).'
    + META_CHANGE_RULES,
  undo: setUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildSet(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildSet(args), setFinish),
}

// ── set-meta-audience-members ───────────────────────────────────────────────────────────────────────────────────

const sinceArg = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional()
  .describe('only people who opted out on or after this day (UTC, YYYY-MM-DD): to send a long list in parts')

const buildMembers = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = requestOf<AudienceMembersRequest>(args)
  // D8 — refused before any read: no consent field, so nobody is added and nothing is replaced.
  if (request.mode === 'add' || request.mode === 'replace') return { refusal: NO_CONSENT }
  const chosen = await chosenOf(account.accountId)
  const terms = await liveTerms(chosen)
  if (!terms.signed) return membersDraft(request, { adAccountId: chosen.adAccountId, terms, audience: null, use: null, people: { hashes: [], skipped: 0 } })
  let audience = null
  let use = null
  if (request.mode === 'remove') {
    if (!request.audienceId) return { refusal: 'Name the customer list (audienceId from meta-audiences view list).' }
    audience = (await changeableAudience(chosen, request.audienceId)).audience
    use = await liveAudienceUse(chosen, audience.id)
  } else if (request.audienceId) {
    return { refusal: 'opt_out_everywhere takes the people out of EVERY customer list of the ad account: it names no audience.' }
  }
  const since = request.since ? new Date(`${request.since}T00:00:00Z`) : null
  if (since && (Number.isNaN(since.getTime()) || since.toISOString().slice(0, 10) !== request.since)) return { refusal: 'since is a real day (YYYY-MM-DD).' }
  const people = await optedOutPeople(since)
  return membersDraft(request, { adAccountId: chosen.adAccountId, terms, audience, use, people })
})

function membersFinish(draft: MetaChangeDraft, done: Done) {
  const record = draft.before as Record<string, unknown>
  // Meta's counts only: never its invalid-entry samples (they are hashes of people).
  const counts = done.map(({ result }) => memberCounts(result.node))
  const sum = (key: 'received' | 'invalid') => (counts.every((c) => c[key] !== null) ? counts.reduce((n, c) => n + (c[key] ?? 0), 0) : null)
  return {
    data: { ...record, batchesSent: done.length, received: sum('received'), invalidEntries: sum('invalid'), note: 'Meta applies it within about 24 hours; meta-audiences view sessions shows its upload sessions.' },
    before: record,
    after: { ...record, batchesSent: done.length },
  }
}

const setMetaAudienceMembers: AgentTool = {
  name: 'set-meta-audience-members',
  title: 'Change a Meta customer list\'s people',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // People who opted out are never put back (Meta's policy too): no undo.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  requires: [ADS_MANAGE, F.customersExport],
  input: z.object({
    connectionId: metaConnectionArg,
    mode: z.enum(MEMBER_MODES).describe('remove: take the people who opted out of the business\'s e-mail out of ONE customer list; opt_out_everywhere: out of EVERY customer list of the ad account; add / replace: refused — Nexus adds nobody (D8: no marketing consent recorded)'),
    audienceId: metaIdArg('remove: the customer list (the chosen ad account\'s own)').optional(),
    since: sinceArg,
    why: metaWhyArg,
  }),
  description:
    'The people of the business\'s Meta customer lists, from Nexus (Owner decision D8). ADD and REPLACE are refused: Nexus '
    + 'uploads only customers who gave marketing consent, and its customer records hold no consent yet — so nobody is '
    + 'uploaded. What it does: take the people who opted out of the business\'s e-mail (Nexus\'s suppression list: an '
    + 'unsubscribe, a spam complaint, a GDPR request, an operator\'s entry — never a bounce) out of ONE customer list '
    + '(remove) or out of EVERY customer list of the ad account (opt_out_everywhere, as Meta asks when someone opts out). '
    + 'Each e-mail goes only as its SHA-256 hash (trimmed, lower case), at most 10,000 per request; Nexus '
    + 'keeps no list of them and the answer gives counts only. Refused until a person signs Meta\'s Custom Audience terms. '
    + 'Taking people out of a list ads use, and every opt_out_everywhere, is SPENDS MONEY (an ad set that excludes the '
    + 'list can then reach them). opt_out_everywhere covers every customer list of the account, also one shared with an '
    + 'account another business in Nexus uses: an opt-out is honoured everywhere. '
    + 'Meta applies it within about 24 hours; taking people out of a list active ads use restarts their learning. No undo: '
    + 'people who opted out are never put back. Nexus sends e-mails only: no phone, name or address (D8), no Page-scoped '
    + 'ids (Nexus keeps none), no external customer ids (Nexus never uploaded any, so none can be taken out), no US Limited '
    + 'Data Use flags (US states only). Meta has no check for it.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildMembers(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildMembers(args), membersFinish),
}

// ── set-meta-audience-sharing ───────────────────────────────────────────────────────────────────────────────────

const buildShare = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = requestOf<AudienceShareRequest>(args)
  const chosen = await chosenOf(account.accountId)
  const audience = await liveAudienceDetail(chosen, request.audienceId)
  const sharing = await liveAudienceSharing(chosen, audience.id)
  const use = await liveAudienceUse(chosen, audience.id)
  const idProblems = request.action === 'share' ? await liveIdProblems(chosen, request.adAccountIds.map((id) => ({ id, kind: 'shareaccount' as const }))) : []
  return shareDraft(request, { audience, sharing, use, idProblems })
})

function shareFinish(draft: MetaChangeDraft, done: Done) {
  const record = draft.before as AudienceShareRecord
  const answer = done[0]?.result.node
  // Meta answers per recipient (sharing_data: ad_acct_id, audience_share_status, errors): kept as Meta's words per account.
  const perAccount = Array.isArray(answer?.sharing_data)
    ? (answer!.sharing_data as Array<Record<string, unknown>>).map((s) => ({ adAccountId: typeof s.ad_acct_id === 'string' ? s.ad_acct_id.replace(/^act_/, '') : null, status: typeof s.audience_share_status === 'string' ? s.audience_share_status : null, errors: Array.isArray(s.errors) ? s.errors.filter((e) => typeof e === 'string').slice(0, 5) : [] }))
    : null
  return { data: { ...record, ...(perAccount ? { sharing: perAccount } : {}) }, before: { ...record, shared: record.action === 'unshare' }, after: { ...record, shared: record.action === 'share' } }
}

const shareUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AudienceShareRecord & { shared?: boolean; accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const chosen = await chosenOf(account.accountId)
    const sharing = await liveAudienceSharing(chosen, after.audienceId)
    // Re-review N1 — unread is not "not shared": undo then says it cannot tell (nothing is compared against an empty list).
    if (sharing.accounts === null) return null
    const now = new Set(sharing.accounts)
    const allSo = after.adAccountIds.every((id) => now.has(id) === (after.shared === true))
    return { ...after, shared: allSo ? after.shared : !after.shared, accountId: account.accountId, adAccountId: account.adAccountId }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as AudienceShareRecord & { accountId?: string }
    if (!before.audienceId || !before.adAccountIds?.length) return { refusal: 'This change recorded no share to put back.' }
    return {
      tool: 'set-meta-audience-sharing',
      args: {
        ...(before.accountId ? { connectionId: before.accountId } : {}),
        audienceId: before.audienceId,
        action: before.action === 'share' ? 'unshare' : 'share',
        adAccountIds: before.adAccountIds,
        why: before.action === 'share'
          ? 'undo of an earlier share: stop sharing it again (the recipients\' ads using it stop for good)'
          : 'undo of an earlier unshare: share it again (ads that stopped stay stopped; the permission is Meta\'s default)',
      },
    }
  },
}

const setMetaAudienceSharing: AgentTool = {
  name: 'set-meta-audience-sharing',
  title: 'Share a Meta audience',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A share is undone in full; an unshare stops the recipients' ads for good (sharing again gives back only the targeting).
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'share' ? { reversibility: 'full' } : null),
  maxClaudeTrust: 'ask',
  requires: [ADS_MANAGE],
  input: z.object({
    connectionId: metaConnectionArg,
    audienceId: metaIdArg('the audience (the chosen ad account\'s own)'),
    action: z.enum(['share', 'unshare']).describe('share with these ad accounts, or stop sharing with them'),
    adAccountIds: idList('the ad accounts (digits, no act_): of the business portfolio, never one another business in Nexus uses', 50).min(1),
    permissions: z.enum(SHARE_PERMISSIONS).optional().describe('share: targeting (target it only) or targeting_and_insights (Meta\'s default)'),
    why: metaWhyArg,
  }),
  description:
    'Share ONE audience of the business\'s chosen Meta ad account with other ad accounts, or stop sharing it. Only with ad '
    + 'accounts no other business in Nexus uses, nor of a business portfolio another business in Nexus uses (an audience is '
    + 'never shared across Nexus businesses; an unshare is always let through — it is how such a share ends), never the account '
    + 'itself; Meta needs the business portfolio to claim both accounts and answers per account. A recipient can target '
    + 'it, never change it or make a lookalike of it. Sharing never replaces the list it is shared with. STOPPING a share '
    + 'stops the recipients\' ads that use it for good (Meta: they cannot be restarted) — the preview says how many. Meta '
    + 'has no check for it. Undo stops a share again, or shares again (stopped ads stay stopped).'
    + META_CHANGE_RULES,
  undo: shareUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildShare(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildShare(args), shareFinish),
}

// ── remove-meta-audience ────────────────────────────────────────────────────────────────────────────────────────

const buildRemove = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  if (args.confirmDelete !== true) return { refusal: 'Deleting an audience is for good: Nexus asks for it only when the person asked for it (confirmDelete: true).' }
  const request = requestOf<AudienceRemoveRequest>(args)
  const chosen = await chosenOf(account.accountId)
  const audiences = []
  for (const id of [...new Set(request.audienceIds)]) {
    const { audience } = await changeableAudience(chosen, id)
    const use = await liveAudienceUse(chosen, audience.id)
    const lookalikes = []
    if (request.includeLookalikes) {
      for (const lid of audience.lookalikeIds.slice(0, MAX_DELETES + 1)) {
        const l = (await changeableAudience(chosen, lid)).audience
        lookalikes.push({ audience: l, use: await liveAudienceUse(chosen, l.id) })
      }
    }
    audiences.push({ audience, use, lookalikes })
  }
  return removeDraft(request, { audiences })
})

function removeFinish(draft: MetaChangeDraft, done: Done) {
  const before = draft.before as { audiences: Array<{ audienceId: string }> }
  const deleted = new Set(done.map((d) => d.request.objectId))
  const gone = before.audiences.filter((a) => deleted.has(a.audienceId))
  return { data: { deleted: gone.map((a) => a.audienceId) }, before: { audiences: gone }, after: { audiences: [] } }
}

const removeMetaAudience: AgentTool = {
  name: 'remove-meta-audience',
  title: 'Delete a Meta audience',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Meta: a deleted audience is gone, and the ads that used it can never be restarted.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  requires: [ADS_MANAGE],
  input: z.object({
    connectionId: metaConnectionArg,
    audienceIds: idList(`the audiences to delete (the chosen ad account's own; at most ${MAX_DELETES} with their lookalikes)`, 5).min(1),
    confirmDelete: z.literal(true).describe('true, only when the person asked to delete these audiences for good'),
    includeLookalikes: z.boolean().optional().describe('also delete their lookalikes, first (Meta refuses to delete a seed while it has any: 2656)'),
    why: metaWhyArg,
  }),
  description:
    'DELETE audiences of the business\'s chosen Meta ad account FOR GOOD — only when the person asked for it '
    + '(confirmDelete: true). The preview lists the ads that use each: they stop and can NEVER be restarted (Meta); a '
    + 'website audience used by active ads pauses their campaign. A seed with lookalikes is refused unless '
    + 'includeLookalikes: true deletes them first (Meta 2656). Never an audience another account owns or one shared with an '
    + 'ad account another business in Nexus uses. Taking it out of the ad sets\' targeting is the safer way. Meta has no '
    + 'check for it. No undo (a new audience is a new, empty one).'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildRemove(args), removeFinish),
}

export const META_ADS_AUDIENCE_CHANGES_TOOLS: AgentTool[] = [createMetaAudience, setMetaAudience, setMetaAudienceMembers, setMetaAudienceSharing, removeMetaAudience]
