'use client'

import { useFloor } from '../../../FloorApp'
import { modeOf } from '../../../model'
import { FloorMyWork } from '../MyWork'
import { FloorWarehouseInbox } from './Inbox'

/**
 * `/floor/mywork`'s screen (B-W2b-308): at the warehouse (a tablet with no station, `modeOf`) My work is the warehouse task inbox
 * (design floor.mywork "Variants: warehouse task inbox"), instead of the held empty state; at a station the station's queue.
 */
export function FloorMyWorkEntry() {
  const { me } = useFloor()
  if (me && modeOf(me.device.station, me.device.mode) === 'warehouse') return <FloorWarehouseInbox />
  return <FloorMyWork />
}
