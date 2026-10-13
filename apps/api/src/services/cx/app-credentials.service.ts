/**
 * Our own app's sign-in credentials at a channel (client id + client secret), set by an Owner in Settings
 * → Channels → Diagnostics → App secrets. Google only (2026-10-13): the other channels' app credentials
 * come from the environment or their own rotation.
 *
 * Write-only: the secret is sealed with `encryptCredentials` (KMS envelope) and never returned — the
 * answer says only whether one is set. The client id is not a secret (Google shows it on every consent
 * page), so it is returned for the Owner to check which app is set.
 *
 * Saving pins the app's redirect URI to Nexus's own callback (`/api/cx/callback/google`): the value the
 * Owner registers in Google Cloud, shown on the card, and what the callback-readiness alert checks.
 */
import { OWNER_ROLE_KEY } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { encryptCredentials } from '../../lib/crypto.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { getChannelApp, forgetChannelApp } from './apps.service.js'
import { appLabel } from './app-secret-expiry.js'
import { recordConnectionEvent, type Actor } from './events.service.js'
import { callbackUrlFor } from './oauth.service.js'
import { CHANNEL_TYPE_OF, type ChannelKey } from './catalog.js'

/** The channels whose app credentials an Owner sets in Nexus. */
export const APP_CREDENTIAL_CHANNELS: readonly ChannelKey[] = ['GOOGLE']

export class AppCredentialsError extends Error {
  constructor(readonly code: 'unsupported_channel' | 'invalid_client_id' | 'invalid_client_secret', message: string, readonly statusCode = 400) {
    super(message)
    this.name = 'AppCredentialsError'
  }
}

export interface AppCredentialsSetup {
  channelKey: string
  label: string
  environment: 'production'
  /** The exact address to register in the channel's console as the sign-in redirect; null when unknown. */
  redirectUri: string | null
  /** Why the redirect URI cannot be shown or used, in words; null when it is fine. */
  redirectUriProblem: string | null
  /** Not a secret. Null when no app is set. */
  clientId: string | null
  secretSet: boolean
  /** saved = set in Nexus; environment = from the server's environment variables; none = not set. */
  source: 'saved' | 'environment' | 'none'
  updatedAt: string | null
}

/** Google's web client ids end in `.apps.googleusercontent.com`. */
const GOOGLE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.apps\.googleusercontent\.com$/

function redirectOf(channelKey: ChannelKey): { redirectUri: string | null; redirectUriProblem: string | null } {
  const value = callbackUrlFor(channelKey)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { redirectUri: null, redirectUriProblem: 'This Nexus server does not know its public address (NEXUS_PUBLIC_API_URL is not set), so the sign-in return address cannot be shown yet.' }
  }
  if (url.protocol !== 'https:' || url.hash || url.username || url.password) {
    return { redirectUri: value, redirectUriProblem: 'The sign-in return address is not a plain public HTTPS address; Google refuses it. Fix NEXUS_PUBLIC_API_URL on the API service.' }
  }
  return { redirectUri: value, redirectUriProblem: null }
}

async function setupOf(channelKey: ChannelKey): Promise<AppCredentialsSetup> {
  const row = await prisma.channelApp.findUnique({
    where: { channelKey_environment: { channelKey, environment: 'production' } },
    select: { clientId: true, clientSecretEnc: true, updatedAt: true },
  })
  let clientId: string | null = row?.clientId?.trim() || null
  let secretSet = !!row?.clientSecretEnc
  let source: AppCredentialsSetup['source'] = row ? 'saved' : 'none'
  if (!row) {
    // No row yet: the environment seed (GOOGLE_OAUTH_CLIENT_ID / _SECRET), when the server has one.
    const fromEnv = await getChannelApp(channelKey, 'production').catch(() => null)
    if (fromEnv?.clientId) {
      clientId = fromEnv.clientId
      secretSet = !!fromEnv.clientSecret
      source = 'environment'
    }
  }
  return {
    channelKey,
    label: appLabel(channelKey),
    environment: 'production',
    ...redirectOf(channelKey),
    clientId,
    secretSet,
    source,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  }
}

/** Every channel whose app credentials are set here, with what is set (never the secret). */
export async function listAppCredentials(): Promise<AppCredentialsSetup[]> {
  return Promise.all(APP_CREDENTIAL_CHANNELS.map(setupOf))
}

