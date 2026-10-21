/**
 * Meta step 32 — the ONE rule for whose dataset, custom conversion and event source group a change of THIS business
 * names. The tools ask it before the preview and when the approved change runs (meta-ads-signals.tools.ts),
 * and the gateway asks it again before anything is sent (gateway.ts 3b, `metaSignalsProblem`). Reads only, through the
 * gateway; every pixel judged with step 11's verdict (live-audiences.ts ownPixel / pixelVerdict), never assumed free.
 *
 *   ad account     only the chosen one (`act_<chosen>`: step 19's check — the gateway runs it before this rule).
 *   portfolio      only the chosen ad account's business portfolio, read live (`act_<id>?fields=business{id}`), and never
 *                  one another Nexus business's chosen ad account is also in (nexus_meta_links_taken PORTFOLIO): two
 *                  businesses in one portfolio never change its datasets or groups from Nexus.
 *   pixel          one of the chosen ad account's pixels that no other Nexus business uses (step 11's verdict: taken,
 *                  unchecked or free — only free is changed). To CONNECT a pixel that is not on the chosen ad account yet:
 *                  one the chosen portfolio owns, and every ad account and partner portfolio it is shared with checked
 *                  (the same reads as the verdict).
 *   ad account in a body (account_id, accounts)   only the chosen ad account; business = the chosen portfolio.
 *   custom conversion   of the chosen ad account (its account_id), its pixel free; to delete, one Nexus made (its create
 *                  is in this business's own change records: AgentChange of set-meta-custom-conversion, after.created); to
 *                  claim, one no business portfolio holds yet (its business{id}: review B2).
 *   event source group  one of the chosen portfolio's (`<portfolio>/event_source_groups`), every dataset in it free.
 *   Page / Instagram    the business's chosen Page / Instagram account (its MetaAccountLink), and no other's — the tools
 *                  ask it here; the gateway asks step 28's (Page) and step 31's (Instagram) rule, the same meaning.
 * Partner portfolios, server-event businesses and people on a dataset are not step 32's (lane C3 decision): no rule here.
 * Checked 2026-10-21: reference/ad-account (business), business/event_source_groups (fields id, name; SDK
 * eventsourcegroup.py event_sources, owner_business), custom-conversion (account_id, pixel, business), ads-pixel
 * (owner_business).
 */
import prisma from '../../../db.js'
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { canonicalJson } from '../../gateway/meta-signals-rules.js'
import type { MetaWriteKind } from '../../gateway/meta-calls.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { act, chosenPixelIds, ownPixel, part, pixelAccounts, readRows, refuse } from './live-audiences.js'
import { metaReadOne } from './read-client.js'
import { takenIds } from './taken.js'

/** The tool that creates custom conversions: its change records say which ones Nexus made. */
export const CUSTOM_CONVERSION_TOOL = 'set-meta-custom-conversion'

const idOf = (v: unknown): string | null => (v && typeof v === 'object' ? metaObjectId((v as { id?: unknown }).id) : metaObjectId(v))
const MAX_PARTNERS = 5

// ── the pieces (each throws MetaLiveRefusal with words; a tool turns it into its refusal) ─────────────────────────────

/** The chosen ad account's business portfolio, read live, that no other Nexus business shares. */
export async function ownPortfolio(account: MetaChosenAccount): Promise<string> {
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'signalsRule.portfolio', path: act(account.adAccountId), query: { fields: 'business{id}' } })
  const id = idOf((read.body as { business?: unknown }).business)
  if (!id) refuse('The chosen ad account belongs to no business portfolio, so Nexus changes nothing at the portfolio level (its datasets and event source groups).')
  if ((await takenIds('PORTFOLIO', [id])).size > 0) {
    refuse('Another business in Nexus also has an ad account in this Meta business portfolio, so what lives at the portfolio level (its datasets, event source groups, custom conversions it holds) may be that business\'s too: Nexus changes none of it. A person does it in Meta\'s business settings.')
  }
  return id
}

/** A pixel of the chosen ad account that no other Nexus business uses (step 11's verdict), else refused in words. */
export const ownSignalPixel = (account: MetaChosenAccount, pixelId: string): Promise<string> => ownPixel(account, pixelId, false)

