import { portalJobCounts } from '../../../../modules/purchasing/portal-jobs/portal'
import type { HomeSource } from './index'

/**
 * B-W2b-176 (design portal.supplier.jobs "Accept new jobs (primary when any wait)", the chips): the workshop's jobs waiting for
 * its answer, its kits to confirm, the finished pieces ready to send back, and the jobs late. Null when the person does not see
 * our jobs (their role) or they cannot be counted.
 */
export const SUBCONTRACT_JOB_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'subcontract-jobs',
  counts: [
    { key: 'jobs.to_accept', area: 'orders', kinds: ['SUBCONTRACTOR'], words: { it: 'Lavorazioni da accettare', en: 'Jobs to accept' } },
    { key: 'jobs.kit_to_confirm', area: 'orders', kinds: ['SUBCONTRACTOR'], words: { it: 'Kit da confermare', en: 'Kits to confirm' } },
    { key: 'jobs.ready_to_send_back', area: 'orders', kinds: ['SUBCONTRACTOR'], words: { it: 'Pronti da rendere', en: 'Ready to send back' } },
    { key: 'jobs.late', area: 'orders', kinds: ['SUBCONTRACTOR'], words: { it: 'Lavorazioni in ritardo', en: 'Late jobs' } },
  ],
  async read(_app, request, now) {
    const counts = await portalJobCounts(request, now)
    return {
      'jobs.to_accept': counts?.toAccept ?? null,
      'jobs.kit_to_confirm': counts?.kitToConfirm ?? null,
      'jobs.ready_to_send_back': counts?.readyToSendBack ?? null,
      'jobs.late': counts?.late ?? null,
    }
  },
})
