/**
 * Meta ads changes, step 40 (2026-10-21) — the business's chosen Meta ad account ITSELF:
 *   set-meta-account-settings   name, business info, EU DSA default payer and beneficiary, the system user's notifications,
 *                               end advertiser / media agency / partner, the agency declaration, account-level tracking
 *                               specs — AA-040–042, AA-046–048, AA-054; AS-108 (account default attribution) answered in
 *                               words: Meta deprecated it
 *   set-meta-spend-cap          the account spending limit: set, raise, lower, remove; reset the amount spent — AA-043–045
 *   set-meta-insights-features  switch on a restricted insights breakdown, for good — IN-051
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person
 * approves it, it runs as that person, and undo puts back what it replaced (or says what Meta has no way back for). No
 * change of an ad account Meta disabled, is reviewing for risk, is closing or closed, or found compromised (a Nexus rule:
 * change-account-settings.ts metaAccountChangeRefusal — read at the preview, the re-check and the run).
 * Meta's own MCP has no tool for these (master AA-040–048, AA-054, IN-051: "—").
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, objectChangeOf, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { liveAccountState, liveAgencyDeclaration, liveInsightsFeature, liveTrackingSpecs, type LiveAccountState } from '../../marketing/meta-ads/live-account-settings.js'
import { liveAccountPixels } from '../../marketing/meta-ads/live-settings.js'
import {
  ACCOUNT_NOT_SENT, accountReadsNeeded, accountSettingsDraft, accountView, insightsFeatureDraft, metaAccountChangeRefusal, normalSpec, spendCapDraft, spendCapView,
  SPEND_CAP_DAILY_LIMIT_CODE, SPEND_CAP_DAILY_LIMIT_WORDS, trackingView,
  type AccountSettingsRecord, type AccountSettingsRequest, type MetaInsightsFeature, type SpendCapRecord, type SpendCapRequest,
} from '../../marketing/meta-ads/change-account-settings.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import { metaSendChange, MetaWriteError, type MetaChangeResult, type MetaWriteTarget } from '../../marketing/meta-ads/write-client.js'
import { metaAccountSpendCapMicros, metaUnitsToMicros, minorOf } from '../../marketing/meta-ads/money.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from '../../gateway/meta-write-text.js'
import { META_INSIGHTS_FEATURES, MAX_TRACKING_SPECS } from '../../gateway/meta-account-settings-rules.js'

const ADSPEND = FIELDS.financialsAdspendView
/** set-meta-spend-cap's money keys: its sentences quote the limit and the amount spent, so they are money too. */
const META_SPEND_CAP_MONEY = {
  changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, summary: ADSPEND, skipped: ADSPEND, steps: ADSPEND, values: ADSPEND, fields: ADSPEND,
  capCents: ADSPEND, fromCents: ADSPEND, toCents: ADSPEND, amountSpentCents: ADSPEND,
} as const

/** A builder that turns a refusal of the live reads into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}
const typedText = (max: number, pattern: RegExp) => z.string().trim().min(1).max(max).regex(pattern, 'no control or format characters')
const argsOf = <T>(args: Record<string, unknown>): T => { const { connectionId: _c, why: _w, ...rest } = args; return rest as T }
/** Every step of a run that Meta made as asked. */
type Done = Array<{ request: MetaChangeRequest; result: MetaChangeResult; notAsAsked?: string }>

// ── set-meta-account-settings ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The run's own senders (through the write client, the gateway): the settings POST reads the agency declaration back when
 * it wrote one; the tracking POST reads the account's specs back and says whether every spec asked is there.
 */
