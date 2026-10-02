/**
 * MCP full control P4 — the business itself, read: who it is, the channel accounts it holds, how its channels are
 * doing, and who works in it (plan section 09 §4).
 *
 * Read only and low risk: they read this business's own rows (row-level security and the workspace client) and
 * call no marketplace. Nothing here changes an account, a person or a role: every one of those changes is never for
 * Claude (09 §2) and stays a person's click in Nexus. The reads that sit next to those areas hand Claude only what a
 * person may decide with — names, states, dates — never a token, a secret, an app id or a person's e-mail
 * (claude-safe.ts). Global tables (businesses, memberships, roles, people, account grants) are read for THIS business
 * only, by `workspaceIdForQuery()`.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { listAccountRows, type AccountRow } from '../../accounts/account-rows.service.js'
import { readBrandSettings } from '../../settings/brand-settings.service.js'
import { listConnectionEvents } from '../../cx/events.service.js'
import { HEALTH_CHANNELS, callsForTrace, channelHealth, type Metric } from '../../cx/channel-health.service.js'
import { connectionLabel } from '../../connection-label.js'
import type { AgentTool } from '../tool-types.js'
import { capped, personName, safeTextOrNull, safeValue } from './claude-safe.js'

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const iso = (at: Date | string | null | undefined) => (at == null ? null : typeof at === 'string' ? at : at.toISOString())
const profilesOn = () => process.env.NEXUS_WORKSPACES_ENABLED === '1'

/** The channels an account can be on (AccountRow.channel). */
const ACCOUNT_CHANNELS = ['AMAZON', 'AMAZON_ADS', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'] as const

// ── business-overview ─────────────────────────────────────────────────────────────────────────────────

/** The brand and legal fields of the business itself. Its own contact details, not a person's. */
const BRAND_FIELDS = [
  'companyName', 'addressLines', 'taxId', 'piva', 'codiceFiscale', 'sdiCode', 'pecEmail', 'vatScheme',
  'contactEmail', 'contactPhone', 'websiteUrl', 'logoUrl',
] as const

/** At most this many markets are listed; the rest are counted. */
const MARKET_CAP = 60

const businessOverview: AgentTool = {
  name: 'business-overview',
  title: 'Business overview',
  category: 'settings',
  description:
    'The business this connection works in: its name; its settings (country, currency, time zone, main market); its '
    + 'company and legal details (company name, address, VAT and tax ids, contact details, website, logo); the markets '
    + 'it sells on, with currency and content languages; and how many channel accounts are connected per channel. '
    + 'Read only.',
  input: z.object({}),
  requires: [F.settingsView],
  riskTier: 'low',
  readOnly: true,
  async handler() {
    const workspaceId = workspaceIdForQuery()
    const [workspace, settings, brand, markets, accounts] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
      prisma.accountSettings.findFirst({
        select: { businessName: true, country: true, currency: true, timezone: true, primaryMarketplace: true },
      }),
      readBrandSettings(),
      prisma.marketplace.findMany({
        orderBy: [{ isActive: 'desc' }, { channel: 'asc' }, { code: 'asc' }],
        select: { channel: true, code: true, name: true, currency: true, language: true, languages: true, isActive: true },
      }),
      prisma.channelConnection.groupBy({ by: ['channelType'], where: { isActive: true }, _count: { _all: true } }),
    ])
    const brandOut: Record<string, unknown> = {}
    for (const field of BRAND_FIELDS) {
      const value = (brand as Record<string, unknown> | null)?.[field]
      if (value != null && value !== '' && !(Array.isArray(value) && value.length === 0)) brandOut[field] = value
    }
    const listed = capped(markets, MARKET_CAP)
    return {
      ok: true,
      data: {
        name: workspace?.name ?? (settings?.businessName || null),
        settings: settings
          ? {
              businessName: settings.businessName || null,
              country: settings.country,
              currency: settings.currency,
              timezone: settings.timezone,
              primaryMarketplace: settings.primaryMarketplace,
            }
          : null,
        brand: brandOut,
        markets: listed.items.map((m) => ({
          channel: m.channel,
          code: m.code,
          name: m.name,
          currency: m.currency,
          languages: m.languages.length ? m.languages : [m.language],
          active: m.isActive,
        })),
        ...(listed.more ? { moreMarkets: listed.more } : {}),
        connectedAccounts: Object.fromEntries(
          accounts.sort((a, b) => a.channelType.localeCompare(b.channelType)).map((row) => [row.channelType, row._count._all]),
        ),
      },
    }
  },
}

