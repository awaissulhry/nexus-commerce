import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { compareQuery, floorNewerSpecView, styleDriftView, styleVersionsView, versionsCompareView, workOrderSpecView } from '@nexus/factory-domain/product/versions/contracts'

/** Spec versions (B-W2b-220): the answers are factory-domain's product/versions/contracts; every cost is money.cost. */

const style = input({ styleId: id() })
const workOrder = input({ workOrderId: id() })

export const listVersionsContract = defineContract({ params: style, response: { 200: output({ versions: styleVersionsView }) } })
export const compareVersionsContract = defineContract({ params: style, querystring: compareQuery, response: { 200: output({ compare: versionsCompareView }) } })
export const styleDriftContract = defineContract({ params: style, response: { 200: output({ drift: styleDriftView }) } })
export const workOrderSpecContract = defineContract({ params: workOrder, response: { 200: output({ spec: workOrderSpecView }) } })
export const floorNewerSpecContract = defineContract({ params: workOrder, response: { 200: output({ spec: floorNewerSpecView }) } })
