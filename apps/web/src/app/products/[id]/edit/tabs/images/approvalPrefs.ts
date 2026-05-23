// PB.12 — Per-product "require approval before publishing" flag +
// pending approval queue, stored in localStorage. Browser-side
// self-gate, not a multi-user workflow.
//
// When the flag is ON, calls into handlePublish are deferred:
// instead of firing the channel publish endpoint, the target is
// pushed into pendingApprovals. The operator must explicitly click
// Approve in the ApprovalModal to fire the actual publish.
//
// PB.12b (queued) would add a server-side ImagePublishApproval
// model + multi-operator routing.

import type { PublishTarget } from './ImageActionBar'

const FLAG_PREFIX = 'nexus.images.approvalRequired'
const QUEUE_PREFIX = 'nexus.images.pendingApprovals'

export interface PendingApproval {
  id: string
  productId: string
  target: PublishTarget
  requestedAt: string
  /** Free-text note the requester left when creating the approval.
   *  Helpful for "why does this need to publish" context. */
  note: string
}

function flagKey(productId: string): string {
  return `${FLAG_PREFIX}.${productId}`
}

function queueKey(productId: string): string {
  return `${QUEUE_PREFIX}.${productId}`
}

export function isApprovalRequired(productId: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(flagKey(productId)) === '1'
  } catch {
    return false
  }
}

export function setApprovalRequired(productId: string, enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (enabled) {
      window.localStorage.setItem(flagKey(productId), '1')
    } else {
      window.localStorage.removeItem(flagKey(productId))
    }
  } catch {
    // ignore
  }
}

export function readPendingApprovals(productId: string): PendingApproval[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(queueKey(productId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as PendingApproval[]
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

function writePendingApprovals(productId: string, list: PendingApproval[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(queueKey(productId), JSON.stringify(list))
  } catch {
    // ignore
  }
}

export function pushPendingApproval(opts: {
  productId: string
  target: PublishTarget
  note?: string
}): PendingApproval {
  const list = readPendingApprovals(opts.productId)
  const entry: PendingApproval = {
    id: `pa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    productId: opts.productId,
    target: opts.target,
    requestedAt: new Date().toISOString(),
    note: opts.note ?? '',
  }
  list.push(entry)
  writePendingApprovals(opts.productId, list)
  return entry
}

export function removePendingApproval(productId: string, id: string): void {
  const list = readPendingApprovals(productId).filter((p) => p.id !== id)
  writePendingApprovals(productId, list)
}

export function clearPendingApprovals(productId: string): void {
  writePendingApprovals(productId, [])
}