function withAccountSenders(draft: MetaChangeDraft): MetaChangeDraft {
  return {
    ...draft,
    requests: draft.requests.map((request): MetaChangeRequest => {
      if (request.operation === 'account.settings' && (request.params.agency_client_declaration || request.params.business_info)) {
        return {
          ...request,
          send: async (target: MetaWriteTarget) => {
            const result = await metaSendChange(target, objectChangeOf(request))
            let node = result.node ? { ...result.node } : null
            // Last pass (B-4) — a business_* key that was sent and that Meta's read-back leaves OUT is judged as not as asked
            // (the kit judges only fields Meta sends back); a key sent empty (cleared) may be left out.
            if (node && request.params.business_info) {
              const sent = JSON.parse(request.params.business_info) as Record<string, string>
              for (const [key, value] of Object.entries(sent)) if (node[key] === undefined || node[key] === null) node[key] = value === '' ? '' : '(not sent back)'
            }
            if (request.params.agency_client_declaration) {
              const read = await liveAgencyDeclaration(target).catch(() => null)
              const declaration = read && 'declaration' in read ? accountView(Object.keys(read.declaration).length ? read.declaration : null) : undefined
              node = { ...(node ?? {}), ...(declaration !== undefined ? { agency_client_declaration: declaration } : {}) }
            }
            return { ...result, node }
          },
        }
      }
      if (request.operation === 'account.tracking') {
        const asked = (JSON.parse(request.params.tracking_specs) as unknown[]).map((s) => JSON.stringify(s))
        return {
          ...request,
          send: async (target: MetaWriteTarget) => {
            const result = await metaSendChange(target, objectChangeOf(request))
            const now = await liveTrackingSpecs(target).catch(() => null)
            if (!now) return { ...result, node: null, readBack: 'none' as const }
            const held = now.map((s) => { const n = normalSpec(s); return n ? JSON.stringify({ 'action.type': [n.action], [n.key]: [n.id] }) : null })
            const present = asked.every((a) => held.includes(a))
            return { ...result, node: { tracking_specs: trackingView(now), asked_specs: present ? 'present' : 'missing', held: now.length, extra: now.length - asked.length } }
          },
          doneSentence: (result: MetaChangeResult) => {
            const node = result.node
            if (!node || typeof node.held !== 'number') return `${request.label}: Meta confirmed it; Nexus could not read the specs back (meta-ad-account view tracking shows them).`
            const extra = Number(node.extra)
            return `${request.label}: Meta made it; the account now holds ${node.held} tracking spec${node.held === 1 ? '' : 's'}: ${extra === 0 ? 'exactly the list asked (Meta replaced the list, or it held only these).' : `the list asked and ${extra} more (Meta ADDED to the list, it did not replace it: what this change left out stays, and undo cannot take the new ones away).`}`
          },
        }
      }
      return request
    }),
  }
}

const buildAccountSettings = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = argsOf<AccountSettingsRequest>(args)
  const state = await liveAccountState(account.target)
  // The Nexus safety rule first: nothing more is read of a disabled ad account.
  const refused = metaAccountChangeRefusal(state)
  if (refused) return { refusal: refused }
  const needs = accountReadsNeeded(request)
  const agency = needs.agency ? await liveAgencyDeclaration(account.target) : undefined
  const tracking = needs.tracking ? await liveTrackingSpecs(account.target) : undefined
  const pixels = needs.pixels ? await liveAccountPixels(account.target) : undefined
  const draft = accountSettingsDraft(request, { state, agency, tracking, pixels })
  return 'refusal' in draft ? draft : withAccountSenders(draft)
})

/** The record: what each request Meta made wrote, as Meta read it back; what a step that did not happen wrote is left out. */
function accountFinish(draft: MetaChangeDraft, done: Done) {
  const before = structuredClone(draft.before) as AccountSettingsRecord
  const planned = draft.after as AccountSettingsRecord
  const settings = done.find((d) => d.request.operation === 'account.settings' && !d.notAsAsked)
  const tracking = done.find((d) => d.request.operation === 'account.tracking' && !d.notAsAsked)
  const fields: Record<string, string | null> = {}
  const unread = new Set(planned.unread ?? [])
  for (const [key, value] of Object.entries(planned.fields)) {
    const step = key === 'tracking_specs' ? tracking : settings
    if (!step) { delete before.fields[key]; unread.delete(key); continue }
    const node = step.result.node
    if (node && key in node) fields[key] = key === 'tracking_specs' ? String(node[key]) : accountView(node[key])
    else { fields[key] = value; unread.add(key) }
  }
  if (before.undo) {
    const undo = { ...before.undo }
    if (!tracking) delete undo.trackingSpecs
    if (!settings) for (const key of Object.keys(undo)) if (key !== 'trackingSpecs') delete undo[key]
    before.undo = Object.keys(undo).length ? undo : null
  }
  const after: AccountSettingsRecord = { kind: 'adaccount', id: planned.id, fields, ...(unread.size ? { unread: [...unread] } : {}) }
  return { data: { adAccountId: planned.id, fields, ...(before.noUndo?.length ? { noUndo: before.noUndo } : {}) }, before, after }
}

