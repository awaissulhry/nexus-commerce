import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { serverClock } from '../../core/time'
import { addFollowerContract, followersContract, mentionablePeopleContract, postNoteContract, readThreadContract, setMyFollowContract, setStatusContract, timelineContract } from './contract'
import { addFollower, listFollowers, setMyFollow } from './followers'
import { manifest } from './manifest'
import { mentionablePeople, postNote, readThread, setThreadStatus } from './threads'
import { readTimeline } from './timeline'
// B-TH-027: each person's own read mark.
import { markReadContract, markUnreadContract, unreadContract } from './contract'
import { markThreadRead, markThreadUnread, unreadCounts } from './reads'
// B-TH-028: who answers the conversation.
import { setOwnerContract } from './contract'
import { setThreadOwner } from './owner'
// B-TH-044: a reply the record's party reads in its portal (no mail).
import { postReplyContract } from './contract'
import { postPortalReply } from './replies'
// B-TH-047: conversations waiting on us across records.
import { waitingContract } from './contract'
import { listWaiting } from './waiting-list'

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

  // ---- B-TH-047
  app.get('/threads/waiting', { schema: waitingContract }, async (request) => listWaiting(request, request.query))
  // ---- end B-TH-047

  // ---- B-TH-027
  app.post('/threads/unread', { schema: unreadContract }, async (request) => unreadCounts(request, request.body.records.map((record) => ({ type: record.recordType, id: record.recordId }))))
  app.post('/threads/:recordType/:recordId/read', { schema: markReadContract }, async (request) => markThreadRead(request, { type: request.params.recordType, id: request.params.recordId }, request.body, idempotencyKeyFrom(request)))
  app.post('/threads/:recordType/:recordId/unread', { schema: markUnreadContract }, async (request) => markThreadUnread(request, { type: request.params.recordType, id: request.params.recordId }, request.body, idempotencyKeyFrom(request)))
  // ---- end B-TH-027
  // ---- B-TH-028
  app.put('/threads/:recordType/:recordId/owner', { schema: setOwnerContract }, async (request) => setThreadOwner(request, { type: request.params.recordType, id: request.params.recordId }, request.body, idempotencyKeyFrom(request)))
  // ---- end B-TH-028

  app.get('/threads/:recordType/:recordId/timeline', { schema: timelineContract }, async (request) => {
    const { recordType, recordId } = request.params
    return readTimeline(request, { type: recordType, id: recordId }, request.query)
  })

  app.post('/threads/:recordType/:recordId/notes', { schema: postNoteContract }, async (request, reply) => {
    const { recordType, recordId } = request.params
    return reply.code(201).send(await postNote(request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request)))
  })

  // ---- B-TH-044
  app.post('/threads/:recordType/:recordId/replies', { schema: postReplyContract }, async (request, reply) => reply.code(201).send(await postPortalReply(request, { type: request.params.recordType, id: request.params.recordId }, request.body, idempotencyKeyFrom(request))))
  // ---- end B-TH-044

  app.get('/threads/:recordType/:recordId/people', { schema: mentionablePeopleContract }, async (request) => {
    const { recordType, recordId } = request.params
    return { people: await mentionablePeople(request, { type: recordType, id: recordId }, serverClock.now()) }
  })

  app.put('/threads/:recordType/:recordId/status', { schema: setStatusContract }, async (request) => {
    const { recordType, recordId } = request.params
    return { thread: await setThreadStatus(request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request)) }
  })

  // B-W2a-20 (COL-011): the record's followers, my own follow, adding a colleague.
  app.get('/threads/:recordType/:recordId/followers', { schema: followersContract }, async (request) => {
    const { recordType, recordId } = request.params
    return listFollowers(request, { type: recordType, id: recordId })
  })

  app.put('/threads/:recordType/:recordId/followers/me', { schema: setMyFollowContract }, async (request) => {
    const { recordType, recordId } = request.params
    return setMyFollow(request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request))
  })

  app.post('/threads/:recordType/:recordId/followers', { schema: addFollowerContract }, async (request) => {
    const { recordType, recordId } = request.params
    return addFollower(request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request))
  })
})
