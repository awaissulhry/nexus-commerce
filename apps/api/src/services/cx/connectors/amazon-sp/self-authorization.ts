/**
 * Private SP-API applications are self-authorized in Amazon's Solution Provider
 * Portal; Amazon does not give them a website Login URI / Redirect URI flow.
 * This importer verifies the existing migration token before moving it into the
 * encrypted ChannelConnection credential store. No token is returned or logged.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../../../db.js'
import { getChannelApp } from '../../apps.service.js'
import { recordConnectionEvent, type Actor } from '../../events.service.js'
import { getAccessToken, storeGrant } from '../../token.service.js'
import { amazonParticipations } from './spec.js'

export class AmazonSelfAuthorizationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'AmazonSelfAuthorizationError'
  }
}

export async function importAmazonEnvironmentAuthorization(input: {
  connectionId: string
  region?: string | null
  actor: Actor
}): Promise<{ connectionId: string; sellerId: string; placement: 'adopt' | 'verified' }> {
  const row = await prisma.channelConnection.findUnique({ where: { id: input.connectionId } })
  if (!row || row.channelType !== 'AMAZON') {
    throw new AmazonSelfAuthorizationError('The account to reconnect is not an Amazon Seller connection.', 404)
  }

  const managed = row.managedBy === 'oauth'
  const refreshToken = managed ? undefined : process.env.AMAZON_REFRESH_TOKEN
  const sellerId = managed ? row.externalAccountId : process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID
  if ((!managed && !refreshToken) || !sellerId) {
    throw new AmazonSelfAuthorizationError(
      'The private Seller Central authorization is not available for secure import.',
      503,
    )
  }
  if (row.externalAccountId && row.externalAccountId !== sellerId) {
    throw new AmazonSelfAuthorizationError(
      'The private Seller Central authorization belongs to a different seller account.',
      409,
    )
  }
  if (row.managedBy !== 'env' && row.managedBy !== 'oauth') {
    throw new AmazonSelfAuthorizationError(
      'This Amazon connection is not eligible for private authorization import.',
      409,
    )
  }

  const region = input.region ?? row.region ?? 'EU'
  if (!['EU', 'NA', 'FE'].includes(region)) {
    throw new AmazonSelfAuthorizationError('Choose a supported Amazon region.')
  }
  if (row.region && row.region !== region) {
    throw new AmazonSelfAuthorizationError('Reconnect Amazon in the existing account region.', 409)
  }
  if (managed && (!row.isActive || ['disconnected', 'revoked'].includes(row.authStatus))) {
    throw new AmazonSelfAuthorizationError('This account needs a new private authorization from the Solution Provider Portal.', 409)
  }
  let token: { access_token: string; expires_in: number }
  if (managed) {
    token = { access_token: await getAccessToken(row.id, { forceRefresh: true }), expires_in: 0 }
  } else {
    const app = await getChannelApp('AMAZON_SP')
    let tokenResponse: Response
    try {
      tokenResponse = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        signal: AbortSignal.timeout(25_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: app.clientId,
          client_secret: app.clientSecret,
        }),
      })
    } catch {
      throw new AmazonSelfAuthorizationError('Amazon could not be reached to verify the private authorization.', 502)
    }
    if (!tokenResponse.ok) {
      throw new AmazonSelfAuthorizationError(
        `Amazon rejected the private Seller Central authorization (${tokenResponse.status}).`,
        502,
      )
    }
    const responseToken = await tokenResponse.json().catch(() => null) as {
      access_token?: string
      expires_in?: number
    } | null
    if (!responseToken?.access_token || !Number.isFinite(responseToken.expires_in) || responseToken.expires_in! <= 0) {
      throw new AmazonSelfAuthorizationError('Amazon returned an invalid access token.', 502)
    }
    token = { access_token: responseToken.access_token, expires_in: responseToken.expires_in! }
  }

  const handle = {
    id: row.id,
    channelKey: 'AMAZON_SP' as const,
    channelType: 'AMAZON',
    environment: 'production' as const,
    region,
    grantedScopes: [],
    identity: { userId: sellerId },
    token: async () => token.access_token!,
  }
  let marketplaces: Awaited<ReturnType<typeof amazonParticipations>>
  try {
    marketplaces = await amazonParticipations(handle)
  } catch {
    throw new AmazonSelfAuthorizationError(
      'Amazon could not verify marketplace access for this private authorization.',
      502,
    )
  }
  if (!marketplaces.some((entry) => entry.participation?.isParticipating && entry.marketplace?.id)) {
    throw new AmazonSelfAuthorizationError(
      'This Amazon authorization has no participating marketplaces in the selected region.',
      409,
    )
  }

  const verifiedMarketplaces = marketplaces.filter((entry) => entry.marketplace?.id)
  const marketplaceIds = verifiedMarketplaces.map((entry) => entry.marketplace.id as string)
  const persistScopes = async (tx: Prisma.TransactionClient) => {
    // Retire missing scopes in this region without erasing history or local
    // metadata. Country-code migration rows become inactive; discovery uses
    // Amazon's canonical marketplace IDs.
    const existing = await tx.connectionScope.findMany({ where: { connectionId: row.id, kind: 'marketplace' } })
    const existingById = new Map(existing.map((scope) => [scope.externalId, scope]))
    await tx.connectionScope.updateMany({
      where: {
        connectionId: row.id,
        kind: 'marketplace',
        externalId: { notIn: marketplaceIds },
        OR: [{ region }, { region: null }],
      },
      data: { isActive: false },
    })
    for (const entry of verifiedMarketplaces) {
      const externalId = entry.marketplace.id as string
      await tx.connectionScope.upsert({
        where: {
          connectionId_kind_externalId: {
            connectionId: row.id,
            kind: 'marketplace',
            externalId,
          },
        },
        create: {
          connectionId: row.id,
          kind: 'marketplace',
          externalId,
          label: entry.marketplace?.name ?? null,
          region,
          isActive: !!entry.participation?.isParticipating,
          metadata: {
            ...((existingById.get(externalId)?.metadata ?? {}) as Record<string, unknown>),
            countryCode: entry.marketplace?.countryCode ?? null,
            currency: entry.marketplace?.defaultCurrencyCode ?? null,
          } as Prisma.InputJsonValue,
        },
        update: {
          label: entry.marketplace?.name ?? null,
          region,
          isActive: !!entry.participation?.isParticipating,
          metadata: {
            ...((existingById.get(externalId)?.metadata ?? {}) as Record<string, unknown>),
            countryCode: entry.marketplace?.countryCode ?? null,
            currency: entry.marketplace?.defaultCurrencyCode ?? null,
          } as Prisma.InputJsonValue,
        },
      })
    }
  }

  if (managed) {
    await prisma.$transaction(persistScopes)
    await recordConnectionEvent({ connectionId: row.id, channelKey: 'AMAZON_SP', type: 'heartbeat_ok', actor: input.actor, detail: { authorizationMode: 'self', verified: true } })
    return { connectionId: row.id, sellerId, placement: 'verified' }
  }
  const placement = 'adopt'
  await storeGrant(
    row.id,
    {
      accessToken: token.access_token,
      refreshToken,
      expiresInSec: token.expires_in!,
      grantedScopes: [],
      identity: { userId: sellerId },
      region,
      tokenResponseMetadata: { authorizationMode: 'self' },
    },
    input.actor,
    placement,
    persistScopes,
  )
  return { connectionId: row.id, sellerId, placement }
}
