/**
 * In-process registries that every process needs, whatever its role.
 *
 * The API, the worker and the scheduler are separate processes since the split, and a
 * registry filled in one of them is empty in the others. These are looked up at the
 * moment of use, so a missing registration fails far from its cause:
 *   - channel specs: token refresh, connection health and the gateway read them in
 *     every outbound job ("No ChannelSpec registered for SHOPIFY" in a worker);
 *   - automation action handlers: a rule fires from a request (API), a finished bulk
 *     job (worker) or a schedule (scheduler), and an unregistered action type is
 *     recorded as "Unknown action type".
 *
 * Imported for its effects by src/index.ts, runtime/worker.ts and runtime/scheduler.ts;
 * runtime/registrations.vitest.test.ts holds each role to it.
 */
import '../services/cx/connectors/index.js'
import '../services/reviews/review-action-handlers.js'
import { registerBulkOpsActions } from '../services/automation/bulk-ops-actions.js'

registerBulkOpsActions()
