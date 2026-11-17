import { defineManifest } from '../../../core/manifest'

/**
 * B-PR-43a — note to N records and ask the supervisor (production plan §3 "Note to N / Ask the supervisor — threads.post on each
 * record"). Office only: a floor, portal or link session is refused by audience (these are internal notes; nothing reaches a
 * customer). Each handler checks every record on its own (threads.read and threads.post over the record's own scope: `record`).
 */
export const manifest = defineManifest({
  'POST /production/notes': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
  'POST /production/notes/check': { audiences: ['office'], permission: 'threads.post', scope: 'record' },
})
