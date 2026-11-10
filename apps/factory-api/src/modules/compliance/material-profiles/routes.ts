import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { editProfileContract, getProfileContract, listProfilesContract } from './contract'
import { manifest } from './manifest'
import { editProfile, getProfile, listProfiles } from './profiles'

/**
 * Material profiles (B-W2b-256; PRD-303, PRD-314): every material with its compliance profile (the list and its tiles), one
 * material's profile (confirmations, EN ISO 13688 innocuousness evidence, declarations, lab results, evidence files), and
 * a person's confirmations, origin and note (the evaluator runs again in the same command). What the rules say of a
 * material is B-W2b-250's GET /compliance/substances/materials/:materialId/evaluation. The screens are B-W2b-267.
 */
export default defineRoutes('compliance.materialProfiles', manifest, async (app) => {
  app.get('/compliance/material-profiles', { schema: listProfilesContract }, async (request) => listProfiles(request, request.query))
  app.get('/compliance/material-profiles/:itemId', { schema: getProfileContract }, async (request) => getProfile(request, request.params.itemId))
  app.patch('/compliance/material-profiles/:itemId', { schema: editProfileContract }, async (request) => editProfile(request, request.params.itemId, request.body, idempotencyKeyFrom(request)))
})
