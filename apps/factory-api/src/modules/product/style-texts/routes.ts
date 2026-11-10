import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { putTextContract, readPrivateLabelContract, readTextsContract, removeTextContract, setPrivateLabelContract } from './contract'
import { manifest } from './manifest'
import { readPrivateLabel, setPrivateLabel } from './private-label'
import { putText, readTexts, removeText } from './texts'

/**
 * A style's names and descriptions per language (B-W2b-227; PRD-019; ./texts.ts) and its private label (PRD-010;
 * ./private-label.ts). Readers of a text in a language (labels, the tech pack, the portal, the search) use ./texts.ts
 * `resolvedTextsOf` / `namesOf`.
 */
export default defineRoutes('product.style-texts', manifest, async (app) => {
  app.get('/product/styles/:styleId/texts', { schema: readTextsContract }, async (request) => ({ texts: await readTexts(request, request.params.styleId, request.query) }))
  app.put('/product/styles/:styleId/texts/:language', { schema: putTextContract }, async (request) => ({
    texts: await putText(request, request.params.styleId, request.params.language, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/product/styles/:styleId/texts/:language/remove', { schema: removeTextContract }, async (request) => ({
    texts: await removeText(request, request.params.styleId, request.params.language, request.body, idempotencyKeyFrom(request)),
  }))
  app.get('/product/styles/:styleId/private-label', { schema: readPrivateLabelContract }, async (request) => ({ privateLabel: await readPrivateLabel(request, request.params.styleId) }))
  app.put('/product/styles/:styleId/private-label', { schema: setPrivateLabelContract }, async (request) => ({
    privateLabel: await setPrivateLabel(request, request.params.styleId, request.body, idempotencyKeyFrom(request)),
  }))
})
