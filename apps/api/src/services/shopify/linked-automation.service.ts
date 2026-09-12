import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ShopifyLinkedAutomation } from '@nexus/shared/shopify-linked-products'
import { contentDestination, type ContentScope } from './content-workspace.service.js'
import { AUTOMATION_KEY, advanceLinkedSync, beginLinkedSync, getLinkedWorkspace, linkedState, linkedTransaction, previewLinkedWorkspace, writeLinkedState } from './linked-products.service.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

export async function configureLinkedAutomation(productId: string, scope: ContentScope, body: unknown) {
  const input = z.object({ mode: z.enum(['PAUSED', 'MONITOR', 'AUTOMATIC']), expectedRevision: z.string(), planRevision: z.string().optional() }).strict().parse(body)
  const destination = await contentDestination(productId, scope)
  if (input.mode === 'AUTOMATIC') {
    const { workspace, plan } = await previewLinkedWorkspace(productId, scope)
    if (workspace.revision !== input.expectedRevision || plan.revision !== input.planRevision) throw new WorkspaceScopeError('The rules or Shopify values changed. Review automation again.')
    if (plan.changes.some(c => c.nextValue === null)) throw new WorkspaceScopeError('Review and synchronize field removals manually before enabling automation.', 422)
    if (plan.nativeEdits?.length || plan.mediaEdits?.length || plan.sheetGalleries?.length) throw new WorkspaceScopeError('Review and synchronize saved cell and gallery changes manually before enabling automation.', 422)
    if (!workspace.draft.relationship && !workspace.draft.sharedFields?.length) throw new WorkspaceScopeError('Choose a family relationship or a shared-content rule first.', 422)
  }
  return linkedTransaction(async tx => {
    const current = await linkedState(tx, destination)
    if (current.revision !== input.expectedRevision) throw new WorkspaceScopeError('The saved rules changed. Reload before changing automation.')
    if (input.mode !== 'PAUSED' && (current.listing?.syncPaused || current.listing?.syncLocked)) throw new WorkspaceScopeError('Synchronization is paused or locked for this listing.', 422)
    if (input.mode !== 'PAUSED' && current.operation && current.operation.status !== 'VERIFIED' && current.operation.origin !== 'AUTOMATIC') throw new WorkspaceScopeError('Finish the reviewed synchronization before enabling automation.')
    const automation: ShopifyLinkedAutomation = { ...current.workspace.automation!, mode: input.mode, status: 'IDLE', message: input.mode === 'PAUSED'
      ? 'Automation paused. A request already sent to Shopify may still finish; further batches will wait.'
      : input.mode === 'MONITOR' ? 'Checks run every five minutes. Changes wait for your review.' : 'The reviewed family links and shared-content rules will be synchronized automatically.' }
    await writeLinkedState(tx, destination, current, { [AUTOMATION_KEY]: { ...automation, generation: randomUUID() } })
    return (await linkedState(tx, destination)).workspace
  })
}

/** Runs on the server even after the editor closes. Existing operation leases own all writes. */
export async function runLinkedAutomation(productId: string, scope: ContentScope) {
  const destination = await contentDestination(productId, scope)
  let current = await linkedTransaction(tx => linkedState(tx, destination))
  if (current.workspace.automation?.mode === 'PAUSED') return current.workspace
  const report = async (patch: Partial<ShopifyLinkedAutomation>) => linkedTransaction(async tx => {
    const saved = await linkedState(tx, destination)
    // Never re-enable a concurrent pause, or replace a newly edited draft's status.
    if (saved.workspace.automation?.mode === 'PAUSED' || saved.pa[AUTOMATION_KEY]?.generation !== current.pa[AUTOMATION_KEY]?.generation) return saved.workspace
    await writeLinkedState(tx, destination, saved, { [AUTOMATION_KEY]: { ...saved.workspace.automation, ...patch, lastCheckedAt: new Date().toISOString() } })
    return (await linkedState(tx, destination)).workspace
  })
  if (current.operation?.lease && current.operation.leaseUntil > Date.now()) return current.workspace
  try {
    if (current.listing?.syncPaused || current.listing?.syncLocked) throw new WorkspaceScopeError('The listing is paused or locked. Resume it before automation can continue.')
    if (current.operation && current.operation.status !== 'VERIFIED') {
      if (current.operation.origin !== 'AUTOMATIC') return report({ status: 'NEEDS_REVIEW', message: 'A manual synchronization is pending. Resume its saved progress first.' })
      if (current.workspace.automation?.mode !== 'AUTOMATIC') return report({ status: 'NEEDS_REVIEW', message: 'An automatic synchronization is incomplete. Review its progress before resuming automation.' })
    } else {
      const { workspace, plan } = await previewLinkedWorkspace(productId, scope)
      if (plan.nativeEdits?.length || plan.mediaEdits?.length || plan.sheetGalleries?.length) return report({ status: 'NEEDS_REVIEW', changes: plan.changes.length + (plan.nativeEdits?.length ?? 0) + (plan.mediaEdits?.length ?? 0) + (plan.sheetGalleries?.length ?? 0), message: 'Saved cell and gallery changes require manual review and synchronization.' })
      if (!plan.changes.length) return report({ status: 'VERIFIED', changes: 0, lastVerifiedAt: new Date().toISOString(), message: 'Family links and shared content match the saved rules.' })
      if (workspace.automation?.mode !== 'AUTOMATIC') return report({ status: 'NEEDS_REVIEW', changes: plan.changes.length, message: `${plan.changes.length} changes are ready for review.` })
      if (plan.changes.some(c => c.nextValue === null)) throw new WorkspaceScopeError('Automation does not remove field values. Review these changes manually.')
      await beginLinkedSync(productId, scope, { expectedRevision: workspace.revision, planRevision: plan.revision }, 'AUTOMATIC')
      current = await linkedTransaction(tx => linkedState(tx, destination))
    }
    // Bound each tick to one verified batch. Large families continue on the next tick.
    const result = await advanceLinkedSync(productId, scope, current.operation!.id, true)
    const finished = result.operation?.status === 'VERIFIED'
    return report({ status: finished ? 'VERIFIED' : 'CHECKING', changes: result.operation!.total - result.operation!.completed,
      ...(finished ? { lastVerifiedAt: new Date().toISOString() } : {}), message: finished ? 'Automatic synchronization verified in Shopify.' : `${result.operation!.completed} of ${result.operation!.total} changes verified. The next check continues automatically.` })
  } catch (error) {
    await report({ status: error instanceof WorkspaceScopeError ? 'NEEDS_REVIEW' : 'ERROR', message: error instanceof Error ? error.message : 'The check failed. Saved progress is preserved.' })
    return getLinkedWorkspace(productId, scope)
  }
}