/**
 * A pixel the chosen ad account may be CONNECTED to: one already on it (then free by step 11's verdict), or one the chosen
 * portfolio owns whose ad accounts (in the portfolio and in every partner portfolio) and partner portfolios are none
 * another Nexus business's — the reads of step 11's verdict, without its "the chosen ad account is among them" (it is
 * not yet: that is the change).
 */
export async function connectablePixel(account: MetaChosenAccount, pixelId: string): Promise<{ pixelId: string; onAccount: boolean }> {
  const id = metaObjectId(pixelId) ?? refuse(`"${pixelId}" is not a Meta pixel id (digits).`)
  if ((await chosenPixelIds(account)).includes(id)) return { pixelId: await ownSignalPixel(account, id), onAccount: true }
  const portfolio = await ownPortfolio(account)
  const owner = await metaReadOne({ connectionId: account.connectionId }, { operation: 'signalsRule.pixelOwner', path: id, query: { fields: 'owner_business{id}' } })
  if (idOf((owner.body as { owner_business?: unknown }).owner_business) !== portfolio) {
    refuse('That pixel is not on the chosen ad account and not owned by its business portfolio, so Nexus does not connect it (whose it is cannot be checked). The portfolio that owns it shares it in Meta\'s business settings.')
  }
  const [sharedAgencies, agencies] = await Promise.all([
    readRows(account.connectionId, 'signalsRule.pixelAgencies', `${id}/shared_agencies`, { fields: 'id' }, MAX_PARTNERS + 1),
    readRows(account.connectionId, 'signalsRule.pixelAgencies', `${id}/agencies`, { fields: 'id' }, MAX_PARTNERS + 1),
  ])
  const partners = [...new Set([...sharedAgencies.rows, ...agencies.rows].map((r) => idOf(r.id)).filter((p): p is string => !!p && p !== portfolio))]
  if ((await takenIds('PORTFOLIO', partners)).size > 0) refuse('That pixel is shared with a business portfolio another business in Nexus uses, so Nexus does not connect it.')
  if (sharedAgencies.more || agencies.more || partners.length > MAX_PARTNERS) refuse(`That pixel is shared with more business portfolios than Nexus checks at once (${MAX_PARTNERS}), so it is not connected from Nexus.`)
  const accounts = await pixelAccounts(account, id, 200)
  if (accounts.usedByAnotherBusiness) refuse('That pixel is connected to an ad account another business in Nexus uses, so Nexus does not connect it here.')
  if (accounts.more) refuse('That pixel is connected to more ad accounts than Nexus reads at once (200), so it is not connected from Nexus.')
  for (const businessId of partners) {
    const read = await part(() => readRows(account.connectionId, 'signalsRule.partnerAccounts', `${id}/shared_accounts`, { business: businessId, fields: 'account_id' }, 200))
    if ('refused' in read) refuse(`That pixel is shared with a partner portfolio whose ad accounts Meta does not show (${read.refused}), so Nexus does not connect it.`)
    if (read.more) refuse('That pixel is connected to more ad accounts of a partner portfolio than Nexus reads at once (200).')
    if ((await takenIds('AD_ACCOUNT', read.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((a): a is string => !!a))).size > 0) {
      refuse('That pixel is connected to an ad account another business in Nexus uses, so Nexus does not connect it here.')
    }
  }
  return { pixelId: id, onAccount: false }
}

/** Did Nexus make this custom conversion, for this business, on this ad account? (Its own change records, row-level security.) */
export async function nexusMadeConversion(adAccountId: string, customConversionId: string): Promise<boolean> {
  const row = await prisma.agentChange.findFirst({
    where: {
      toolName: CUSTOM_CONVERSION_TOOL,
      AND: [
        { after: { path: ['created'], equals: true } },
        { after: { path: ['customConversionId'], equals: customConversionId } },
        { after: { path: ['adAccountId'], equals: adAccountId } },
      ],
    },
    select: { id: true },
  })
  return row !== null
}

