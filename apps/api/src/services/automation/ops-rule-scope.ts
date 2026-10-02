/**
 * MCP full control R18 — which domain an automation rule belongs to, for the routes that reach one domain only (the
 * replenishment rule routes in fulfillment.routes.ts). A rule of another domain is "not found" there.
 */
import prisma from '../../db.js'

export async function isDomainRule(id: string, domain: string): Promise<boolean> {
  return (await prisma.automationRule.findFirst({ where: { id, domain }, select: { id: true } })) != null
}