/** A field of the account as the record views it, from a live read. */
function liveField(state: LiveAccountState, key: string): string | null {
  if (key === 'name') return state.name
  if (key in state.businessInfo) return state.businessInfo[key] ?? null
  if (key === 'default_dsa_payor') return state.dsa.payor
  if (key === 'default_dsa_beneficiary') return state.dsa.beneficiary
  if (key === 'is_notifications_enabled') return state.notifications === null ? null : String(state.notifications)
  if (key === 'end_advertiser' || key === 'media_agency' || key === 'partner') return state.parties[key]
  return null
}

const accountSettingsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AccountSettingsRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const state = await liveAccountState(account.target)
    const unread = new Set(after.unread ?? [])
    const fields: Record<string, string | null> = {}
    for (const key of Object.keys(after.fields ?? {})) {
      if (unread.has(key)) fields[key] = after.fields[key]
      // Last pass — a list Nexus cannot read in full answers nothing: undo then refuses (it never judges part of the list).
      else if (key === 'tracking_specs') {
        const specs = await liveTrackingSpecs(account.target).catch((err) => { if (err instanceof MetaLiveRefusal) return null; throw err })
        if (!specs) return null
        fields[key] = trackingView(specs)
      }
      else if (key === 'agency_client_declaration') {
        const read = await liveAgencyDeclaration(account.target)
        fields[key] = 'declaration' in read ? accountView(Object.keys(read.declaration).length ? read.declaration : null) : after.fields[key]
      } else fields[key] = liveField(state, key)
    }
    return { ...after, fields }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as AccountSettingsRecord & { accountId?: string }
    if (!before.undo) return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the change recorded no earlier values.'}` }
    return {
      tool: 'set-meta-account-settings',
      args: {
        ...(before.accountId ? { connectionId: before.accountId } : {}),
        ...before.undo,
        why: `undo of an earlier Meta ad account change${before.noUndo?.length ? ` (stays as it is: ${before.noUndo.join(' ')})` : ''}`.slice(0, 300),
      },
    }
  },
}

const party = z.enum(['NONE', 'UNFOUND', 'chosen-page'])
const businessText = (what: string) => typedText(200, META_STRICT_TEXT).nullable().optional().describe(`${what} (null clears it)`)
const agencyText = (what: string) => typedText(200, META_STRICT_TEXT).optional().describe(what)

