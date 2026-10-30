import { defineContract } from '@nexus/factory-domain/core/contracts'
import {
  ageingAnswer,
  ageingQuery,
  approveBody,
  bulkApproveAnswer,
  bulkApproveBody,
  customerParams,
  editBody,
  prepareBody,
  reasonBody,
  reminderAnswer,
  reminderCountsAnswer,
  reminderParams,
  remindersAnswer,
  remindersQuery,
  sendBody,
  sendStatementBody,
  sentStatementAnswer,
  settingsAnswer,
  settingsBody,
  settingsQuery,
  statementAnswer,
  statementQuery,
  switchBody,
} from '@nexus/factory-domain/receivables/contracts'

/** The route contracts of receivables: the shapes are factory-domain's receivables/contracts. */

export const ageingContract = defineContract({ querystring: ageingQuery, response: { 200: ageingAnswer } })
export const statementContract = defineContract({ params: customerParams, querystring: statementQuery, response: { 200: statementAnswer } })
// The PDF itself (application/pdf), stored nowhere.
export const statementPdfContract = defineContract({ params: customerParams, querystring: statementQuery, response: {} })
export const sendStatementContract = defineContract({ params: customerParams, body: sendStatementBody, response: { 201: sentStatementAnswer } })
export const settingsContract = defineContract({ querystring: settingsQuery, response: { 200: settingsAnswer } })
export const putSettingsContract = defineContract({ body: settingsBody, response: { 200: settingsAnswer } })
export const switchContract = defineContract({ body: switchBody, response: { 200: settingsAnswer } })
export const listRemindersContract = defineContract({ querystring: remindersQuery, response: { 200: remindersAnswer } })
export const reminderCountsContract = defineContract({ querystring: settingsQuery, response: { 200: reminderCountsAnswer } })
export const getReminderContract = defineContract({ params: reminderParams, response: { 200: reminderAnswer } })
export const letterPdfContract = defineContract({ params: reminderParams, response: {} })
export const prepareContract = defineContract({ body: prepareBody, response: { 201: reminderAnswer } })
export const editContract = defineContract({ params: reminderParams, body: editBody, response: { 200: reminderAnswer } })
export const approveContract = defineContract({ params: reminderParams, body: approveBody, response: { 200: reminderAnswer } })
export const sendContract = defineContract({ params: reminderParams, body: sendBody, response: { 200: reminderAnswer } })
export const reasonContract = defineContract({ params: reminderParams, body: reasonBody, response: { 200: reminderAnswer } })
export const bulkApproveContract = defineContract({ body: bulkApproveBody, response: { 200: bulkApproveAnswer } })
