import type { WorkOrder } from '../../../_shared/api'
import type { OrderFilesGroup, WorkOrderOrderFiles } from './api'
import type { OrderFilesModel } from './model'

/**
 * B-TH-265 (design only, made-up data): the work order's order files as the production lane's route answers them — the order's
 * confirmation, a line's artwork, a quote line's artwork the line was made from, a made-to-measure worksheet; and the cases where some
 * of it is left out (counted, never named), where the order's thread may not be read, and none at all.
 */

const at = (day: number, time = '09:12') => `2026-10-${String(day).padStart(2, '0')}T${time}:00.000Z`

export function orderGroup(workOrder: WorkOrder, over: Partial<OrderFilesGroup> = {}): OrderFilesGroup {
  const order = workOrder.orders[0]!
  return {
    order: { id: order.id, number: order.number, customerRef: order.customerRef, status: order.status, orderDate: '2026-10-02', companyId: workOrder.companyId },
    thread: { recordType: 'SalesOrder', recordId: order.id, threadId: 'thread-demo-0042' },
    files: [
      { id: 'file-demo-1', from: 'ORDER', line: null, name: `Conferma ordine ${order.number}.pdf`, contentType: 'application/pdf', kind: 'DOCUMENT', category: 'ORDER_CONFIRMATION', sizeBytes: 182_400, versionNo: 2, at: at(3), bodyData: false },
      { id: 'file-demo-2', from: 'LINE', line: { id: 'line-demo-1', seq: 1 }, name: 'Ricamo petto logo.png', contentType: 'image/png', kind: 'IMAGE', category: 'ARTWORK', sizeBytes: 54_100, versionNo: 1, at: at(4, '11:40'), bodyData: false },
      { id: 'file-demo-3', from: 'QUOTE_LINE', line: { id: 'line-demo-2', seq: 2 }, name: 'Grafica schiena v3.pdf', contentType: 'application/pdf', kind: 'DOCUMENT', category: 'ARTWORK', sizeBytes: 1_204_000, versionNo: 3, at: at(1, '15:05'), bodyData: false },
    ],
    worksheets: [{ documentId: 'sheet-demo-1', profileId: 'profile-demo-1', line: { id: 'line-demo-3', seq: 3 }, version: 2, number: 'MTM-DEMO-0007', language: 'it', createdAt: at(5, '10:00') }],
    measurementsLeftOut: 0,
    filesLeftOut: 0,
    ...over,
  }
}

export function orderFilesOf(workOrder: WorkOrder, groups: readonly OrderFilesGroup[] = [orderGroup(workOrder)], ordersLeftOut = 0): WorkOrderOrderFiles {
  return { workOrder: { id: workOrder.id, number: workOrder.number }, groups: [...groups], ordersLeftOut }
}

export const filesReady = (read: WorkOrderOrderFiles, over: Partial<OrderFilesModel> = {}): OrderFilesModel => ({ files: { state: 'ready', read }, open: false, opening: null, problem: null, ...over })

/** Some left out: a file of a company the reader does not read, a measurement sheet without the measurements right, another order. */
export const leftOut = (workOrder: WorkOrder): WorkOrderOrderFiles => orderFilesOf(workOrder, [orderGroup(workOrder, { worksheets: [], filesLeftOut: 2, measurementsLeftOut: 1 })], 1)

// ---- F-PR-25: one customer's two orders on one work order (made-up): the window has two groups (their PO first), the band's
// "Order thread" is a menu; the second order's measurement sheet is locked for this reader (counted, never dropped).
export function twoOrdersOf(workOrder: WorkOrder): WorkOrder {
  const first = workOrder.orders[0]!
  return { ...workOrder, orders: [first, { ...first, id: 'order-demo-0050', number: 'SO-DEMO-0050', customerRef: 'PO-ESEMPIO-9' }] }
}

export function twoGroupsOf(workOrder: WorkOrder): WorkOrderOrderFiles {
  const second = workOrder.orders[1]!
  return orderFilesOf(workOrder, [
    orderGroup(workOrder),
    {
      order: { id: second.id, number: second.number, customerRef: second.customerRef, status: second.status, orderDate: '2026-10-09', companyId: workOrder.companyId },
      thread: { recordType: 'SalesOrder', recordId: second.id, threadId: null },
      files: [{ id: 'file-demo-9', from: 'ORDER', line: null, name: `Conferma ordine ${second.number}.pdf`, contentType: 'application/pdf', kind: 'DOCUMENT', category: 'ORDER_CONFIRMATION', sizeBytes: 96_200, versionNo: 1, at: at(10), bodyData: false }],
      worksheets: [],
      measurementsLeftOut: 1,
      filesLeftOut: 0,
    },
  ])
}
// ---- end F-PR-25
