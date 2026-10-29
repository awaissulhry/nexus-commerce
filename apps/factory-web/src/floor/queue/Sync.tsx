'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { isFloorSyncKind } from '@nexus/factory-domain/floor-sync/kinds'
import { summaryOf } from '@nexus/factory-domain/floor-sync/rules'
import { useFloor } from '../FloorApp'
import { useFloorKeys } from '../keys'
import { numberKindsOf } from './actions'
import { isLow, minutesOff, remainingOf, storageWord, type QueueItem } from './model'
import type { QueueSnapshot } from './queue'
import { SyncView, type RefusedRowModel, type SyncAction, type SyncViewModel } from './view/SyncView'

/**
 * The live SCR-023 (`/floor/sync`): the queue of this tablet for the person signed in, read from the tablet (works
 * offline) and, with the network, the refused actions the server keeps for them (also ones this tablet lost). Send now;
 * a refused row opens as a step screen; Discard asks first and needs the network.
 */

const today = (instant: string, now: Date) => new Date(instant).toDateString() === now.toDateString()
const summaryOfItem = (item: QueueItem) => (isFloorSyncKind(item.kind) ? summaryOf(item.kind, item.payload) : {})

/** The view's model from the queue (exported for the tests). */
export function syncModel(snapshot: QueueSnapshot, input: { workerId: string | null; numberKinds: readonly SyncViewModel['numbers'][number]['kind'][]; now: Date; frame: SyncViewModel['frame']; ui: Pick<SyncViewModel, 'open' | 'confirm' | 'showRecorded'> }): SyncViewModel {
  const shareAll = snapshot.server?.subject === 'STATION'
  const mine = (item: QueueItem) => shareAll || (input.workerId !== null && item.workerId === input.workerId)
  const ordered = [...snapshot.items].sort((a, b) => a.seq - b.seq)
  const own = ordered.filter(mine)
  const local = new Set(snapshot.items.map((item) => item.refusal?.id).filter((id): id is string => Boolean(id)))
  const refused: RefusedRowModel[] = [
    ...own
      .filter((item) => item.state === 'refused' && item.refusal)
      .map((item) => ({ key: item.clientEventId, kind: item.kind, summary: summaryOfItem(item), at: item.occurredAt, code: item.refusal!.code, message: item.refusal!.message, fix: item.refusal!.fix, final: item.refusal!.final })),
    // Kept by the server, no longer on this tablet (a data loss): still the person's to clear.
    ...(snapshot.server?.refused ?? [])
      .filter((row) => !local.has(row.id))
      .map((row) => ({ key: `server:${row.id}`, kind: row.kind, summary: row.summary, at: row.deviceTime ?? row.serverTime, code: row.code, message: row.message, fix: row.fix, final: row.final })),
  ]
  const waitingItems = own.filter((item) => item.state === 'waiting')
  const others = ordered.filter((item) => !mine(item))
  return {
    frame: input.frame,
    online: snapshot.online,
    sending: snapshot.sending,
    lastSentAt: snapshot.lastSentAt,
    counts: {
      waiting: waitingItems.length,
      refused: refused.length,
      recordedToday: own.filter((item) => item.state === 'recorded' && item.recordedAt && today(item.recordedAt, input.now)).length,
      othersWaiting: others.filter((item) => item.state === 'waiting').length,
      othersRefused: others.filter((item) => item.state === 'refused').length + (snapshot.server?.othersRefused ?? 0),
    },
    clock: snapshot.clock?.off ? { minutes: minutesOff(snapshot.clock), ahead: snapshot.clock.skewSeconds < 0, flagged: snapshot.clock.flagged } : null,
    storage: snapshot.storage.durable ? storageWord(snapshot.storage) : 'mayClear',
    freeMb: snapshot.storage.freeMb,
    numbers: snapshot.numbers.scanTag ? input.numberKinds.map((kind) => ({ kind, left: remainingOf(snapshot.numbers, kind), low: isLow(snapshot.numbers, kind) })) : [],
    refused,
    waiting: waitingItems.map((item, index) => ({ key: item.clientEventId, kind: item.kind, summary: summaryOfItem(item), at: item.occurredAt, sending: snapshot.sending && index === 0, again: item.attempts > 0 })),
    recorded: own
      .filter((item) => item.state === 'recorded' && item.recordedAt && today(item.recordedAt, input.now))
      .reverse()
      .map((item) => ({ key: item.clientEventId, kind: item.kind, summary: summaryOfItem(item), at: item.occurredAt, recordedAt: item.recordedAt! })),
    showRecorded: input.ui.showRecorded,
    open: input.ui.open,
    confirm: input.ui.confirm,
    problem: snapshot.problem,
  }
}

export function FloorSync() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('sync.title', { showHome: true, queue: true })
  const [ui, setUi] = useState<Pick<SyncViewModel, 'open' | 'confirm' | 'showRecorded'>>({ open: null, confirm: false, showRecorded: false })
  const { queue, queueSnapshot, me } = store

  // The server's word on the person's refused actions, each time the screen opens with the network.
  useEffect(() => {
    if (queueSnapshot.online) void queue.refresh().catch(() => undefined)
  }, [queue, queueSnapshot.online])

  // Keys (design floor.sync): Enter = Send now (in a refused action: Discard, which asks first); Esc = Back (Home).
  useFloorKeys({
    enter: ui.open ? () => setUi((current) => ({ ...current, confirm: true })) : () => void queue.sync(),
    escape: ui.open ? () => setUi((current) => ({ ...current, open: null, confirm: false })) : () => router.push('/floor'),
  })

  if (!me) return null
  const model = syncModel(queueSnapshot, { workerId: me.worker.id, numberKinds: numberKindsOf(me.permissions), now: new Date(), frame, ui })

  const onAction = async (action: SyncAction) => {
    switch (action.type) {
      case 'send':
        return queue.sync()
      case 'open':
        return setUi((current) => ({ ...current, open: action.key, confirm: false }))
      case 'back':
        return setUi((current) => ({ ...current, open: null, confirm: false }))
      case 'discard':
        return setUi((current) => ({ ...current, confirm: true }))
      case 'cancel':
        return setUi((current) => ({ ...current, confirm: false }))
      case 'recorded':
        return setUi((current) => ({ ...current, showRecorded: action.show }))
      case 'confirm': {
        const key = ui.open
        if (!key) return
        try {
          if (key.startsWith('server:')) await queue.discardServer(key.slice('server:'.length))
          else await queue.discard(key)
          feedback('success')
          setUi((current) => ({ ...current, open: null, confirm: false }))
        } catch {
          feedback('error')
          setUi((current) => ({ ...current, confirm: false }))
        }
        return
      }
    }
  }

  return <SyncView model={model} onFrame={onFrame} onAction={(action) => void onAction(action)} />
}
