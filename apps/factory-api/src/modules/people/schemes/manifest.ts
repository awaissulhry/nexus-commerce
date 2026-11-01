import { defineManifest } from '../../../core/manifest'

/**
 * Incentive schemes (B-W2b-38; MES-253, MES-257, MES-258, MES-259; GATE-PIECE-PAY): the "Scheme" section of People › Piece
 * rates, under its permissions (people.piecerates.view to read, people.piecerates.manage to keep: a scheme is what piece
 * pay rests on, as the legal switch's preconditions are). A scheme belongs to a company, or to a line of one of its sites,
 * so the handlers check each with can() (a company's scheme only by a grant that reaches every site of the company) and
 * filter lists with scopeWhere() (`record`); a guaranteed rate in an answer or a body is `money.pay` (HR and the worker).
 */
export const manifest = defineManifest({
  'GET /people/incentive-schemes': { audiences: ['office'], permission: 'people.piecerates.view', scope: 'record' },
  'POST /people/incentive-schemes': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'GET /people/incentive-schemes/:schemeId': { audiences: ['office'], permission: 'people.piecerates.view', scope: 'record' },
  'PATCH /people/incentive-schemes/:schemeId': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'DELETE /people/incentive-schemes/:schemeId': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/incentive-schemes/:schemeId/activate': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/incentive-schemes/:schemeId/end': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/incentive-schemes/:schemeId/example': { audiences: ['office'], permission: 'people.piecerates.view', scope: 'record' },
})