/** Why a person who is an Owner here may still not change Google's app credentials (the route's 403 sentence). */
export const OWNER_OF_EVERY_GOOGLE_BUSINESS_SENTENCE =
  'Google\'s app credentials serve the Google sign-in of every business profile in Nexus, so only a person who is an Owner of '
  + 'every business profile with Google connected can change them. You are not an Owner of all of them.'

/** A read filter (never a write): a connection waiting for its person to sign in again still counts as connected. */
const WAITING_FOR_RECONNECT = ['needs_reauth']
const SWEEP_PAGE = 50

/**
 * Whether this person may change the app's credentials for every business they would affect: the refusal sentence, or
 * null when they may (the route has already checked they are an Owner of the business profile they work in).
 *
 * The app (`ChannelApp`) is global — ONE for every business — and a new client id or secret can break every business's
 * Google sign-in. Nexus has no owner above the businesses, so: an Owner of EVERY business profile that has a Google
 * connection that is live or waiting for a new sign-in (which signs in again through this app). Archived profiles call
 * nothing. With business profiles off there is one business, whose Owner the route has already checked.
 */
export async function appCredentialsRefusal(channelKey: string, userId: string): Promise<string | null> {
  const key = channelKey.trim().toUpperCase() as ChannelKey
  // Another channel is refused by setAppCredentials (400) before anything is written.
  if (!APP_CREDENTIAL_CHANNELS.includes(key)) return null
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return null
  const owned = new Set((await prisma.workspaceMembership.findMany({
    where: { userId, status: 'active', user: { status: 'active' }, roles: { some: { role: { key: OWNER_ROLE_KEY } } } },
    select: { workspaceId: true },
  })).map((membership) => membership.workspaceId))
  const channelType = CHANNEL_TYPE_OF[key]
  let after: string | undefined
  do {
    const rows = await prisma.workspace.findMany({
      where: { status: 'active' }, select: { id: true }, orderBy: { id: 'asc' }, take: SWEEP_PAGE, ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    })
    for (const { id } of rows) {
      if (owned.has(id)) continue
      // That business's own rows (its row-level security), read as the system: only whether it has a Google connection.
      const connected = await withWorkspace({ workspaceId: id, actorUserId: null, membershipId: null, roleKeys: [] }, () =>
        prisma.channelConnection.count({ where: { channelType, OR: [{ isActive: true }, { authStatus: { in: WAITING_FOR_RECONNECT } }] } }))
      if (connected > 0) return OWNER_OF_EVERY_GOOGLE_BUSINESS_SENTENCE
    }
    after = rows.length === SWEEP_PAGE ? rows[rows.length - 1].id : undefined
  } while (after)
  return null
}

/**
 * Save the app's client id + secret (production). The caller has checked the Owner role (`appCredentialsRefusal`). The secret is
 * sealed before it reaches the database and is never echoed; the ledger says who set it and whether the
 * client id changed.
 */
export async function setAppCredentials(input: { channelKey: string; clientId: unknown; clientSecret: unknown; actor: Actor }): Promise<AppCredentialsSetup> {
  const channelKey = input.channelKey.trim().toUpperCase() as ChannelKey
  if (!APP_CREDENTIAL_CHANNELS.includes(channelKey)) {
    throw new AppCredentialsError('unsupported_channel', 'App credentials can be set here for Google only. Other channels keep theirs in the server environment.')
  }
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : ''
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : ''
  if (!GOOGLE_CLIENT_ID.test(clientId)) {
    throw new AppCredentialsError('invalid_client_id', 'Paste the client ID of a Google "Web application" OAuth client. It ends in .apps.googleusercontent.com.')
  }
  if (!clientSecret || clientSecret.length > 512 || /\s/.test(clientSecret)) {
    throw new AppCredentialsError('invalid_client_secret', 'Paste the client secret of the same Google OAuth client, without spaces.')
  }
  const { redirectUri } = redirectOf(channelKey)
  const where = { channelKey_environment: { channelKey, environment: 'production' } }
  const previous = await prisma.channelApp.findUnique({ where, select: { clientId: true } })
  const { blob } = await encryptCredentials({ clientSecret })
  const data = { clientId, clientSecretEnc: blob, redirectUris: redirectUri ? [redirectUri] : [] }
  await prisma.channelApp.upsert({
    where,
    create: { channelKey, environment: 'production', ...data },
    update: data,
  })
  forgetChannelApp(channelKey, 'production')
  await recordConnectionEvent({
    channelKey,
    type: 'app_credentials_set',
    actor: input.actor,
    detail: { environment: 'production', clientIdChanged: previous?.clientId !== clientId, first: !previous, redirectUri },
  })
  return setupOf(channelKey)
}
