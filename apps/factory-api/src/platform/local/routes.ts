import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { defineRoutes } from '../../core/manifest'
import { localMailboxContract } from './contract'
import { manifest } from './manifest'
import { processLocalStack } from './stack'

/** The local mailbox's route, with its manifest entry (only registered on the local stack, below). */
const mailboxRoutes = defineRoutes('local-mailbox', manifest, async (app) => {
  app.get('/local/mailbox', { schema: localMailboxContract }, async (request) => {
    const context = request.factoryContext
    if (!context || context.audience !== 'office') throw new ForbiddenError()
    const mailbox = processLocalStack().mailbox
    if (!mailbox) throw new NotFoundError()
    const messages = await mailbox.list(context.tenantId, request.query.limit)
    return { messages: messages.map(({ tenantId: _tenant, ...message }) => message) }
  })
})

/**
 * The Owner's local test server (B-W2b-F58; stack.ts): on FACTORY_ENV=local the local mailbox's route; on test, staging and
 * production nothing is registered, not even the manifest entry, so `GET /local/mailbox` is a 404 for everyone.
 */
export default defineRoutes('local', {}, async (app) => {
  if (processLocalStack().mailbox) await app.register(mailboxRoutes)
})
