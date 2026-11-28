'use client'

import { useFloor } from '../../FloorApp'
import { FloorHome } from '../../home/Home'
import { BasketHome } from './BasketHome'

/**
 * owb-fl5 (lead settle 9) — what `/floor` shows: on a PHONE of a person who scans (production.scan), the basket home; everywhere else
 * today's tile home (a tablet keeps its screens and opens the basket home from its Baskets tile).
 */
export function FloorStart() {
  const { me } = useFloor()
  return me?.device.mode === 'PHONE' && me.permissions.includes('production.scan') ? <BasketHome /> : <FloorHome />
}
