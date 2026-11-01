import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { authorise, changeValidUntil, revokeAuthorisation } from './authorisations'
import { createSkill, listSkills, setSkillStatus, updateSkill } from './catalogue'
import { floorCheck, lineCheck, officeCheck } from './check'
import {
  authoriseContract,
  cellContract,
  createSkillContract,
  employeeSkillsContract,
  floorCheckContract,
  lineCheckContract,
  listSkillsContract,
  matrixContract,
  officeCheckContract,
  removeLevelContract,
  revokeContract,
  setLevelContract,
  signOffContract,
  skillStatusContract,
  updateSkillContract,
  validUntilContract,
} from './contract'
import { removeLevel, setLevel, signOffTrainee } from './levels'
import { manifest } from './manifest'
import { cellDetail, employeeSkills, skillsMatrix } from './matrix'

/**
 * Skills and machine authorisations (B-W2b-39; MES-241, MES-244, MES-246, MES-024): the skills (./catalogue.ts), the
 * matrix and a person's skills (./matrix.ts), levels and trainees (./levels.ts), machine authorisations
 * (./authorisations.ts) and the qualification check dispatch and the tablet call (./check.ts). Each write is one command
 * with an Idempotency-Key.
 */
export default defineRoutes('people.skills', manifest, async (app) => {
  app.get('/people/skills', { schema: listSkillsContract }, async (request) => listSkills(request, request.query))
  app.post('/people/skills', { schema: createSkillContract }, async (request, reply) => {
    const { replayed, ...answer } = await createSkill(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.patch('/people/skills/:skillId', { schema: updateSkillContract }, async (request) => updateSkill(request, request.params.skillId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/skills/:skillId/archive', { schema: skillStatusContract }, async (request) => setSkillStatus(request, request.params.skillId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)))
  app.post('/people/skills/:skillId/restore', { schema: skillStatusContract }, async (request) => setSkillStatus(request, request.params.skillId, 'ACTIVE', request.body, idempotencyKeyFrom(request)))

  app.get('/people/skills/matrix', { schema: matrixContract }, async (request) => skillsMatrix(request, request.query))
  app.get('/people/skills/cell', { schema: cellContract }, async (request) => cellDetail(request, request.query))
  app.get('/people/employees/:employeeId/skills', { schema: employeeSkillsContract }, async (request) => employeeSkills(request, request.params.employeeId))

  app.post('/people/skills/levels', { schema: setLevelContract }, async (request) => {
    const { replayed: _replayed, ...answer } = await setLevel(request, request.body, idempotencyKeyFrom(request))
    return answer
  })
  app.post('/people/skills/levels/:levelId/sign-off', { schema: signOffContract }, async (request) =>
    signOffTrainee(request, request.params.levelId, request.body, { stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )
  app.post('/people/skills/levels/:levelId/remove', { schema: removeLevelContract }, async (request) => removeLevel(request, request.params.levelId, request.body, idempotencyKeyFrom(request)))

  app.post('/people/skills/authorisations', { schema: authoriseContract }, async (request, reply) => {
    const { replayed, ...answer } = await authorise(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.post('/people/skills/authorisations/:authorisationId/valid-until', { schema: validUntilContract }, async (request) =>
    changeValidUntil(request, request.params.authorisationId, request.body, idempotencyKeyFrom(request)),
  )
  app.post('/people/skills/authorisations/:authorisationId/revoke', { schema: revokeContract }, async (request) => revokeAuthorisation(request, request.params.authorisationId, request.body, idempotencyKeyFrom(request)))

  app.get('/people/skills/check', { schema: officeCheckContract }, async (request) => officeCheck(request, request.query))
  app.get('/people/skills/line-check', { schema: lineCheckContract }, async (request) => lineCheck(request, request.query))
  app.get('/people/skills/floor/check', { schema: floorCheckContract }, async (request) => floorCheck(request, request.query))
})