// ── channel-connections ───────────────────────────────────────────────────────────────────────────────

interface Sharing {
  /** Accounts another business shares WITH this one: the owner's name and what the share allows. */
  sharedIn: Map<string, { by: string; mode: string; marketplaces: string[] }>
  /** Accounts this business owns and shares OUT: how many businesses each is shared with. */
  sharedOut: Map<string, number>
}

/**
 * Who else holds each account. A shared account is named only to its members: this business sees an account another
 * business shares with it (by its owner's name) and, for its own accounts, how many businesses it shares them with —
 * never which other accounts those businesses hold. With profiles off there is one business and no sharing.
 */
async function sharingOf(): Promise<Sharing> {
  const sharing: Sharing = { sharedIn: new Map(), sharedOut: new Map() }
  if (!profilesOn()) return sharing
  const workspaceId = workspaceIdForQuery()
  const [incoming, outgoing] = await Promise.all([
    prisma.channelAccountGrant.findMany({
      where: { workspaceId, revokedAt: null },
      select: { connectionId: true, mode: true, marketplaces: true, ownerWorkspace: { select: { name: true } } },
    }),
    prisma.channelAccountGrant.groupBy({
      by: ['connectionId'],
      where: { ownerWorkspaceId: workspaceId, revokedAt: null },
      _count: { _all: true },
    }),
  ])
  for (const grant of incoming) {
    sharing.sharedIn.set(grant.connectionId, { by: grant.ownerWorkspace.name, mode: grant.mode, marketplaces: grant.marketplaces })
  }
  for (const row of outgoing) sharing.sharedOut.set(row.connectionId, row._count._all)
  return sharing
}

/** One account as Claude reads it: names, states and dates — no identity blob, no token, no app id. */
function accountView(row: AccountRow, sharing: Sharing) {
  const sharedIn = sharing.sharedIn.get(row.id)
  const scopes = capped(row.scopes, 10)
  return {
    id: row.id,
    channel: row.channel,
    label: row.label,
    labelIsPlaceholder: row.labelIsPlaceholder,
    health: row.health,
    healthReason: safeTextOrNull(row.healthReason),
    authStatus: row.authStatus,
    isActive: row.isActive,
    isPrimary: row.isPrimary,
    region: row.region,
    markets: row.markets,
    scopes: scopes.items.map((scope) => ({ kind: scope.kind, externalId: scope.externalId, label: scope.label, active: scope.isActive ?? null })),
    ...(scopes.more ? { moreScopes: scopes.more } : {}),
    /** Permissions the channel now asks for that this sign-in lacks: reconnecting in Nexus grants them. */
    missingPermissions: row.scopeDrift,
    ownedHere: !sharedIn,
    ...(sharedIn ? { sharedBy: sharedIn.by, shareMode: sharedIn.mode, shareMarketplaces: sharedIn.marketplaces } : {}),
    ...(sharing.sharedOut.get(row.id) ? { sharedWithBusinesses: sharing.sharedOut.get(row.id) } : {}),
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncError: safeTextOrNull(row.lastSyncError),
    lastErrorAt: row.lastErrorAt,
    lastError: safeTextOrNull(row.lastError),
    consecutiveFailures: row.consecutiveFailures,
    /** When the sign-in itself runs out and a person must reconnect. Never the token. */
    signInExpiresAt: row.refreshTokenExpiresAt,
  }
}

const channelConnections: AgentTool = {
  name: 'channel-connections',
  title: 'Channel accounts',
  category: 'settings',
  description:
    'The channel accounts (Amazon, Amazon Ads, eBay, Shopify, Etsy, …) this business holds: name, health and why, '
    + 'sign-in state, markets and permissions each reaches, permissions missing since the channel asked for more, last '
    + 'sync and last error, and whether the account is this business\'s own or shared with it by another business. '
    + 'Name one account (connectionId) for its last 10 events. Read only: connecting, reconnecting and sharing '
    + 'accounts are done by a person in Nexus. Never shows a token or secret.',
  input: z.object({
    channel: z.preprocess(upper, z.enum(ACCOUNT_CHANNELS)).optional().describe('only this channel'),
    connectionId: z.string().trim().min(1).max(64).optional()
      .describe('one account by its id (from a previous answer): adds its last 10 events'),
    includeDisconnected: z.boolean().optional()
      .describe('also list accounts that were disconnected (default: live accounts only)'),
  }),
  requires: [F.settingsView],
  riskTier: 'low',
  readOnly: true,
  async handler(args) {
    const channel = args.channel as string | undefined
    const connectionId = args.connectionId as string | undefined
    // As GET /api/accounts: disconnected accounts are listed only with business profiles on.
    const includeDisconnected = profilesOn() && (args.includeDisconnected === true || !!connectionId)
    const [{ accounts, notConnected }, sharing] = await Promise.all([listAccountRows({ includeDisconnected }), sharingOf()])
    const rows = accounts.filter((row) => (!channel || row.channel === channel) && (!connectionId || row.id === connectionId))
    if (connectionId) {
      const [row] = rows
      if (!row) return { ok: false, error: 'Account not found' }
      const events = await listConnectionEvents(row.id, 10)
      return {
        ok: true,
        data: {
          account: accountView(row, sharing),
          events: events.map((event) => ({ type: event.type, at: iso(event.createdAt), detail: safeValue(event.detail) })),
        },
      }
    }
    return {
      ok: true,
      data: {
        accounts: rows.map((row) => accountView(row, sharing)),
        ...(channel ? {} : { notConnected }),
      },
    }
  },
}

