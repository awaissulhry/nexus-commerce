import type { QueueItem } from '../../queue/model'
import type { QueueSnapshot } from '../../queue/queue'
import type { TickState } from './view/TaskParts'

/**
 * Where an action saved in the tablet's queue stands, as a task screen shows it (design "two ticks"; B-W0-30): saved on
 * this tablet (one tick) while it waits, being sent while a send is in flight and the tablet is online, recorded by the
 * office (two ticks) once the server took it, or refused with its reason (Waiting to send has the fix). Pure.
 */
export interface QueuedView {
  readonly ticks: TickState
  readonly item: QueueItem | null
  /** The refusal's code and words, when refused. */
  readonly refusal: QueueItem['refusal']
}

export function queuedView(snapshot: Pick<QueueSnapshot, 'items' | 'online' | 'sending'>, clientEventId: string | null): QueuedView | null {
  if (!clientEventId) return null
  const item = snapshot.items.find((entry) => entry.clientEventId === clientEventId) ?? null
  if (!item) return null
  switch (item.state) {
    case 'recorded':
      return { ticks: 'recorded', item, refusal: null }
    case 'refused':
      return { ticks: 'refused', item, refusal: item.refusal }
    case 'discarded':
      return { ticks: 'refused', item, refusal: item.refusal }
    case 'waiting':
      return { ticks: snapshot.online && snapshot.sending ? 'sending' : 'saved', item, refusal: item.refusal }
  }
}
