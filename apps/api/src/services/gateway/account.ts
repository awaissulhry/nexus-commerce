/**
 * P1.1 step 2 — the account's state, read fresh for every call. Its own module so a unit test of a
 * channel client can stand it in with one line (test-support/gateway-stubs.ts).
 */
import prisma from '../../db.js'

export interface GatewayAccountState { authStatus: string; isActive: boolean; displayName: string | null }

export async function accountStatusOf(connectionId: string): Promise<GatewayAccountState | null> {
  return prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { authStatus: true, isActive: true, displayName: true } })
}
