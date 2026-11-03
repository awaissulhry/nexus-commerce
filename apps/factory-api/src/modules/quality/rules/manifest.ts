import { defineManifest } from '../../../core/manifest'

/**
 * Quality rules (B-W2b-118; QHS-154, QHS-300; design quality.settings SCR-260). Office only. The page reads with
 * quality.rules.view over the company read (tenant-wide: any grant); who may sign what and the result rules change with
 * quality.settings.manage over the company (tenant-wide: a grant over every company), checked in the handler; the alert
 * and escalation rules with quality.alerts.manage over the rule's company (every company: a grant over every company).
 */
export const manifest = defineManifest({
  'GET /quality/rules': { audiences: ['office'], permission: 'quality.rules.view', scope: 'record' },
  'PUT /quality/rules/duties': { audiences: ['office'], permission: 'quality.settings.manage', scope: 'record' },
  'PUT /quality/rules/results': { audiences: ['office'], permission: 'quality.settings.manage', scope: 'record' },
  'GET /quality/alert-rules': { audiences: ['office'], permission: 'quality.rules.view', scope: 'record' },
  'POST /quality/alert-rules': { audiences: ['office'], permission: 'quality.alerts.manage', scope: 'record' },
  'PATCH /quality/alert-rules/:ruleId': { audiences: ['office'], permission: 'quality.alerts.manage', scope: 'record' },
  'DELETE /quality/alert-rules/:ruleId': { audiences: ['office'], permission: 'quality.alerts.manage', scope: 'record' },
  'POST /quality/alert-rules/starter': { audiences: ['office'], permission: 'quality.alerts.manage', scope: 'record' },
  'POST /quality/alert-rules/:ruleId/test': { audiences: ['office'], permission: 'quality.alerts.manage', scope: 'record' },
})
