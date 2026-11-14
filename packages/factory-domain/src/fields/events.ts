import { z } from 'zod'
import { defineEvent } from '../events/define'
import { FIELD_LIMITS, FIELD_TYPES } from './rules'

/**
 * The events of custom fields and picklists (B-W2b-421; PLT-111, PLT-115; apps/factory-api platform/fields; design
 * admin.fields "live: custom_field.* → grid rows"). Codes, ids and counts only: never a label (they are not secret, but a
 * live message stays small) and never a value (a value may be money or personal data).
 *
 *   custom_field.changed   a field of a record type was added, changed, reordered, archived or restored: Admin › Fields
 *                          & lists reloads its grid rows, a record form reads its fields again
 *   picklist.changed       a list was added, renamed, archived or restored, or its values were added, changed,
 *                          deactivated, activated again or reordered
 *   custom_value.changed   custom values of one record were set or cleared (the codes of the fields it reached): the
 *                          record's own screens read them again with their viewer's rights. No live message: who may
 *                          see a record is its own permission, not one this catalogue can name.
 */

export const FIELD_CHANGES = ['CREATED', 'EDITED', 'REORDERED', 'ARCHIVED', 'RESTORED'] as const
export const PICKLIST_CHANGES = ['CREATED', 'EDITED', 'ARCHIVED', 'RESTORED', 'VALUES_ADDED', 'VALUES_EDITED', 'VALUES_DEACTIVATED', 'VALUES_ACTIVATED', 'VALUES_REORDERED'] as const

const code = z.string().min(1).max(40)

export const events = [
  defineEvent({
    type: 'custom_field.changed',
    context: 'fields',
    description: 'Custom fields of a record type were added, changed, reordered, archived or restored.',
    payload: z.strictObject({
      recordType: z.string().min(1).max(63),
      change: z.enum(FIELD_CHANGES),
      fieldIds: z.array(z.uuid()).min(1).max(FIELD_LIMITS.perRecordType),
      codes: z.array(code).min(1).max(FIELD_LIMITS.perRecordType),
      type: z.enum(FIELD_TYPES).nullable(),
    }),
    live: { permission: 'fields.view', fields: ['recordType', 'change', 'fieldIds', 'codes', 'type'] },
  }),
  defineEvent({
    type: 'picklist.changed',
    context: 'fields',
    description: 'A picklist was added, renamed, archived or restored, or its values were added, changed, deactivated, activated again or reordered.',
    payload: z.strictObject({
      picklistId: z.uuid(),
      code,
      change: z.enum(PICKLIST_CHANGES),
      /** The value codes the change reached (empty for the list itself). */
      values: z.array(code).max(FIELD_LIMITS.perList),
    }),
    live: { permission: 'fields.view', fields: ['picklistId', 'code', 'change', 'values'] },
  }),
  defineEvent({
    type: 'custom_value.changed',
    context: 'fields',
    description: 'Custom values of one record were set or cleared.',
    payload: z.strictObject({
      recordType: z.string().min(1).max(63),
      recordId: z.uuid(),
      set: z.array(code).max(FIELD_LIMITS.perRequest),
      cleared: z.array(code).max(FIELD_LIMITS.perRequest),
    }),
  }),
] as const
