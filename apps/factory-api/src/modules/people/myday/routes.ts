import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { inlineDisposition } from '../../receivables/pdf'
import { answersContract, myDayContract, printContract, statementPdfContract } from './contract'
import { manifest } from './manifest'
import { myStatementPdf, printMyStatement } from './statement'
import { myAnswers, myDay } from './today'

/**
 * Floor My day (B-W2b-68; design floor.myday): the worker's own day, with the PIN again on a shared tablet (Owner answer F1:
 * every figure asks requireFloorStepUp, even after a badge sign-in). Records and disputes are B-W2b-45's
 * (`/production/labour/floor/…`), the worker's own pay B-W2b-43's: `GET /people/myday` reads it through the same function.
 */
export default defineRoutes('people.myday', manifest, async (app) => {
  app.get('/people/myday', { schema: myDayContract }, async (request) => {
    requireFloorStepUp(officeAuthOf(app), request)
    return myDay(request, request.query)
  })
  app.get('/people/myday/answers', { schema: answersContract }, async (request) => myAnswers(request))
  app.get('/people/myday/statements/:statementId/pdf', { schema: statementPdfContract }, async (request, reply) => {
    requireFloorStepUp(officeAuthOf(app), request)
    const { pdf, fileName } = await myStatementPdf(request, request.params.statementId)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.post('/people/myday/statements/:statementId/print', { schema: printContract }, async (request, reply) => {
    requireFloorStepUp(officeAuthOf(app), request)
    return reply.code(201).send(await printMyStatement(request, request.params.statementId, idempotencyKeyFrom(request)))
  })
})
