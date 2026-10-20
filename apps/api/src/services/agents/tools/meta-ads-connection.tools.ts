/**
 * Meta ads, step 1 (2026-10-20) — the business's Meta connection.
 *
 * meta-connection, read only:
 *   view summary (default)  what Nexus keeps, no Meta call: the system user, the app id (never the secret), the token's
 *                           health from the last check (valid, expiry and when Nexus renews it, permissions, type), the
 *                           chosen ad account / Page / Instagram account, the pinned API version (master rows ACC-013,
 *                           ACC-015)
 *   view check              LIVE: debug_token now (ACC-007, ACC-008: with the app token) and the usage Meta reports on
 *                           one cheap read — Business Use Case, ad account and app usage, the access tier, a version
 *                           warning (ACC-016, ACC-018, ACC-019). Nothing is kept
 *   view permissions        LIVE: the permissions the token holds, granted or declined (ACC-011)
 *   view app                LIVE: the app's roles, the ad accounts it is authorised for in the business, its connected
 *                           client businesses (ACC-037, ACC-038, ACC-903; app token)
 *   view choices            LIVE (kept 5 minutes): the ad accounts, Pages and Instagram accounts the system user can see,
 *                           each marked when another business in Nexus already uses it (never which)
 * (ACC-900, the apps a user is assigned to, needs manage_app_solution — not a system-user permission: not offered.)
 *
 * set-meta-connection (Owner 2026-10-20 "yes 1"): ask to choose the business's ad account, Page and Instagram account
 * from what its system user can see. A Nexus-only change a person approves in Nexus; it runs as that person. It saves
 * through the same service as the Settings card (saveMetaSelection), so a Meta id another business uses is refused there
 * too (the unique index). Undo puts the previous choice back.
 *
 * Connecting Meta and replacing its credentials are a person's, in Settings › Channels › Meta: an app secret or a token
 * never travels through a tool (Owner rule). Making, renewing and revoking a token in Meta are the Owner's in Meta
 * Business settings; Nexus renews a 60-day token on its own (token.service.ts renewMetaToken).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'
import {
  getMetaChoices, listMetaConnections, metaChoicesAnswer, MetaConnectionNotFound, MetaSelectionError, parseMetaSelection, saveMetaSelection,
  type MetaConnection,
} from '../../meta/meta-accounts.service.js'
import { liveApp, liveConnectionCheck, livePermissions, MetaLiveError } from '../../meta/meta-connection-live.js'
import { metaGraphApiVersion } from '../../meta/api-version.js'

export const META_CONNECTION_VIEWS = ['summary', 'check', 'permissions', 'app', 'choices'] as const
type View = typeof META_CONNECTION_VIEWS[number]

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)

const NOT_THIS_BUSINESS = 'This Meta connection is not connected to this business. Read meta-connection for the right one.'

const NOT_CONNECTED = 'Meta is not connected for this business. A person connects it in Settings › Channels › Meta (the Meta app id, app secret and a system-user token); Claude never takes those.'

/** The connection a call is about: the one named, else the one with an ad account chosen, else the first. */
function pick(connections: MetaConnection[], connectionId: string | undefined): MetaConnection | null {
  if (connectionId) return connections.find((c) => c.connectionId === connectionId) ?? null
  return connections[0] ?? null
}

