import { defineManifest } from '../../../core/manifest'

/**
 * The PPE register's routes (B-W1-43; QHS-118; Reg. (EU) 2016/425 art. 8(4), 8(8)). Office only: the floor and the
 * portal read nothing of the register. An entry belongs to its company and to the party that reported it, so the
 * handlers check each one with can() and filter lists with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /compliance/register': { audiences: ['office'], permission: 'compliance.register.view', scope: 'record' },
  'POST /compliance/register/trace': { audiences: ['office'], permission: 'compliance.register.view', scope: 'record' },
  'GET /compliance/register/:entryId': { audiences: ['office'], permission: 'compliance.register.view', scope: 'record' },
  'POST /compliance/register': { audiences: ['office'], permission: 'compliance.register.manage', scope: 'record' },
  'PATCH /compliance/register/:entryId': { audiences: ['office'], permission: 'compliance.register.manage', scope: 'record' },
  'POST /compliance/register/:entryId/corrective-action/complete': { audiences: ['office'], permission: 'compliance.register.manage', scope: 'record' },
  'POST /compliance/register/:entryId/distributors-informed': { audiences: ['office'], permission: 'compliance.register.manage', scope: 'record' },
  'POST /compliance/register/:entryId/authority-notified': { audiences: ['office'], permission: 'compliance.register.manage', scope: 'record' },
  'POST /compliance/register/:entryId/close': { audiences: ['office'], permission: 'compliance.register.manage', scope: 'record' },
  'POST /compliance/register/:entryId/notes': { audiences: ['office'], permission: 'compliance.register.manage', scope: 'record' },
})
