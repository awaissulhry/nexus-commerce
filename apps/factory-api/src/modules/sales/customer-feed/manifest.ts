import { defineManifest } from '../../../core/manifest'

/**
 * "All of <Customer>" (B-SA-060; sales page plan R4, P9'; 13-backend B8). Office only: threads.read, checked per record — the
 * customer's own conversation (the Party thread) first, else 404 "Customer not found." (the words of an unknown customer), then
 * each conversation with its own scope (platform/threads/records.ts mayOnThread). A read: no command, no event.
 */
export const manifest = defineManifest({
  'GET /sales/customers/:partyId/feed': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
})
