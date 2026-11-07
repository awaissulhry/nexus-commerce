import { PARTNER_KINDS } from '@nexus/factory-domain/auth/partners/kinds'
import { myTasks } from '../../tasks/portal'
import type { HomeSource } from './index'

/** B-W2b-167: the one task list's counts (design portal.*.home "Waiting for you" / "To do"; the rail's badges read the list). */
export const TASK_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'tasks',
  counts: [
    { key: 'tasks.open', area: 'home', kinds: PARTNER_KINDS, words: { it: 'Ti aspettano', en: 'Waiting for you' } },
    { key: 'tasks.overdue', area: 'home', kinds: PARTNER_KINDS, words: { it: 'In ritardo', en: 'Overdue' } },
    { key: 'tasks.due_soon', area: 'home', kinds: PARTNER_KINDS, words: { it: 'In scadenza', en: 'Due soon' } },
  ],
  async read(_app, request, now) {
    const list = await myTasks(request, 'OPEN', now)
    return { 'tasks.open': list.counts.open, 'tasks.overdue': list.counts.overdue, 'tasks.due_soon': list.counts.dueSoon }
  },
})
