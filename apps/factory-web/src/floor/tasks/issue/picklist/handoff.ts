/**
 * A work order handed from My work at the warehouse to Pick & issue (B-W2b-310): "Open Pick & issue" on a PICK task (its source the
 * work order) opens the pick list by bin of that work order, not the list of work orders (B-W2b-308's gap 2). Memory only, for the
 * next screen to take once (another person never gets it: the screen takes it at once).
 */

let handed: string | null = null

export function handWorkOrderToPick(workOrderId: string): void {
  handed = workOrderId
}

export function takeHandedWorkOrder(): string | null {
  const workOrderId = handed
  handed = null
  return workOrderId
}
