import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { approveContract, createPhraseContract, editPhraseContract, getPhraseContract, listPhrasesContract, proposeContract, textsContract, withdrawContract } from './contract'
import { manifest } from './manifest'
import { approveTranslation, createPhrase, editPhrase, getPhrase, listPhrases, phraseTexts, proposeTranslation, withdrawTranslation } from './phrases'

/**
 * The phrase library (B-W2b-249; PRD-343): approved translations of warnings, care, marking, DoC, user information and
 * claim phrases, versioned. The screens are B-W2b-265 (Rules & markets › Phrases & translations) and B-W2b-270 (Labels ›
 * Languages); labels, DoCs and leaflets read the words with GET …/texts.
 */
export default defineRoutes('compliance.phrases', manifest, async (app) => {
  app.get('/compliance/rules/phrases', { schema: listPhrasesContract }, async (request) => listPhrases(request, request.query))
  app.get('/compliance/rules/phrases/texts', { schema: textsContract }, async (request) => phraseTexts(request, request.query))
  app.post('/compliance/rules/phrases', { schema: createPhraseContract }, async (request) => createPhrase(request, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/rules/phrases/:key', { schema: getPhraseContract }, async (request) => getPhrase(request, request.params.key))
  app.patch('/compliance/rules/phrases/:key', { schema: editPhraseContract }, async (request) => editPhrase(request, request.params.key, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/rules/phrases/:key/translations', { schema: proposeContract }, async (request) => proposeTranslation(request, request.params.key, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/rules/phrases/:key/translations/:translationId/approve', { schema: approveContract }, async (request) =>
    approveTranslation(request, request.params.key, request.params.translationId, request.body, idempotencyKeyFrom(request)),
  )
  app.delete('/compliance/rules/phrases/:key/translations/:translationId', { schema: withdrawContract }, async (request) =>
    withdrawTranslation(request, request.params.key, request.params.translationId, request.query.version, idempotencyKeyFrom(request)),
  )
})
