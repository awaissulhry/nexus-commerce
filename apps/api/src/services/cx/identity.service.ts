/**
 * CX.1 — which connection row a fresh grant belongs to (the MAP.4 rules, moved
 * verbatim from routes/ebay-auth.ts:266-377 and made channel-agnostic).
 *
 *   • Re-consent for an account we already hold → fold into that row.
 *   • Adopt intent → the operator named the row that owns the data; the grant
 *     goes onto it (moving the identity to the data is zero movement).
 *   • Identity returned but an unidentified active account exists and no adopt
 *     intent → refuse (IDENTITY_UNMATCHED): connecting would mint a duplicate
 *     of the same seller — measured on prod 2026-08-19, every job then ran twice.
 *   • No identity at all while an unidentified active account exists → refuse
 *     (IDENTITY_UNAVAILABLE): two accounts nobody can tell apart.
 *   • Otherwise → a NEW row.
 */

import prisma from '../../db.js'
import { countUnidentifiedAccounts, findAccountByExternalId } from '../connection-resolver.service.js'
import type { ConnectionIdentity } from './catalog.js'

export class IdentityRefusal extends Error {
  constructor(
    readonly code: 'IDENTITY_UNMATCHED' | 'IDENTITY_UNAVAILABLE' | 'ADOPT_TARGET_INVALID',
    message: string,
    readonly identityUsername?: string,
  ) {
    super(message)
    this.name = 'IdentityRefusal'
  }
}

export type GrantPlacement =
  | { kind: 'reconsent'; connectionId: string }
  | { kind: 'adopt'; connectionId: string }
  | { kind: 'new' }

export async function placeGrant(input: {
  channelType: string
  channelLabel: string
  identity: ConnectionIdentity | null
  targetConnectionId?: string | null
}): Promise<GrantPlacement> {
  const { channelType, channelLabel, identity, targetConnectionId } = input

  if (identity?.userId) {
    const already = await findAccountByExternalId(channelType, identity.userId)
    if (already) return { kind: 'reconsent', connectionId: already.id }

    if (targetConnectionId) {
      const target = await prisma.channelConnection.findUnique({ where: { id: targetConnectionId } })
      if (!target || target.channelType !== channelType) {
        throw new IdentityRefusal('ADOPT_TARGET_INVALID', `The account to reconnect is not a ${channelLabel} connection.`)
      }
      return { kind: 'adopt', connectionId: target.id }
    }

    const unidentified = await countUnidentifiedAccounts(channelType)
    if (unidentified > 0) {
      const who = identity.username ?? identity.userId
      throw new IdentityRefusal(
        'IDENTITY_UNMATCHED',
        `This grant is for "${who}", and no connected account carries that identity yet. ` +
          `An existing ${channelLabel} connection predates the identity permission, so the two cannot be told apart — ` +
          `connecting now would create a duplicate of the same account. ` +
          `If this IS that account, use Reconnect on it in Settings → Channels. ` +
          `If it is a genuinely different account, reconnect the existing one first so it records its identity.`,
        who,
      )
    }
    return { kind: 'new' }
  }

  // No identity from the channel.
  if (targetConnectionId) {
    const target = await prisma.channelConnection.findUnique({ where: { id: targetConnectionId } })
    if (!target || target.channelType !== channelType) {
      throw new IdentityRefusal('ADOPT_TARGET_INVALID', `The account to reconnect is not a ${channelLabel} connection.`)
    }
    return { kind: 'adopt', connectionId: target.id }
  }
  const anyUnidentified = await countUnidentifiedAccounts(channelType)
  if (anyUnidentified > 0) {
    throw new IdentityRefusal(
      'IDENTITY_UNAVAILABLE',
      `${channelLabel} did not return this account's identity, and an existing ${channelLabel} account also has none — ` +
        `the two cannot be told apart. Reconnect the existing account first so it picks up the identity permission, then add this one.`,
    )
  }
  return { kind: 'new' }
}
