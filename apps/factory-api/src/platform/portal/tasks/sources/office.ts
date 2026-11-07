import { ASKABLE_KINDS } from '@nexus/factory-domain/portal/tasks/rules'
import type { TaskSource } from './index'

/**
 * B-W2b-167 (COL-043; design portal.customer.home "Tasks from us ('Upload your artwork for JKT-RACE by 5 Nov') → Upload",
 * office home.tasks "tasks staff give the customer"): an office person asks a partner for a document, an answer,
 * measurements or progress on a record of theirs, by a date (POST /partners/:partyId/tasks, ../office.ts). sourceKey
 * `Ask:<id>`: each ask is its own request. Such a request has no answer of its own yet, so the partner marks it done in the
 * portal (with Undo); the office may cancel, reopen it or move its date.
 */
export const OFFICE_SOURCE: TaskSource = Object.freeze({ name: 'office', prefix: 'Ask', kinds: ASKABLE_KINDS, partnerDone: true })