const setMetaAccountSettings: AgentTool = {
  name: 'set-meta-account-settings',
  title: 'Change the Meta ad account\'s settings',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Most parts are put back by undo; a real end advertiser / media agency / partner is for good (Meta).
  reversibility: 'partial',
  consequencesFor: (args) => {
    const keys = Object.keys(args).filter((k) => !['connectionId', 'why'].includes(k) && args[k] !== undefined)
    const forGood = (k: string) => (k === 'endAdvertiser' || k === 'mediaAgency' || k === 'partner') && args[k] === 'chosen-page'
    return keys.length > 0 && keys.every(forGood) ? { reversibility: 'none' } : null
  },
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    name: typedText(200, META_NAME_TEXT).optional().describe('the ad account\'s new name (emoji allowed)'),
    businessInfo: z.object({
      name: businessText('the business name'),
      street: businessText('the street'),
      street2: businessText('the second street line'),
      city: businessText('the city'),
      state: businessText('the state or province'),
      zip: businessText('the post code'),
      countryCode: z.string().trim().regex(/^[A-Z]{2}$/).nullable().optional().describe('the country, two capital letters (null clears it)'),
    }).optional().describe('the business info Meta shows on the account (only the parts named change; business-use accounts only)'),
    dsa: z.union([
      z.object({
        payor: typedText(512, META_STRICT_TEXT).describe('who pays for the ads (shown to people in the EU)'),
        beneficiary: typedText(512, META_STRICT_TEXT).describe('who benefits from the ads (shown to people in the EU)'),
      }).strict(),
      z.object({ clear: z.literal(true).describe('clear both (Meta: two empty strings in one call)') }).strict(),
    ]).optional().describe('the EU DSA default payer and beneficiary every EU ad set without its own uses: both, or clear both'),
    notifications: z.boolean().optional().describe('the account\'s notifications for NEXUS\'S SYSTEM USER (per person: not the Owner\'s)'),
    endAdvertiser: party.optional().describe('the end advertiser: NONE, UNFOUND or chosen-page (this business\'s chosen Facebook Page — for good)'),
    mediaAgency: party.optional().describe('the media agency: NONE, UNFOUND or chosen-page (for good; Meta never lets a real one change again)'),
    partner: party.optional().describe('the partner: NONE, UNFOUND or chosen-page (for good; Meta never lets a real one change again)'),
    agencyDeclaration: z.object({
      confirmAgency: z.literal(true).describe('true: this ad account is run by an AGENCY for its client (a business advertising for itself never sets this)'),
      clientName: agencyText('the client\'s name'),
      clientStreet: agencyText('the client\'s street'),
      clientStreet2: agencyText('the second street line'),
      clientCity: agencyText('the client\'s city'),
      clientProvince: agencyText('the client\'s province'),
      clientPostalCode: agencyText('the client\'s post code'),
      clientCountryCode: z.string().trim().regex(/^[A-Z]{2}$/).optional().describe('the client\'s country, two capital letters'),
      agencyRepresentingClient: z.boolean().optional().describe('the agency represents the client'),
      clientBasedInFrance: z.boolean().optional().describe('the client is based in France'),
      writtenMandateFromAdvertiser: z.boolean().optional().describe('the agency holds a written mandate from the advertiser'),
      clientPaysInvoices: z.boolean().optional().describe('the client pays the invoices'),
    }).optional().describe('the agency declaration (needs a Business Manager admin; never the client\'s e-mail): only the parts named change'),
    trackingSpecs: z.array(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('pixel').describe('conversions of a pixel'), pixelId: metaIdArg('one of the ad account\'s own pixels (meta-datasets lists them)') }),
      z.object({ kind: z.literal('page').describe('an action on this business\'s chosen Facebook Page'), action: z.enum(['page_engagement', 'like', 'link_click']).describe('page_engagement, like or link_click') }),
    ])).max(MAX_TRACKING_SPECS).optional().describe(`the WHOLE list of account-level tracking specs the account should hold (1 to ${MAX_TRACKING_SPECS}; Nexus never sends an empty list: Meta has no way to remove one)`),
    why: metaWhyArg,
  }),
  description:
    'Change the settings of the business\'s chosen Meta ad account itself: its name; its business info (name, street, city, '
    + 'state, post code, country — business-use accounts only); the EU DSA default payer and beneficiary that every EU ad '
    + 'set without its own uses (both, or clear both); notifications — per person: with Nexus\'s system-user token this '
    + 'switches the SYSTEM USER\'s own notifications, NOT the Owner\'s; the end advertiser, media agency and partner (NONE, '
    + 'UNFOUND or this business\'s chosen Facebook Page — set to the Page it is FOR GOOD: Meta never lets it change again; a '
    + 'Page alias, another Page or an app id is not sent, Nexus cannot confirm it is not another Nexus business\'s); the '
    + 'agency declaration (ONLY for an agency running a client\'s ads; needs a Business Manager admin; never an e-mail); '
    + 'the account-level tracking specs (the whole list: conversions of the account\'s own pixels, actions on the chosen '
    + 'Page — whether Meta replaces or adds to the list is not documented: the answer says what Meta holds). Account '
    + 'settings spend nothing. One request (two with tracking specs). Meta has no check for an account change. Refused '
    + `on a disabled, risk-reviewed, closing, closed or compromised account. Not here: ${ACCOUNT_NOT_SENT.join(' ')} `
    + 'Undo puts back what it replaced (what Meta has no way back for is said).'
    + META_CHANGE_RULES,
  undo: accountSettingsUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildAccountSettings(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildAccountSettings(args), accountFinish),
}

// ── set-meta-spend-cap ────────────────────────────────────────────────────────────────────────────────────────────