// ── channel-health ───────────────────────────────────────────────────────────────────────────────────

const metricView = (metric: Metric) => ({ value: metric.value, target: metric.target, unit: metric.unit, verdict: metric.verdict, note: metric.note })

const channelHealthTool: AgentTool = {
  name: 'channel-health',
  title: 'Channel health',
  category: 'settings',
  description:
    'How each channel\'s connection is doing over a recent window (default 24 hours, at most 7 days): the share of '
    + 'calls that failed, the share that were slow, how long the oldest waiting change has waited, and how many '
    + 'incoming events gave up — each against its target with a verdict and one sentence, plus the five worst '
    + 'operations. Name a traceId (from sync activity) to see every channel call one change made, in order. Read only.',
  input: z.object({
    channel: z.preprocess(upper, z.enum(HEALTH_CHANNELS)).optional().describe('only this channel'),
    hours: z.coerce.number().int().min(1).max(168).optional().describe('the window in hours (default 24, at most 168)'),
    traceId: z.string().trim().min(1).max(100).optional()
      .describe('one change by its trace id: every channel call it made, oldest first'),
  }),
  requires: [F.settingsIntegrationsManage],
  riskTier: 'low',
  readOnly: true,
  async handler(args) {
    const channel = args.channel as string | undefined
    const hours = (args.hours as number | undefined) ?? 24
    const until = new Date()
    const health = await channelHealth({ since: new Date(until.getTime() - hours * 3_600_000), until, operationLimit: 5 })
    const channels = health
      .filter((row) => !channel || row.channel === channel)
      .map((row) => ({
        channel: row.channel,
        verdict: row.verdict,
        calls: row.calls,
        errorRate: metricView(row.errorRate),
        slowCalls: metricView(row.slowCalls),
        backlogAge: metricView(row.backlogAge),
        deadLetters: metricView(row.deadLetters),
        worstOperations: row.operations.map((op) => ({
          operation: op.operation,
          calls: op.calls,
          failed: op.failed,
          errorRate: metricView(op.errorRate),
          slowCalls: metricView(op.slowCalls),
        })),
      }))
    const traceId = args.traceId as string | undefined
    const trace = traceId ? await callsForTrace(traceId) : null
    return {
      ok: true,
      data: {
        hours,
        channels,
        ...(trace
          ? {
              trace: trace.length
                ? trace.slice(0, 50).map((call) => ({
                    channel: call.channel,
                    operation: call.operation,
                    method: call.method,
                    statusCode: call.statusCode,
                    success: call.success,
                    latencyMs: call.latencyMs,
                    errorClass: call.errorClass,
                    errorCode: call.errorCode,
                    errorMessage: safeTextOrNull(call.errorMessage),
                    productId: call.productId,
                    listingId: call.listingId,
                    at: iso(call.createdAt),
                  }))
                : 'No channel call carries this trace id in this business.',
            }
          : {}),
      },
    }
  },
}

// ── team-access ───────────────────────────────────────────────────────────────────────────────────────

const ROLE_CAP = 50
const MEMBER_CAP = 100

/** A role's permissions as Claude reads them: the owner holds all of them, whatever the row lists. */
const rolePermissions = (role: { key: string; permissions: string[] }) =>
  role.key === 'OWNER' ? 'all' : [...role.permissions].sort()

/**
 * The team of the business in context. The door checked `users.manage` and `roles.manage` for this business; the
 * read goes by the business, not by the caller's own membership row. Names only: no e-mail, no sign-in or 2FA state.
 */
