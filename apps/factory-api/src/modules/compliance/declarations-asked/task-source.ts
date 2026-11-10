import { TASK_PREFIX } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import type { TaskSource } from '../../../platform/portal/tasks/sources'

/**
 * B-W2b-256 (PRD-304; plan "a partner task in the supplier portal where the answer is a SupplierDocumentUpload"): a
 * declaration request asked in the supplier's portal is an UPLOAD_DOCUMENT task on the request (recordType
 * "SupplierDeclarationRequest", sourceKey `SupplierDeclaration:<requestId>`). The supplier answers by uploading its
 * declaration against the task (B-W2b-189's POST /portal/supplier-documents with `taskId`), which closes it; the request is
 * then ANSWERED by the worker (declarations-asked/jobs.ts). Only that answer closes it (no "done" in place); a cancelled
 * or re-asked request withdraws it.
 */
export const SUPPLIER_DECLARATION_SOURCE: TaskSource = Object.freeze({ name: 'compliance.supplierDeclarations', prefix: TASK_PREFIX, kinds: ['UPLOAD_DOCUMENT'] as const, partnerDone: false })
