import { z } from 'zod'
import {
  accountantParams,
  accountantsAnswer,
  accountantsQuery,
  changeAccountantBody,
  changedAccountantAnswer,
  endAccountantBody,
  endedAccountantAnswer,
  guestDownloadBody,
  guestFileParams,
  guestOverviewAnswer,
  guestPeriodAnswer,
  guestPeriodParams,
  guestZipBody,
  inviteAccountantBody,
  invitedAccountantAnswer,
} from '@nexus/factory-domain/accounting/guest/contracts'
import { defineContract, id, output } from '@nexus/factory-domain/core/contracts'
import { presignedView } from '../../../platform/files/contract'

/** The route contracts of accountant access (B-W2b-201): the shapes are factory-domain's accounting/guest/contracts. */

export const guestOverviewContract = defineContract({ response: { 200: guestOverviewAnswer } })
export const guestPeriodContract = defineContract({ params: guestPeriodParams, response: { 200: guestPeriodAnswer } })
export const guestDownloadContract = defineContract({
  params: guestFileParams,
  body: guestDownloadBody,
  response: { 200: output({ file: output({ id: id(), name: z.string() }), download: presignedView }) },
})
/** The zip itself answers (an attachment, stored nowhere); a refusal is the usual JSON error. */
export const guestZipContract = defineContract({ body: guestZipBody, response: {} })

export const accountantsContract = defineContract({ querystring: accountantsQuery, response: { 200: accountantsAnswer } })
export const inviteAccountantContract = defineContract({ body: inviteAccountantBody, response: { 201: invitedAccountantAnswer } })
export const changeAccountantContract = defineContract({ params: accountantParams, body: changeAccountantBody, response: { 200: changedAccountantAnswer } })
export const endAccountantContract = defineContract({ params: accountantParams, body: endAccountantBody, response: { 200: endedAccountantAnswer } })
