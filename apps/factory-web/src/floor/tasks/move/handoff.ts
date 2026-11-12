import type { WarehouseTask } from '../mywork/warehouse/model'

/**
 * A task handed from My work at the warehouse to Move & put away (B-W2b-308): "Move it" on a put-away, a move or a quarantine
 * move opens Move & put away on that task's card. Memory only, for the next screen to take once (another person never gets it:
 * the screen takes it at once).
 */

let handed: WarehouseTask | null = null

export function handTaskToMove(task: WarehouseTask): void {
  handed = task
}

export function takeHandedTask(): WarehouseTask | null {
  const task = handed
  handed = null
  return task
}
