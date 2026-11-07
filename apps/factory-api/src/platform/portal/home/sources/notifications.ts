import { PARTNER_KINDS } from '@nexus/factory-domain/auth/partners/kinds'
import { counts } from '../../notifications/inbox'
import type { HomeSource } from './index'

/** B-W2b-167: the bell's unread notifications. */
export const NOTIFICATION_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'notifications',
  counts: [{ key: 'notifications.unread', area: 'home', kinds: PARTNER_KINDS, words: { it: 'Notifiche non lette', en: 'Unread notifications' } }],
  async read(_app, request, now) {
    const answer = await counts(request, now)
    return { 'notifications.unread': answer.complete ? answer.unread : null }
  },
})
