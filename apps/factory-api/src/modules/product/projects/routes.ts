import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addPersonContract,
  closeProjectContract,
  createProjectContract,
  linkManyContract,
  linkRecordContract,
  listProjectsContract,
  moveProjectContract,
  myProjectsContract,
  peopleChoicesContract,
  portalProjectNewsContract,
  portalProjectsContract,
  projectCountsContract,
  projectPageContract,
  projectPeopleContract,
  recordProjectsContract,
  removePersonContract,
  similarProjectsContract,
  unlinkRecordContract,
  updateProjectContract,
} from './contract'
import { linkMany, linkRecord, projectsOfRecord, unlinkRecord } from './links'
import { listProjects, projectCounts, projectPage } from './list'
import { manifest } from './manifest'
import { addPerson, peopleChoices, projectPeople, removePerson } from './members'
import { partnerProjectNews } from './news'
import { portalProjects } from './portal'
import { createProject, moveProject, similarProjects, updateProject } from './projects'
import { myProjects } from './today'

/**
 * Projects (threads plan TH-5): ./projects.ts (the record, B-TH-066), ./links.ts (linked records both ways, B-TH-067), ./members.ts
 * (people, B-TH-068), ./portal.ts and ./news.ts (the partner's side and linked news, B-TH-069, B-TH-072; the partner view is
 * platform/search/partner/views/project.ts), ./list.ts (the list and the page, B-TH-070), ./today.ts (My projects, B-TH-071).
 */
export default defineRoutes('product.projects', manifest, async (app) => {
  app.get('/projects', { schema: listProjectsContract }, async (request) => listProjects(request, request.query))
  app.get('/projects/mine', { schema: myProjectsContract }, async (request) => myProjects(request))
  app.get('/projects/counts', { schema: projectCountsContract }, async (request) => projectCounts(request, request.query))
  app.get('/projects/similar', { schema: similarProjectsContract }, async (request) => similarProjects(request, request.query))
  app.get('/projects/of/:recordType/:recordId', { schema: recordProjectsContract }, async (request) => projectsOfRecord(request, request.params.recordType, request.params.recordId))
  app.get('/projects/:projectId', { schema: projectPageContract }, async (request) => projectPage(request, request.params.projectId))
  app.post('/projects', { schema: createProjectContract }, async (request, reply) => reply.code(201).send(await createProject(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/projects/:projectId', { schema: updateProjectContract }, async (request) => updateProject(request, request.params.projectId, request.body, idempotencyKeyFrom(request)))
  app.post('/projects/:projectId/hold', { schema: moveProjectContract }, async (request) => moveProject(request, request.params.projectId, 'HOLD', request.body, idempotencyKeyFrom(request)))
  app.post('/projects/:projectId/resume', { schema: moveProjectContract }, async (request) => moveProject(request, request.params.projectId, 'RESUME', request.body, idempotencyKeyFrom(request)))
  app.post('/projects/:projectId/close', { schema: closeProjectContract }, async (request) => moveProject(request, request.params.projectId, 'CLOSE', request.body, idempotencyKeyFrom(request)))
  app.post('/projects/:projectId/reopen', { schema: moveProjectContract }, async (request) => moveProject(request, request.params.projectId, 'REOPEN', request.body, idempotencyKeyFrom(request)))
  app.post('/projects/:projectId/links', { schema: linkRecordContract }, async (request) => linkRecord(request, request.params.projectId, request.body, idempotencyKeyFrom(request)))
  app.post('/projects/:projectId/links/bulk', { schema: linkManyContract }, async (request) => linkMany(request, request.params.projectId, request.body, idempotencyKeyFrom(request)))
  app.delete('/projects/:projectId/links/:linkId', { schema: unlinkRecordContract }, async (request) => unlinkRecord(request, request.params.projectId, request.params.linkId, idempotencyKeyFrom(request)))
  app.get('/projects/:projectId/people', { schema: projectPeopleContract }, async (request) => projectPeople(request, request.params.projectId))
  app.get('/projects/:projectId/people/choices', { schema: peopleChoicesContract }, async (request) => peopleChoices(request, request.params.projectId, request.query))
  app.post('/projects/:projectId/people', { schema: addPersonContract }, async (request) => addPerson(request, request.params.projectId, request.body, idempotencyKeyFrom(request)))
  app.delete('/projects/:projectId/people/:userId', { schema: removePersonContract }, async (request) => removePerson(request, request.params.projectId, request.params.userId, idempotencyKeyFrom(request)))
  app.get('/portal/projects', { schema: portalProjectsContract }, async (request) => portalProjects(request))
  app.get('/portal/projects/:projectId/news', { schema: portalProjectNewsContract }, async (request) => partnerProjectNews(request, request.params.projectId, request.query))
})