/** A custom conversion of the chosen ad account whose pixel no other Nexus business uses (and, to delete, one Nexus made). */
export async function ownConversion(account: MetaChosenAccount, customConversionId: string, opts: { nexusMade?: boolean } = {}): Promise<{ id: string; pixelId: string; businessId: string | null }> {
  const id = metaObjectId(customConversionId) ?? refuse(`"${customConversionId}" is not a Meta custom conversion id (digits).`)
  // custom_event_type: only a custom conversion has one, so no other object of the account passes (step 11 review A7).
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'signalsRule.conversion', path: id, query: { fields: 'account_id,custom_event_type,pixel{id},business{id}' } })
  const body = read.body as { account_id?: unknown; custom_event_type?: unknown; pixel?: unknown; business?: unknown }
  if (metaAdAccountId(body.account_id) !== account.adAccountId || typeof body.custom_event_type !== 'string') refuse('That is not a custom conversion of the chosen ad account, so Nexus does not change it.')
  const pixelId = idOf(body.pixel) ?? refuse('Meta names no pixel for that custom conversion, so Nexus cannot check whether another business in Nexus counts its events; it is not changed.')
  await ownSignalPixel(account, pixelId)
  if (opts.nexusMade && !(await nexusMadeConversion(account.adAccountId, id))) {
    refuse('Nexus deletes only a custom conversion it made itself (set-meta-custom-conversion), and its records hold no such create for this one: a person deletes it in Events Manager.')
  }
  return { id, pixelId, businessId: idOf(body.business) }
}

/** An event source group of the chosen portfolio whose datasets are all free pixels of the chosen ad account. */
export async function ownGroup(account: MetaChosenAccount, groupId: string, portfolio: string): Promise<{ id: string; name: string | null; pixelIds: string[] }> {
  const id = metaObjectId(groupId) ?? refuse(`"${groupId}" is not a Meta event source group id (digits).`)
  const listed = await readRows(account.connectionId, 'signalsRule.groups', `${portfolio}/event_source_groups`, { fields: 'id' }, 500)
  if (!listed.rows.some((r) => idOf(r.id) === id)) {
    refuse(listed.more ? 'The portfolio has more event source groups than Nexus reads at once (500), and that one was not among them.' : 'That is not an event source group of the chosen ad account\'s business portfolio, so Nexus does not change it.')
  }
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'signalsRule.group', path: id, query: { fields: 'id,name,event_sources{id}' } })
  const body = read.body as { name?: unknown; event_sources?: unknown }
  const sources = Array.isArray(body.event_sources) ? body.event_sources : body.event_sources && typeof body.event_sources === 'object' && Array.isArray((body.event_sources as { data?: unknown }).data) ? (body.event_sources as { data: unknown[] }).data : null
  if (!sources) refuse('Meta does not list the datasets in that event source group, so Nexus cannot check whose they are; it is not changed.')
  const pixelIds = sources.map(idOf).filter((p): p is string => !!p)
  for (const pixelId of pixelIds) await ownSignalPixel(account, pixelId)
  return { id, name: typeof body.name === 'string' ? body.name : null, pixelIds }
}

/** The business's chosen Facebook Page / Instagram account (its MetaAccountLink through this connection). */
export async function ownMessagingAccount(account: MetaChosenAccount, kind: 'page' | 'instagram', id: string): Promise<string> {
  const chosen = kind === 'page' ? account.pageId : account.instagramId
  const link = chosen ? await prisma.metaAccountLink.findFirst({ where: { connectionId: account.connectionId, product: kind === 'page' ? 'PAGE' : 'INSTAGRAM', externalId: chosen }, select: { id: true } }) : null
  if (!chosen || !link) refuse(kind === 'page' ? 'This business has no Facebook Page chosen in Nexus (Settings › Channels › Meta), so no Page dataset is made.' : 'This business has no Instagram account chosen in Nexus (Settings › Channels › Meta), so no Instagram dataset is made.')
  if (id !== chosen) refuse(`That is not the ${kind === 'page' ? 'Facebook Page' : 'Instagram account'} this business chose in Nexus.`)
  return chosen
}

// ── the gateway's check of one judged change ─────────────────────────────────────────────────────────────────────────

const jsonIds = (value: string | undefined): string[] | null => {
  const list = value === undefined ? null : canonicalJson(value)
  return Array.isArray(list) && list.every((v) => typeof v === 'string') ? list as string[] : null
}