/** Meta's 10-changes-a-day limit (17/1885172), in plain words; never sent again by Nexus. */
function withSpendCapSender(draft: MetaChangeDraft): MetaChangeDraft {
  return {
    ...draft,
    requests: draft.requests.map((request) => ({
      ...request,
      send: async (target: MetaWriteTarget) => {
        try {
          return await metaSendChange(target, objectChangeOf(request))
        } catch (err) {
          if (err instanceof MetaWriteError && err.failure.code === SPEND_CAP_DAILY_LIMIT_CODE) {
            // Fix round 1 (B-1) — a daily count, not a throttle: Meta refused this one change (the gateway holds nothing either).
            throw new MetaWriteError({ ...err.failure, throttled: false, sentence: SPEND_CAP_DAILY_LIMIT_WORDS }, err.operation, err.outcome === 'unknown' ? 'unknown' : 'refused')
          }
          throw err
        }
      },
    })),
  }
}

const buildSpendCap = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = argsOf<SpendCapRequest>(args)
  const state = await liveAccountState(account.target)
  const draft = spendCapDraft(request, state, account.currency)
  return 'refusal' in draft ? draft : withSpendCapSender(draft)
})

function spendCapFinish(draft: MetaChangeDraft, done: Done) {
  const before = draft.before as SpendCapRecord
  const planned = draft.after as SpendCapRecord
  const node = done[0]?.result.node ?? null
  const currency = typeof node?.currency === 'string' ? node.currency : null
  const stands = draft.stands as { currency: string }
  const cur = currency ?? stands.currency
  const after: SpendCapRecord = { ...planned, fields: { spend_cap: node && 'spend_cap' in node ? spendCapView(node.spend_cap, cur) : planned.fields.spend_cap } }
  const cents = (view: string) => (view === 'none' ? null : minorOf(metaAccountSpendCapMicros(view, cur), cur))
  return {
    data: {
      adAccountId: planned.id, action: planned.action, currency: cur, fromCents: cents(before.fields.spend_cap), toCents: cents(after.fields.spend_cap),
      ...(node && 'amount_spent' in node ? { amountSpentCents: minorOf(metaUnitsToMicros(node.amount_spent, cur), cur) } : {}),
      ...(before.noUndo?.length ? { noUndo: before.noUndo } : {}),
    },
    before,
    after,
    ...(before.undo ? {} : { noUndo: 'A reset of the amount spent has no undo (Meta cannot put the old amount spent back).' }),
  }
}

const spendCapUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as SpendCapRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const state = await liveAccountState(account.target)
    return { ...after, fields: { spend_cap: spendCapView(state.spendCap, state.currency) } }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as SpendCapRecord & { accountId?: string }
    if (!before.undo) return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the change recorded no earlier limit.'}` }
    return {
      tool: 'set-meta-spend-cap',
      args: { ...(before.accountId ? { connectionId: before.accountId } : {}), ...before.undo, why: 'undo of an earlier change of the Meta spending limit' },
    }
  },
}

const setMetaSpendCap: AgentTool = {
  name: 'set-meta-spend-cap',
  title: 'Change the Meta account spending limit',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A new limit and a removal are put back by undo (the old limit set again); a reset of the amount spent has none.
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'reset' ? { reversibility: 'none' } : { reversibility: 'full' }),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: META_SPEND_CAP_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(['set', 'raise', 'lower', 'remove', 'reset']).describe('set a limit (higher than now = a raise); raise or lower it (checked against the limit now); remove it; reset the amount spent against it to 0 (no undo)'),
    // Last pass — up to the largest limit Nexus can read (2^53 − 1 minor units: IDR, VND, KRW limits are large), so an undo
    // of a lower always parses; minorToMetaStandard still refuses what Meta cannot hold.
    capCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('set, raise, lower: the new limit in minor units of the ad account\'s currency (cents for EUR); never 0 (Meta reads 0 as "no limit": that is action remove)'),
    why: metaWhyArg,
  }),
  description:
    'Change the spending limit of the business\'s chosen Meta ad account (when the amount spent reaches it, Meta pauses '
    + 'every campaign of the account): set a limit, raise or lower it, remove it, or reset the amount spent against it to 0. '
    + 'The limit is in minor units of the account currency (capCents); Nexus writes it as Meta takes it — the standard '
    + 'amount, e.g. "500.00" — and the preview shows that string with the currency and the decimals Nexus counted in (Meta '
    + 'reads the limit back in its own units). A RAISE, a REMOVAL and a RESET are SPENDS MONEY (the account can then spend '
    + 'more before Meta stops it); a lower limit, or a first limit, is not. A limit of 0 is refused (Meta: 0 = no limit). A '
    + 'new limit at or below what the account has already spent may stop its ads at once (said). Meta allows 10 limit '
    + 'changes a day: past them Meta refuses, the answer says so and Nexus does not try again. Refused on a disabled, '
    + 'risk-reviewed, closing, closed or compromised account. Meta has no check for an account change. Undo sets the '
    + 'previous limit again (or removes the limit when there was none); a RESET has NO undo — Meta cannot put the old amount '
    + 'spent back. Needs the ad-spend money permission.'
    + META_CHANGE_RULES,
  undo: spendCapUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildSpendCap(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildSpendCap(args), spendCapFinish),
}