const metaConnection: AgentTool = {
  name: 'meta-connection',
  title: 'Meta connection',
  category: 'settings',
  riskTier: 'low',
  readOnly: true,
  // Views check, permissions, app and choices read Meta live.
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(META_CONNECTION_VIEWS)).default('summary')
      .describe('what to read: summary (what Nexus keeps, no Meta call) | check (token and usage, live) | permissions (live) | app (live) | choices (what the system user can see, live)'),
    connectionId: z.string().trim().min(1).max(64).optional().describe('the Meta connection (from a previous answer); default: this business\'s one'),
  }),
  description:
    'The business\'s Meta (Facebook + Instagram ads) connection, read only. view summary (default, no Meta call): the '
    + 'system user, the Meta app id (never the secret), the token\'s health from the last check — valid, expiry and when '
    + 'Nexus renews it, the permissions it carries and those it lacks with what each is for, the token type ("not '
    + 'reported" when Meta does not say) — the chosen ad account, Facebook Page and Instagram account, and the pinned Meta '
    + 'API version. check: debug_token now and the usage Meta reports on one cheap read (Business Use Case, ad account '
    + 'and app usage in percent, the access tier, a version warning). permissions: granted and declined permissions. app: '
    + 'the app\'s roles, the ad accounts it is authorised for in the business portfolio, its connected client businesses. '
    + 'choices: the ad accounts, Facebook Pages and Instagram accounts the system user can see (read live, kept 5 minutes), '
    + 'each marked when another business in Nexus already uses it (a Meta id belongs to one business; never which) — '
    + 'set-meta-connection asks to choose among them. Connecting Meta and replacing its credentials are a person\'s in '
    + 'Settings › Channels › Meta; Claude never takes an app secret or a token. Nexus only reads Meta for now.',
  async handler(args): Promise<ToolResult> {
    const view = (args.view ?? 'summary') as View
    const connections = await listMetaConnections()
    const connection = pick(connections, typeof args.connectionId === 'string' ? args.connectionId : undefined)
    if (!connection) {
      return args.connectionId
        ? { ok: false, error: 'No Meta connection of this business has that id. Read view summary for the right one.' }
        : { ok: true, data: { connected: false, sentence: NOT_CONNECTED, apiVersion: metaGraphApiVersion() } }
    }
    if (view === 'summary') return { ok: true, data: { connected: true, apiVersion: metaGraphApiVersion(), connection, others: connections.length - 1 } }
    try {
      if (view === 'check') {
        const live = await liveConnectionCheck(connection.connectionId, connection.adAccount?.adAccountId ?? null)
        return { ok: true, data: { source: 'Read live from Meta now; nothing was kept.', connectionId: connection.connectionId, ...live } }
      }
      if (view === 'permissions') {
        const permissions = await livePermissions(connection.connectionId)
        return { ok: true, data: { source: 'Read live from Meta now.', connectionId: connection.connectionId, granted: permissions.filter((p) => p.status === 'granted').map((p) => p.permission), declined: permissions.filter((p) => p.status !== 'granted') } }
      }
      if (view === 'app') {
        return { ok: true, data: { source: 'Read live from Meta now, with the app\'s own token.', connectionId: connection.connectionId, ...(await liveApp(connection.connectionId, connection.adAccount?.businessId ?? null)) } }
      }
      if (view === 'choices') {
        const answer = await metaChoicesAnswer(await getMetaChoices(connection.connectionId))
        return {
          ok: true,
          data: {
            source: 'Read live from Meta (Nexus keeps it at most 5 minutes). An item marked takenByAnotherBusiness is used by another business in Nexus and cannot be chosen here.',
            connectionId: connection.connectionId, chosen: picksOf(connection), ...answer,
          },
        }
      }
      return { ok: false, error: 'Unknown view.' }
    } catch (err) {
      if (err instanceof MetaLiveError) return { ok: false, error: err.message }
      if (err instanceof MetaConnectionNotFound) return { ok: false, error: NOT_THIS_BUSINESS }
      throw err
    }
  },
}

// ── set-meta-connection ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A choice, by id only: what a person approves and what undo compares. Names are Meta's and may change at any time, so
 * they are in the preview's words, never in what was approved.
 */
export interface MetaPicks { connectionId: string; adAccountId: string | null; pageId: string | null; instagramId: string | null }

function picksOf(connection: MetaConnection): MetaPicks {
  return { connectionId: connection.connectionId, adAccountId: connection.adAccount?.adAccountId ?? null, pageId: connection.page?.pageId ?? null, instagramId: connection.instagram?.instagramId ?? null }
}

/** “Name” (id), or none. */
const named = (name: string | null | undefined, id: string | null): string => (id ? `“${name ?? 'no name'}” (${id})` : 'none')

const TAKEN_HERE = {
  adAccount: 'Another business in Nexus already reads this Meta ad account: an ad account belongs to one business only. Choose another, or a person disconnects Meta in the other business first.',
  page: 'Another business in Nexus already uses this Facebook Page: a Page belongs to one business only. Choose another, or a person disconnects Meta in the other business first.',
  instagram: 'Another business in Nexus already uses this Instagram account: an Instagram account belongs to one business only. Choose another, or a person disconnects Meta in the other business first.',
} as const

interface SetPlan { basis: MetaPicks; plan: MetaPicks; changes: Record<string, { from: string; to: string }>; systemUser: { id: string; name: string | null } | null }

/**
 * The choice asked, checked against what the business's system user can see now (Meta, kept 5 minutes) and against what
 * other businesses use. A field left out keeps the current choice; null takes a Page or an Instagram account away.
 */
