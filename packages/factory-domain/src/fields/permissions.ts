import { definePermissions } from '../auth/permissions/registry'
import type { Permission } from '../core/permissions'

/**
 * Custom fields and picklists (apps/factory-api platform/fields; B-W2b-421; PLT-111, PLT-115; design admin.fields "Custom
 * fields", "Picklists", the popup "Add field to …"). Office only. A record's custom values are read and written with the
 * RECORD's own permissions (orders.view / orders.manage …, platform/fields/records.ts), never with these:
 *
 *   view            Admin › Fields & lists: every field of a record type with the archived ones and how many records have
 *                   a value, every picklist with its deactivated values
 *   manage          add, change, order, archive and restore custom fields; keep picklists and their values (colours,
 *                   icons, order, descriptions, deactivate)
 *   personal.view   see the custom fields marked personal ("visible to: personal") on the records you can see; without
 *                   it they are absent from forms, grids, filters, exports and imports. Never the read-only template's
 *                   (it takes every `read` permission): given by name to the templates below
 *
 * A MONEY field is seen with its grain (money.<grain>), like a built-in money field: no permission here gives money.
 */
export const FIELDS_DEFINITIONS = definePermissions('fields', {
  view: {
    risk: 'read',
    description: 'See the custom fields of every record type, archived ones included, with how many records have a value, and every picklist with its deactivated values.',
  },
  manage: {
    risk: 'write',
    description: 'Add custom fields to a record type, change their labels, section, order, rules and who sees them, archive and restore them; keep the picklists: values, colours, icons, order, descriptions, deactivate.',
  },
  // Risk `write` (as audit's reads.view): the read-only template takes every read, and personal data is given by name only.
  'personal.view': {
    risk: 'write',
    description: 'See the custom fields marked personal on the records you can see (a contact\'s own details); without it they are left out of every form, list, filter, export and import.',
  },
})

export const FIELDS_VIEW = 'fields.view' satisfies Permission
export const FIELDS_MANAGE = 'fields.manage' satisfies Permission
export const FIELDS_PERSONAL_VIEW = 'fields.personal.view' satisfies Permission

export const FIELDS_PERMISSIONS: readonly Permission[] = Object.freeze([FIELDS_VIEW, FIELDS_MANAGE, FIELDS_PERSONAL_VIEW])

/**
 * The role templates that get them (owner: every()). The administrator keeps the fields and lists; the people who work
 * with customers' and suppliers' contacts (sales, buyer) see their personal custom fields.
 */
export const FIELDS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [FIELDS_VIEW, FIELDS_MANAGE, FIELDS_PERSONAL_VIEW],
  sales: [FIELDS_PERSONAL_VIEW],
  buyer: [FIELDS_PERSONAL_VIEW],
})
