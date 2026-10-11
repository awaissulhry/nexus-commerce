/**
 * The check the brain's decide route uses (row 25, POST …/brain/requests/:approvalId/decide — the Bid page's Waiting tab):
 * it decides only a request that waits on the brain. Built for the Ads brain page (A5); the page's list of these requests
 * went with the shelved page (2026-10-11), the check stayed.
 *
 *   brain asked    what a product's brain asked a person for, read from each lever's own log (control.ts
 *                  brainRequestsWaiting: money, state, negatives, harvest, hours, bidding strategy), and its structure
 *                  builds, go-lives and moves (AdsBrainStructure) and its retirements (AdsBrainRetirement)
 *   asked of it    a brain tool a person asked for on the page, or Claude (BRAIN_WRITE_TOOLS)
 *
 * Each waits for a person (pending, not expired) or sits in its 20-second undo window (scheduled). Read only.
 */
import prisma from '../../../db.js'
import { brainRequestsWaiting } from './control.js'

/** The brain's own write tools: Claude asks for each; the page's routes for set-ads-brain, set-brain-kill-switch and set-bid-brain-enrollment. */
const BRAIN_WRITE_TOOLS = ['set-ads-brain', 'set-brain-kill-switch', 'set-bid-brain-enrollment', 'apply-brain-hourly-plan', 'apply-brain-harvest', 'retire-ads-writers'] as const

const OPEN = ['pending', 'scheduled']

/** Every request the brain itself asked for: its levers' logs (the enrolled products, at most 200), structures and retirements. */
async function brainAskedIds(): Promise<Set<string>> {
  const products = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true }, take: 200 })
  const roots = [...new Set(products.map((p) => p.productId))]
  const [waiting, structures, retirements] = await Promise.all([
    Promise.all(products.map((p) => brainRequestsWaiting(p.productId, p.marketplace))).then((x) => x.flat()),
    roots.length ? prisma.adsBrainStructure.findMany({ where: { productId: { in: roots } }, select: { approvalId: true, liveApprovalId: true, retireApprovalId: true } }) : Promise.resolve([]),
    roots.length ? prisma.adsBrainRetirement.findMany({ where: { productId: { in: roots }, approvalId: { not: null } }, select: { approvalId: true } }) : Promise.resolve([]),
  ])
  const ids = new Set(waiting.map((w) => w.approvalId))
  for (const s of structures) for (const id of [s.approvalId, s.liveApprovalId, s.retireApprovalId]) if (id) ids.add(id)
  for (const r of retirements) if (r.approvalId) ids.add(r.approvalId)
  return ids
}

/** Does this request wait on the brain now: open, not expired, and asked by the brain or of it (the decide route decides only those)? */
export async function isBrainRequest(approvalId: string, now: Date = new Date()): Promise<boolean> {
  const approval = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { toolName: true, status: true, expiresAt: true } })
  if (!approval || !OPEN.includes(approval.status)) return false
  if (approval.status === 'pending' && approval.expiresAt && approval.expiresAt <= now) return false
  return (BRAIN_WRITE_TOOLS as readonly string[]).includes(approval.toolName) || (await brainAskedIds()).has(approvalId)
}