async function judge(account: MetaChosenAccount, rule: string, objectId: string, kind: MetaWriteKind, params: ReadonlyMap<string, string>): Promise<void> {
  const accountBody = async () => {
    const portfolio = await ownPortfolio(account)
    if (params.get('account_id') !== account.adAccountId) refuse('A dataset is connected to or disconnected from the chosen ad account only.')
    if (params.get('business') !== portfolio) refuse('A dataset\'s ad account is named with the chosen ad account\'s own business portfolio only.')
  }
  switch (kind) {
    case 'adaccount': {
      // act_<the chosen account> itself is step 19's check (gateway.ts metaOwnerProblem, run first): here only the body.
      if (rule === 'customConversion.create') await ownSignalPixel(account, params.get('event_source_id') ?? '')
      return
    }
    case 'datasetportfolio': {
      const portfolio = await ownPortfolio(account)
      if (objectId !== portfolio) refuse('That business portfolio is not the chosen ad account\'s.')
      if (rule === 'eventSourceGroup.create') for (const pixelId of jsonIds(params.get('event_sources')) ?? refuse('event_sources lists datasets.')) await ownSignalPixel(account, pixelId)
      if (rule === 'customConversion.claim') {
        // Review B2 — only one no business portfolio holds yet.
        const { businessId } = await ownConversion(account, params.get('custom_conversion_id') ?? '')
        if (businessId) refuse(businessId === portfolio ? 'That custom conversion is already the chosen portfolio\'s: nothing to claim.' : 'That custom conversion is held by another business portfolio, so Nexus does not claim it.')
      }
      return
    }
    case 'dataset': {
      if (rule === 'dataset.connectAccount') { await connectablePixel(account, objectId); await accountBody(); return }
      await ownSignalPixel(account, objectId)
      if (rule === 'dataset.disconnectAccount') { await accountBody(); return }
      return
    }
    case 'datasetconversion': {
      await ownConversion(account, objectId, { nexusMade: rule === 'customConversion.delete' })
      return
    }
    case 'eventsourcegroup': {
      const portfolio = await ownPortfolio(account)
      await ownGroup(account, objectId, portfolio)
      if (rule === 'eventSourceGroup.update' && params.has('event_sources')) for (const pixelId of jsonIds(params.get('event_sources')) ?? refuse('event_sources lists datasets.')) await ownSignalPixel(account, pixelId)
      if (rule === 'eventSourceGroup.share') {
        const accounts = jsonIds(params.get('accounts'))
        if (!accounts || accounts.length !== 1 || accounts[0] !== account.adAccountId) refuse('An event source group is shared with the chosen ad account only.')
      }
      return
    }
    // The chosen Page (step 28's rule) and the chosen Instagram account (step 31's) are checked by the gateway first.
    case 'page':
    case 'instagram':
      return
    default:
      refuse(`A dataset or custom conversion change does not name ${objectId} as ${kind}.`)
  }
}

/**
 * The gateway's question (gateway.ts 3b): why this judged step 32 change may not be sent for this connection, or null.
 * Never Meta's check (none is documented for these changes); any read that fails refuses it.
 */
export async function metaSignalsProblem(connectionId: string, write: { rule: string; objectId: string; check: boolean; body: string }, kind: MetaWriteKind): Promise<{ code: string; sentence: string } | null> {
  const no = (code: string, sentence: string) => ({ code, sentence: `Nothing was sent to Meta: ${sentence}` })
  if (write.check) return no('META_WRITE_NOT_ALLOWED', 'Meta has no check (validate_only) for a dataset, custom conversion or event source group change.')
  try {
    const account = await metaChosenAccount(connectionId)
    await judge(account, write.rule, write.objectId, kind, new Map(new URLSearchParams(write.body)))
    return null
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return no('META_ACCOUNT_NOT_CHOSEN', err.message)
    if (err instanceof MetaReadError) return no('META_ACCOUNT_UNCONFIRMED', `Nexus could not confirm whose it is (${err.message}).`)
    return no('META_ACCOUNT_UNCONFIRMED', `Nexus could not confirm whose it is (${err instanceof Error ? err.message : String(err)}).`)
  }
}
