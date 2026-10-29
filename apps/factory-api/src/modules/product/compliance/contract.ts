import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  complianceDocumentDetail,
  complianceDocumentView,
  listDocumentsQuery,
  styleComplianceQuery,
  styleComplianceView,
  uploadDocumentBody,
} from '@nexus/factory-domain/product/compliance/contracts'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The style compliance tab's contracts (B-W1-20; A2 SCR-045): the bodies and answers are factory-domain's
 * product/compliance/contracts; an upload answers with the files platform's file and presigned request.
 */

const style = input({ styleId: id() })
const document = input({ styleId: id(), documentId: id() })
const documentFile = input({ styleId: id(), documentId: id(), fileId: id() })

export const styleComplianceContract = defineContract({ params: style, querystring: styleComplianceQuery, response: { 200: output({ compliance: styleComplianceView }) } })
export const listDocumentsContract = defineContract({ params: style, querystring: listDocumentsQuery, response: { 200: output({ documents: z.array(complianceDocumentView) }) } })
export const getDocumentContract = defineContract({ params: document, response: { 200: output({ document: complianceDocumentDetail }) } })
export const uploadDocumentContract = defineContract({
  params: style,
  body: uploadDocumentBody,
  response: { 201: output({ document: complianceDocumentView, file: fileView, upload: presignedView }) },
})
export const completeDocumentFileContract = defineContract({ params: documentFile, response: { 200: output({ document: complianceDocumentDetail, file: fileView }) } })
export const downloadDocumentFileContract = defineContract({ params: documentFile, response: { 200: output({ download: presignedView }) } })