async function setPlanOf(args: Record<string, unknown>): Promise<SetPlan | { error: string }> {
  const given = (['adAccountId', 'pageId', 'instagramId'] as const).filter((key) => args[key] !== undefined)
  if (given.length === 0) return { error: 'Nothing to change: name the ad account, the Facebook Page or the Instagram account to choose (meta-connection view choices lists them).' }
  const connections = await listMetaConnections()
  const connection = pick(connections, typeof args.connectionId === 'string' ? args.connectionId : undefined)
  if (!connection) return { error: args.connectionId ? NOT_THIS_BUSINESS : NOT_CONNECTED }
  if (connection.state === 'sign_in_needed') {
    return { error: 'Meta needs a new system-user token for this business before its assets can be chosen. A person enters it in Settings › Channels › Meta; Claude never takes it.' }
  }
  const basis = picksOf(connection)
  const asked = {
    adAccountId: args.adAccountId === undefined ? basis.adAccountId : args.adAccountId,
    pageId: args.pageId === undefined ? basis.pageId : args.pageId,
    instagramId: args.instagramId === undefined ? basis.instagramId : args.instagramId,
  }
  let selection
  try {
    selection = parseMetaSelection(asked)
  } catch (err) {
    if (err instanceof MetaSelectionError) return { error: err.message }
    throw err
  }
  let answer: Awaited<ReturnType<typeof metaChoicesAnswer>>
  try {
    answer = await metaChoicesAnswer(await getMetaChoices(connection.connectionId))
  } catch (err) {
    if (err instanceof MetaConnectionNotFound) return { error: NOT_THIS_BUSINESS }
    throw err
  }
  const cannotSee = (what: string, error: string | null) => `Meta does not show this ${what} to the business's system user${error ? ` (${error})` : ''}. `
    + 'Assign it to the system user in Meta Business settings, or choose one meta-connection view choices lists.'
  const account = answer.adAccounts.items.find((a) => a.adAccountId === selection.adAccountId)
  if (!account) return { error: cannotSee('ad account', answer.adAccounts.error) }
  if (account.takenByAnotherBusiness) return { error: TAKEN_HERE.adAccount }
  const page = selection.pageId ? answer.pages.items.find((p) => p.pageId === selection.pageId) : null
  if (selection.pageId && !page) return { error: cannotSee('Facebook Page', answer.pages.error) }
  if (page?.takenByAnotherBusiness) return { error: TAKEN_HERE.page }
  const instagram = selection.instagramId ? answer.instagram.items.find((i) => i.instagramId === selection.instagramId) : null
  if (selection.instagramId && !instagram) return { error: cannotSee('Instagram account', answer.instagram.error) }
  if (instagram?.takenByAnotherBusiness) return { error: TAKEN_HERE.instagram }

  const plan: MetaPicks = { connectionId: connection.connectionId, adAccountId: account.adAccountId, pageId: page?.pageId ?? null, instagramId: instagram?.instagramId ?? null }
  const changes: SetPlan['changes'] = {}
  if (plan.adAccountId !== basis.adAccountId) changes.adAccount = { from: named(connection.adAccount?.name, basis.adAccountId), to: named(account.name, plan.adAccountId) }
  if (plan.pageId !== basis.pageId) changes.page = { from: named(connection.page?.name, basis.pageId), to: named(page?.name, plan.pageId) }
  if (plan.instagramId !== basis.instagramId) {
    changes.instagram = {
      from: named(connection.instagram?.username ? `@${connection.instagram.username}` : null, basis.instagramId),
      to: named(instagram?.username ? `@${instagram.username}` : null, plan.instagramId),
    }
  }
  if (Object.keys(changes).length === 0) return { error: 'Nothing to change: the business already has this choice.' }
  return { basis, plan, changes, systemUser: answer.systemUser }
}

const WORDS: Record<string, string> = { adAccount: 'ad account', page: 'Facebook Page', instagram: 'Instagram account' }
const summaryOf = (changes: SetPlan['changes']) => Object.entries(changes).map(([key, c]) => `${WORDS[key]} ${c.from} → ${c.to}`).join('; ')

/** C2 — the previous choice goes back through this tool; a first choice cannot be taken away by Claude. */
const SET_UNDO: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Partial<MetaPicks>
    const connection = (await listMetaConnections()).find((c) => c.connectionId === after.connectionId)
    return connection ? picksOf(connection) : null
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<MetaPicks>
    if (typeof before.connectionId !== 'string') return { refusal: 'This change does not record the choice it replaced.' }
    if (!before.adAccountId) {
      return { refusal: 'Before this change the business had no Meta ad account chosen, and a choice cannot be taken away here: a person disconnects Meta in Settings › Channels › Meta for that.' }
    }
    return { tool: 'set-meta-connection', args: { connectionId: before.connectionId, adAccountId: before.adAccountId, pageId: before.pageId ?? null, instagramId: before.instagramId ?? null } }
  },
}

