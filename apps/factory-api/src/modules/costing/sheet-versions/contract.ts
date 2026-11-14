import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  compareQuery,
  compareView,
  createVersionBody,
  removeVersionQuery,
  saveWhatIfBody,
  submitVersionBody,
  takeBackBody,
  updateVersionBody,
  versionAnswer,
  versionRecordView,
  versionsQuery,
  versionsView,
  whatIfBody,
  whatIfView,
} from '@nexus/factory-domain/costing/sheet-versions/contracts'
import { z } from 'zod'

/** The route contracts of cost sheet versions: the shapes are factory-domain's costing/sheet-versions/contracts (costs money.cost, the target price money.price, margins money.margin). */

const sheet = input({ sheetId: id() })

export const listVersionsContract = defineContract({ querystring: versionsQuery, response: { 200: versionsView } })
export const versionRecordContract = defineContract({ params: sheet, response: { 200: versionRecordView } })
export const createVersionContract = defineContract({ body: createVersionBody, response: { 201: versionAnswer } })
export const updateVersionContract = defineContract({ params: sheet, body: updateVersionBody, response: { 200: versionAnswer } })
export const removeVersionContract = defineContract({ params: sheet, querystring: removeVersionQuery, response: { 200: output({ id: id(), removed: z.literal(true) }) } })
export const submitVersionContract = defineContract({ params: sheet, body: submitVersionBody, response: { 200: versionAnswer } })
export const takeBackContract = defineContract({ params: sheet, body: takeBackBody, response: { 200: versionAnswer } })
export const compareContract = defineContract({ querystring: compareQuery, response: { 200: compareView } })
export const whatIfContract = defineContract({ params: sheet, body: whatIfBody, response: { 200: whatIfView } })
export const saveWhatIfContract = defineContract({ params: sheet, body: saveWhatIfBody, response: { 201: versionAnswer } })
