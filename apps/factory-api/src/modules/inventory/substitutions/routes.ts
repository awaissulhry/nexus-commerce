import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { askSubstitute } from './ask'
import { askContract, issueContract, listContract, optionsContract, recordContract, withdrawContract } from './contract'
import { withdrawSubstitute } from './decisions'
import { issueSubstitute } from './issue-substitute'
import { manifest } from './manifest'
import { substituteOptions } from './options'
import { listSubstitutions, substitutionRecord } from './reads'

/**
 * Substitutes with a yes (B-W2b-298; MES-139; follow-up PK1:01): "Use a substitute" (the dialog's read and the ask), the
 * office's list and record, the withdrawal and the issue of an approved substitute. The yes is the approval engine's kind
 * MATERIAL_SUBSTITUTION (platform/approvals/kinds/material-substitution.ts).
 */
export default defineRoutes('inventory.substitutions', manifest, async (app) => {
  app.get('/inventory/substitutions/options', { schema: optionsContract }, async (request) => substituteOptions(request, request.query))

  app.post('/inventory/substitutions', { schema: askContract }, async (request, reply) => reply.code(201).send(await askSubstitute(request, request.body, idempotencyKeyFrom(request))))

  app.get('/inventory/substitutions', { schema: listContract }, async (request) => listSubstitutions(request, request.query))

  app.get('/inventory/substitutions/:substitutionId', { schema: recordContract }, async (request) => substitutionRecord(request, request.params.substitutionId))

  app.post('/inventory/substitutions/:substitutionId/withdraw', { schema: withdrawContract }, async (request) => withdrawSubstitute(request, request.params.substitutionId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/substitutions/:substitutionId/issue', { schema: issueContract }, async (request, reply) =>
    reply.code(201).send(await issueSubstitute(request, request.params.substitutionId, request.body, idempotencyKeyFrom(request))),
  )
})
