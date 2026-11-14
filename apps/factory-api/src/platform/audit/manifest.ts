import { defineManifest } from '../../core/manifest'

/** The audit log's routes (plan A1 §3.2 step 2). Reading a record's history needs audit.read; its rows are scoped. */
export const manifest = defineManifest({
  'GET /audit': { audiences: ['office'], permission: 'audit.read', scope: 'record' },
  'GET /audit/:recordType/:recordId': { audiences: ['office'], permission: 'audit.read', scope: 'record' },
  // B-W2b-399: the search with its field lines and one entry (audit.read over the rows); who looked (reads/); the security
  // events (security-events/). The last two are held over every company (reads/everywhere.ts).
  'GET /audit/search': { audiences: ['office'], permission: 'audit.read', scope: 'record' },
  'GET /audit/entries/:entryId': { audiences: ['office'], permission: 'audit.read', scope: 'record' },
  'GET /audit/reads': { audiences: ['office'], permission: 'audit.reads.view', scope: 'tenant' },
  'POST /audit/reads/person': { audiences: ['office'], permission: 'audit.reads.view', scope: 'tenant' },
  // B-W2b-413: the read log's switch, said on the screen (GATE-PRIVACY).
  'GET /audit/reads/status': { audiences: ['office'], permission: 'audit.reads.view', scope: 'tenant' },
  'GET /audit/security-events': { audiences: ['office'], permission: 'security.events.view', scope: 'tenant' },
  'GET /audit/security-events/:eventId': { audiences: ['office'], permission: 'security.events.view', scope: 'tenant' },
})
