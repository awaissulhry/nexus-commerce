import { defineManifest } from '../../../core/manifest'

/**
 * Piece rates and the legal switch of piece pay (B-W2b-34; MES-254, MES-255, MES-262; GATE-PIECE-PAY). The office: a
 * table belongs to a company and a site, so the handlers check each with can() and filter lists with scopeWhere()
 * (`record`); a rate in an answer or a body is `money.pay` (HR and the worker). Starting piece pay asks for a fresh
 * step-up inside the handler; stopping it never does. The floor: the device's own site (`site`), the signed-in worker's
 * own publications; confirming a reading asks for the PIN again.
 */
export const manifest = defineManifest({
  'GET /people/piece-rates': { audiences: ['office'], permission: 'people.piecerates.view', scope: 'record' },
  'GET /people/piece-rates/rates': { audiences: ['office'], permission: 'people.piecerates.view', scope: 'record' },
  'GET /people/piece-rates/tables': { audiences: ['office'], permission: 'people.piecerates.view', scope: 'record' },
  'POST /people/piece-rates/tables': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'GET /people/piece-rates/tables/:tableId': { audiences: ['office'], permission: 'people.piecerates.view', scope: 'record' },
  'PATCH /people/piece-rates/tables/:tableId': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/tables/:tableId/archive': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/tables/:tableId/versions': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/versions/confirm': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/versions/confirm/preview': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'GET /people/piece-rates/versions/:versionId': { audiences: ['office'], permission: 'people.piecerates.view', scope: 'record' },
  'PATCH /people/piece-rates/versions/:versionId': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'PUT /people/piece-rates/versions/:versionId/rates': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/versions/:versionId/cancel': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'GET /people/piece-rates/versions/:versionId/publish/preview': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/versions/:versionId/publish': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/versions/:versionId/put-in-force': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/versions/:versionId/confirm': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/publications/:publicationId/withdraw': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/publications/:publicationId/paper-receipts': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'GET /people/piece-rates/sites/:siteId/switch': { audiences: ['office'], permission: 'people.piecerates.view', scope: 'record' },
  'PUT /people/piece-rates/sites/:siteId/switch/preconditions': { audiences: ['office'], permission: 'people.piecerates.manage', scope: 'record' },
  'POST /people/piece-rates/sites/:siteId/switch/start': { audiences: ['office'], permission: 'people.piecerates.switch', scope: 'record' },
  'POST /people/piece-rates/sites/:siteId/switch/stop': { audiences: ['office'], permission: 'people.piecerates.switch', scope: 'record' },
  'GET /people/piece-rates/floor/mine': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /people/piece-rates/floor/publications/:publicationId/read': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
