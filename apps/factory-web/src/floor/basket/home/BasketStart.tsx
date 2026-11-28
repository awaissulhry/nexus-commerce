'use client'

import { useFloor } from '../../FloorApp'
import { LeaderHome } from '../../leader/LeaderHome'
import { BasketHome } from './BasketHome'

/**
 * owb-fl6 (design § 5zg C; P/floor.js floorHome: "A team leader: leaderHome()") — the basket home of the person: a team leader
 * (floor.lead) gets the leader's home (Baskets · Team); a worker the basket home (For you, Scan, the baskets here, Coming next).
 */
export function BasketStart() {
  const { me } = useFloor()
  return me?.permissions.includes('floor.lead') ? <LeaderHome /> : <BasketHome />
}