const metaId = () => z.string().trim().min(1).max(40)

const setMetaConnection: AgentTool = {
  name: 'set-meta-connection',
  title: 'Choose the Meta ad account and Page',
  category: 'settings',
  riskTier: 'high',
  readOnly: false,
  // The preview reads what the system user can see from Meta; the change itself is saved in Nexus only.
  openWorld: true,
  alwaysAsk: true,
  maxClaudeTrust: 'ask',
  requiresApprovalDefault: true,
  // A first choice cannot be taken away by undo (a person disconnects Meta for that).
  reversibility: 'partial',
  // Owner 2026-10-20 "yes 1" — ads.connect only, never settings.integrations.manage (tool-never NEVER_EXCEPTIONS).
  requires: [F.adsConnect],
  input: z.object({
    connectionId: z.string().trim().min(1).max(64).optional().describe('the Meta connection (meta-connection view summary); default: this business\'s one'),
    adAccountId: metaId().optional().describe('the Meta ad account Nexus reads for this business: its id (digits; act_ is dropped), from meta-connection view choices; left out: the current one'),
    pageId: metaId().nullable().optional().describe('the Facebook Page: its id, from meta-connection view choices; null: no Page; left out: the current one'),
    instagramId: metaId().nullable().optional().describe('the Instagram account: its id, from meta-connection view choices; null: no Instagram account; left out: the current one'),
  }),
  description:
    'Choose, for this business, the Meta ad account Nexus reads and, optionally, its Facebook Page and Instagram account — '
    + 'only from what the business\'s Meta system user can see (meta-connection view choices lists them). A Meta id belongs '
    + 'to one business only: one another business in Nexus already uses is refused, without naming it. A field left out '
    + 'keeps the current choice; pageId or instagramId null takes that choice away. The preview shows each choice from → '
    + 'to with its name and id. Nothing changes until a person approves it in Nexus (Approvals); it then runs as that '
    + 'person, never by a rule, and only if the choice it stands on did not move. Saved in Nexus only: nothing is sent to '
    + 'Meta. It never takes or returns an app secret or a token and cannot renew or revoke a token (Nexus renews it on its '
    + 'own); connecting Meta and replacing its credentials stay a person\'s, in Settings › Channels › Meta. Undo puts the '
    + 'previous choice back; a first choice cannot be taken back here.',
  undo: SET_UNDO,
  async handler(args): Promise<ToolResult> {
    const planned = await setPlanOf(args)
    if ('error' in planned) return { ok: false, error: planned.error }
    return {
      ok: true,
      preview: {
        action: 'set-meta-connection',
        summary: `Meta for this business: ${summaryOf(planned.changes)}.`,
        changes: planned.changes,
        systemUser: planned.systemUser,
        basis: planned.basis,
        plan: planned.plan,
        reach: { mode: 'nexus', connectionId: planned.plan.connectionId },
        note: 'Saved in Nexus only: Nexus reads this ad account (and uses this Page and Instagram account) for this business. Nothing changes in Meta; the token, its renewal and the Meta app stay as they are. Undo puts the previous choice back.',
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const planned = await setPlanOf(args)
    if ('error' in planned) return { ok: false, error: `Not changed: ${planned.error}` }
    try {
      const { plan } = planned
      const saved = await saveMetaSelection(plan.connectionId, { adAccountId: plan.adAccountId, pageId: plan.pageId, instagramId: plan.instagramId }, { userId: ctx.userId ?? null })
      if (!saved.changed) return { ok: true, data: { changed: false, sentence: 'Nothing changed: the business already had this choice.' } }
      const { adAccount, page, instagram, state, stateText } = saved.connection
      return {
        ok: true,
        data: { changed: true, sentence: `Saved in Nexus: ${summaryOf(planned.changes)}.`, connectionId: plan.connectionId, adAccount, page, instagram, state, stateText },
        // C1 — the choice it replaced and the one it saved, by id (`undo.current` reads it back).
        change: { before: planned.basis, after: plan },
      }
    } catch (err) {
      if (err instanceof MetaSelectionError) return { ok: false, error: `Not changed: ${err.message}` }
      throw err
    }
  },
}

export const META_ADS_CONNECTION_TOOLS: AgentTool[] = [metaConnection, setMetaConnection]
