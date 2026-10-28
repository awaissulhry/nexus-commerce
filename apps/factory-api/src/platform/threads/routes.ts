import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { serverClock } from '../../core/time'
import { mentionablePeopleContract, postNoteContract, readThreadContract, setStatusContract, timelineContract } from './contract'
import { manifest } from './manifest'
import { mentionablePeople, postNote, readThread, setThreadStatus } from './threads'
import { readTimeline } from './timeline'

/**
 * Record threads and the record timeline (platform part; plan A1 §2.3, §3.7; features COL-001, COL-002, COL-003): read
 * a record's thread, write an internal note, list who a note may mention, close or reopen the thread, read the record's
 * timeline. Mail sent to the record's party and its replies enter the same thread in the email steps, through
 * `ensureThread` and `writeMessage`.
 */
export default defineRoutes('threads', manifest, async (app) => {
  app.get('/threads/:recordType/:recordId', { schema: readThreadContract }, async (request) => {
    const { recordType, recordId } = request.params
    return readThread(request, { type: recordType, id: recordId }, request.query)
  })

  app.get('/threads/:recordType/:recordId/timeline', { schema: timelineContract }, async (request) => {
    const { recordType, recordId } = request.params
    return readTimeline(request, { type: recordType, id: recordId }, request.query)
  })

  app.post('/threads/:recordType/:recordId/notes', { schema: postNoteContract }, async (request, reply) => {
    const { recordType, recordId } = request.params
    return reply.code(201).send(await postNote(request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request)))
  })

  app.get('/threads/:recordType/:recordId/people', { schema: mentionablePeopleContract }, async (request) => {
    const { recordType, recordId } = request.params
    return { people: await mentionablePeople(request, { type: recordType, id: recordId }, serverClock.now()) }
  })

  app.put('/threads/:recordType/:recordId/status', { schema: setStatusContract }, async (request) => {
    const { recordType, recordId } = request.params
    return { thread: await setThreadStatus(request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request)) }
  })
})
