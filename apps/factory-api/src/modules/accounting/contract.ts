import {
  cancelExportBody,
  createExportBody,
  exportAnswer,
  exportFileParams,
  exportParams,
  exportsAnswer,
  exportsQuery,
  intrastatAnswer,
  intrastatQuery,
  liftBody,
  lockAnswer,
  lockParams,
  lockBody,
  locksAnswer,
  locksQuery,
  lockView,
  periodAnswer,
  periodParams,
  periodQuery,
  periodsAnswer,
  periodsQuery,
} from '@nexus/factory-domain/accounting/contracts'
import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import { presignedView } from '../../platform/files/contract'

/** The route contracts of the accounting exports and the period locks: the shapes are factory-domain's accounting/contracts. */

export const listExportsContract = defineContract({ querystring: exportsQuery, response: { 200: exportsAnswer } })
export const getExportContract = defineContract({ params: exportParams, response: { 200: exportAnswer } })
export const createExportContract = defineContract({ body: createExportBody, response: { 201: exportAnswer } })
export const cancelExportContract = defineContract({ params: exportParams, body: cancelExportBody, response: { 200: exportAnswer } })
export const downloadExportFileContract = defineContract({ params: exportFileParams, response: { 200: output({ download: presignedView }) } })
export const periodsContract = defineContract({ querystring: periodsQuery, response: { 200: periodsAnswer } })
export const periodContract = defineContract({ params: periodParams, querystring: periodQuery, response: { 200: periodAnswer } })
export const intrastatContract = defineContract({ querystring: intrastatQuery, response: { 200: intrastatAnswer } })
export const listLocksContract = defineContract({ querystring: locksQuery, response: { 200: locksAnswer } })
export const lockContract = defineContract({ body: lockBody, response: { 200: lockAnswer, 201: lockAnswer } })
export const liftContract = defineContract({ params: lockParams, body: liftBody, response: { 200: output({ lock: lockView }) } })