// ── set-meta-insights-features ────────────────────────────────────────────────────────────────────────────────────

/** The run reads the account's switched-on features back (Meta's answer only echoes the account). */
function withFeatureSender(draft: MetaChangeDraft, feature: MetaInsightsFeature): MetaChangeDraft {
  return {
    ...draft,
    requests: draft.requests.map((request) => ({
      ...request,
      send: async (target: MetaWriteTarget) => {
        const result = await metaSendChange(target, objectChangeOf(request))
        const now = await liveInsightsFeature(target, feature).catch(() => null)
        return { ...result, node: { feature_name: feature, enabled: now?.enabled ?? null, data_from: now?.dataFrom ?? null } }
      },
      doneSentence: (result: MetaChangeResult) => {
        const on = result.node?.enabled
        return on === true
          ? `${request.label}: Meta switched it on${result.node?.data_from ? `; data from ${String(result.node.data_from)}` : '; data comes about 24 hours from now, going forward'}.`
          : `${request.label}: Meta answered success; its list of switched-on features does not show it ${on === false ? 'yet' : '(Nexus could not read it)'} — Meta says to allow up to about 24 hours (meta-ad-account view insights-features).`
      },
    })),
  }
}

const buildFeature = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const feature = args.feature as MetaInsightsFeature
  const state = await liveAccountState(account.target)
  const refused = metaAccountChangeRefusal(state)
  if (refused) return { refusal: refused }
  const draft = insightsFeatureDraft(feature, state, await liveInsightsFeature(account.target, feature))
  return 'refusal' in draft ? draft : withFeatureSender(draft, feature)
})

const setMetaInsightsFeatures: AgentTool = {
  name: 'set-meta-insights-features',
  title: 'Switch on a Meta insights feature',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Meta: "there is no API to disable features" (insights/breakdowns) — no undo.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    feature: z.enum(META_INSIGHTS_FEATURES).describe('comscore (comscore_market breakdown), impression_device, time_of_day_viewer_tz (hourly numbers in the viewer\'s time zone) or frequency_value'),
    why: metaWhyArg,
  }),
  description:
    'Switch on ONE restricted insights breakdown for the business\'s chosen Meta ad account: comscore, impression_device, '
    + 'time_of_day_viewer_tz or frequency_value (until it is on, that breakdown comes back EMPTY, never 0). THIS CANNOT BE '
    + 'UNDONE: Meta has no API to switch a feature off again. Nexus reads the account\'s features first and refuses one that '
    + 'is already on or that Meta does not offer the account. Data comes about 24 hours later, going forward. Meta\'s page '
    + 'does not name the permission it needs (Meta\'s 2026 notes say account administrators): when Meta refuses, the answer '
    + 'gives its words. It spends nothing. Refused on a disabled, risk-reviewed, closing, closed or compromised account. '
    + 'Meta has no check for this change.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildFeature(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildFeature(args), (draft) => ({
    data: { feature: (draft.after as { feature: string }).feature },
    before: draft.before,
    after: draft.after,
    noUndo: 'An insights feature switched on has no undo (Meta has no API to switch one off).',
  })),
}

export const META_ADS_ACCOUNT_SETTINGS_TOOLS: AgentTool[] = [setMetaAccountSettings, setMetaSpendCap, setMetaInsightsFeatures]
