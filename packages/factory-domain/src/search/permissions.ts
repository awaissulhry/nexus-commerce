import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Global search (apps/factory-api platform/search; B-W2a-32; PLT-153; design shell.search). Searching needs no
 * permission of its own: any office session searches, and each result is a record its reader may open — its entry names
 * the record's own view permission (`orders.view`, `parties.view` …) and its company, site and party, filtered by the
 * reader's grants exactly as the record's own list is. Rebuilding the index of the whole tenant (every record type read
 * again, entries of records that are gone removed) is search.rebuild. Nothing here carries money or names a worker.
 */
export const SEARCH_DEFINITIONS = definePermissions('search', {
  rebuild: {
    risk: 'write',
    description: "Rebuild the search index of the whole group: every record is read again and its entry rewritten, and the entries of records that are gone are removed (results stay the same for everyone; nothing is changed in the records).",
  },
})

export const SEARCH_REBUILD = 'search.rebuild' satisfies Permission

export const SEARCH_PERMISSIONS: readonly Permission[] = Object.freeze([SEARCH_REBUILD])
