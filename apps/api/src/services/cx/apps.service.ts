/**
 * CX.1 — OUR credentials per channel × environment (`ChannelApp`).
 *
 * Client id/secret, redirect URIs, the eBay RuName, the eBay signing key — the
 * things that identify Nexus to a channel, as opposed to the operator's grant.
 * Kept out of connection rows on purpose (the Ads client secret had been copied
 * into nine `AmazonAdsConnection` rows; audit §1.3).
 *
 * Source of truth: the `ChannelApp` row. `seedChannelApps()` creates a row from
 * the existing env vars exactly once per channel; from then on the row wins, so
 * a secret rotated in the UI (later phase) does not fight the env.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { encryptCredentials, decryptCredentials, isCredentialsBlob } from '../../lib/crypto.js'
import type { ChannelKey } from './catalog.js'

export type Environment = 'production' | 'sandbox'

export interface ChannelAppCreds {
  channelKey: ChannelKey
  environment: Environment
  clientId: string
  clientSecret: string
  redirectUris: string[]
  extra: Record<string, unknown>
  signingKey: { signingKeyId: string; jwe: string; privateKey: string; cipher: string } | null
}

const cache = new Map<string, { at: number; value: ChannelAppCreds }>()
const CACHE_MS = 60_000

function envSeed(key: ChannelKey): { clientId: string; clientSecret: string; redirectUris: string[]; extra: Record<string, unknown> } | null {
  const e = process.env
  switch (key) {
    case 'EBAY':
      if (!e.EBAY_CLIENT_ID || !e.EBAY_CLIENT_SECRET) return null
      return {
        clientId: e.EBAY_CLIENT_ID,
        clientSecret: e.EBAY_CLIENT_SECRET,
        // eBay's redirect_uri is the RuName, not a URL — the URL lives at eBay.
        redirectUris: e.EBAY_RUNAME ? [e.EBAY_RUNAME] : [],
        extra: { ruName: e.EBAY_RUNAME ?? null, environment: e.EBAY_ENVIRONMENT ?? 'PRODUCTION' },
      }
    case 'AMAZON_SP': {
      const id = e.AMAZON_LWA_CLIENT_ID ?? e.AMAZON_CLIENT_ID
      const secret = e.AMAZON_LWA_CLIENT_SECRET ?? e.AMAZON_CLIENT_SECRET
      if (!id || !secret) return null
      return { clientId: id, clientSecret: secret, redirectUris: [], extra: { applicationId: e.AMAZON_SP_APPLICATION_ID ?? null } }
    }
    case 'AMAZON_ADS':
      if (!e.AMAZON_ADS_CLIENT_ID || !e.AMAZON_ADS_CLIENT_SECRET) return null
      return {
        clientId: e.AMAZON_ADS_CLIENT_ID,
        clientSecret: e.AMAZON_ADS_CLIENT_SECRET,
        redirectUris: e.AMAZON_ADS_REDIRECT_URI ? [e.AMAZON_ADS_REDIRECT_URI] : [],
        extra: {},
      }
    case 'SHOPIFY':
      if (!e.SHOPIFY_APP_CLIENT_ID || !e.SHOPIFY_APP_CLIENT_SECRET) return null
      return { clientId: e.SHOPIFY_APP_CLIENT_ID, clientSecret: e.SHOPIFY_APP_CLIENT_SECRET, redirectUris: [], extra: {} }
    case 'ETSY':
      if (!e.ETSY_API_KEY) return null
      return { clientId: e.ETSY_API_KEY, clientSecret: e.ETSY_SHARED_SECRET ?? '', redirectUris: [], extra: {} }
  }
}

/** Create a ChannelApp row from env for every channel that has env credentials and no row yet. */
export async function seedChannelApps(): Promise<void> {
  const keys: ChannelKey[] = ['EBAY', 'AMAZON_SP', 'AMAZON_ADS', 'SHOPIFY', 'ETSY']
  for (const key of keys) {
    const seed = envSeed(key)
    if (!seed) continue
    const environment: Environment = key === 'EBAY' && (process.env.EBAY_ENVIRONMENT ?? '').toUpperCase() === 'SANDBOX' ? 'sandbox' : 'production'
    const existing = await prisma.channelApp.findUnique({ where: { channelKey_environment: { channelKey: key, environment } } })
    if (existing) continue
    const { blob } = await encryptCredentials({ clientSecret: seed.clientSecret })
    await prisma.channelApp.create({
      data: {
        channelKey: key,
        environment,
        clientId: seed.clientId,
        clientSecretEnc: blob,
        redirectUris: seed.redirectUris,
        extra: seed.extra as Prisma.InputJsonValue | undefined,
      },
    })
    logger.info('[cx-apps] ChannelApp seeded from env', { channelKey: key, environment })
  }
}

export async function getChannelApp(key: ChannelKey, environment: Environment = 'production'): Promise<ChannelAppCreds> {
  const cacheKey = `${key}:${environment}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const row = await prisma.channelApp.findUnique({ where: { channelKey_environment: { channelKey: key, environment } } })
  let value: ChannelAppCreds
  if (row) {
    const secret = row.clientSecretEnc && isCredentialsBlob(row.clientSecretEnc)
      ? String((await decryptCredentials(row.clientSecretEnc)).clientSecret ?? '')
      : ''
    let signingKey: ChannelAppCreds['signingKey'] = null
    if (row.signingKeyEnc && isCredentialsBlob(row.signingKeyEnc)) {
      const sk = await decryptCredentials(row.signingKeyEnc)
      signingKey = {
        signingKeyId: String(sk.signingKeyId ?? row.signingKeyId ?? ''),
        jwe: String(sk.jwe ?? ''),
        privateKey: String(sk.privateKey ?? ''),
        cipher: String(sk.cipher ?? 'ED25519'),
      }
    }
    value = {
      channelKey: key,
      environment,
      clientId: row.clientId,
      clientSecret: secret,
      redirectUris: row.redirectUris,
      extra: (row.extra as Record<string, unknown>) ?? {},
      signingKey,
    }
  } else {
    const seed = envSeed(key)
    if (!seed) throw new Error(`No ChannelApp row and no env credentials for ${key} (${environment})`)
    value = { channelKey: key, environment, ...seed, signingKey: null }
  }
  cache.set(cacheKey, { at: Date.now(), value })
  return value
}

export async function storeSigningKey(
  key: ChannelKey,
  environment: Environment,
  signingKey: { signingKeyId: string; jwe: string; privateKey: string; cipher: string },
): Promise<void> {
  const { blob } = await encryptCredentials(signingKey)
  await prisma.channelApp.update({
    where: { channelKey_environment: { channelKey: key, environment } },
    data: { signingKeyEnc: blob, signingKeyId: signingKey.signingKeyId },
  })
  cache.delete(`${key}:${environment}`)
}

export function __appsTest() {
  cache.clear()
}