async function businessTeam() {
  const workspaceId = workspaceIdForQuery()
  const [members, roles, pendingInvitations] = await Promise.all([
    prisma.workspaceMembership.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      take: MEMBER_CAP + 1,
      select: {
        status: true,
        user: { select: { displayName: true, status: true } },
        roles: { select: { role: { select: { key: true, name: true } } } },
        accountLimit: { select: { membershipId: true } },
        accounts: { select: { connectionId: true } },
      },
    }),
    prisma.role.findMany({
      where: { OR: [{ isSystem: true, workspaceId: null }, { workspaceId }] },
      orderBy: { name: 'asc' },
      take: ROLE_CAP + 1,
      select: { key: true, name: true, description: true, isSystem: true, permissions: true },
    }),
    prisma.workspaceInvitation.count({ where: { workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
  ])
  // The accounts a limited member may reach, by name. Only accounts this business can see are named.
  const limitedIds = [...new Set(members.flatMap((member) => (member.accountLimit ? member.accounts.map((a) => a.connectionId) : [])))]
  const labels = new Map<string, string>()
  if (limitedIds.length) {
    const rows = await prisma.channelConnection.findMany({
      where: { id: { in: limitedIds } },
      select: { id: true, channelType: true, accountLabel: true, ebayStoreName: true, displayName: true, ebaySignInName: true, externalAccountId: true },
    })
    for (const row of rows) labels.set(row.id, `${row.channelType} · ${connectionLabel(row as never).label}`)
  }
  return {
    members: members.slice(0, MEMBER_CAP).map((member) => ({
      name: personName(member.user.displayName),
      status: member.user.status === 'active' ? member.status : member.user.status,
      roles: member.roles.map(({ role }) => role.name),
      accounts: member.accountLimit
        ? member.accounts.map((a) => labels.get(a.connectionId)).filter((label): label is string => !!label)
        : 'all',
    })),
    ...(members.length > MEMBER_CAP ? { moreMembers: true } : {}),
    roles: roles.slice(0, ROLE_CAP).map((role) => ({
      name: role.name,
      key: role.key,
      system: role.isSystem,
      description: safeTextOrNull(role.description || null),
      permissions: rolePermissions(role),
    })),
    ...(roles.length > ROLE_CAP ? { moreRoles: true } : {}),
    pendingInvitations,
  }
}

/** Business profiles off: one business, and its team is everyone with a Nexus sign-in (Settings › Team & Access). */
async function globalTeam() {
  const [people, roles] = await Promise.all([
    prisma.userProfile.findMany({
      orderBy: { createdAt: 'asc' },
      take: MEMBER_CAP + 1,
      select: { displayName: true, status: true, roleAssignments: { select: { role: { select: { name: true } } } } },
    }),
    prisma.role.findMany({
      where: { workspaceId: null },
      orderBy: { name: 'asc' },
      take: ROLE_CAP + 1,
      select: { key: true, name: true, description: true, isSystem: true, permissions: true },
    }),
  ])
  return {
    members: people.slice(0, MEMBER_CAP).map((person) => ({
      name: personName(person.displayName),
      status: person.status,
      roles: person.roleAssignments.map(({ role }) => role.name),
      accounts: 'all',
    })),
    ...(people.length > MEMBER_CAP ? { moreMembers: true } : {}),
    roles: roles.slice(0, ROLE_CAP).map((role) => ({
      name: role.name,
      key: role.key,
      system: role.isSystem,
      description: safeTextOrNull(role.description || null),
      permissions: rolePermissions(role),
    })),
    ...(roles.length > ROLE_CAP ? { moreRoles: true } : {}),
  }
}

const teamAccess: AgentTool = {
  name: 'team-access',
  title: 'Team and roles',
  category: 'settings',
  description:
    'Who works in this business and what they may do: each member\'s name, status, roles and which channel accounts '
    + 'they may reach (all, or the named ones); every role with its permissions; and how many invitations are waiting. '
    + 'Names and roles only — no e-mail addresses. Read only: inviting people and changing roles or access are done '
    + 'by an owner in Nexus.',
  input: z.object({}),
  requires: [F.usersManage, F.rolesManage],
  riskTier: 'low',
  readOnly: true,
  async handler() {
    return { ok: true, data: profilesOn() ? await businessTeam() : await globalTeam() }
  },
}

export const PLATFORM_BUSINESS_TOOLS: AgentTool[] = [businessOverview, channelConnections, channelHealthTool, teamAccess]
