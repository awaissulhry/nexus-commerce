import { defineManifest } from '../../core/manifest'

/**
 * Exception rules and stored alerts (B-W2a-33; ANA-036, PLT-100; design home.alerts, admin.automation "Reminders &
 * timers"). Office only. Reading is alerts.view, each alert also behind its record's own view permission over its place
 * (`record`: the handlers check it); handling an alert is alerts.handle there; keeping the rules is alerts.rules.manage
 * over the rule's place.
 */
export const manifest = defineManifest({
  'GET /alerts': { audiences: ['office'], permission: 'alerts.view', scope: 'record' },
  'GET /alerts/counts': { audiences: ['office'], permission: 'alerts.view', scope: 'record' },
  'POST /alerts/acknowledge': { audiences: ['office'], permission: 'alerts.handle', scope: 'record' },
  'GET /alerts/rules': { audiences: ['office'], permission: 'alerts.view', scope: 'record' },
  'POST /alerts/rules': { audiences: ['office'], permission: 'alerts.rules.manage', scope: 'record' },
  'GET /alerts/rules/:id': { audiences: ['office'], permission: 'alerts.view', scope: 'record' },
  'PUT /alerts/rules/:id': { audiences: ['office'], permission: 'alerts.rules.manage', scope: 'record' },
  'POST /alerts/rules/:id/test': { audiences: ['office'], permission: 'alerts.view', scope: 'record' },
  'GET /alerts/rules/:id/timers': { audiences: ['office'], permission: 'alerts.rules.manage', scope: 'record' },
  'GET /alerts/:id': { audiences: ['office'], permission: 'alerts.view', scope: 'record' },
  'POST /alerts/:id/acknowledge': { audiences: ['office'], permission: 'alerts.handle', scope: 'record' },
  'POST /alerts/:id/assign': { audiences: ['office'], permission: 'alerts.handle', scope: 'record' },
  'POST /alerts/:id/snooze': { audiences: ['office'], permission: 'alerts.handle', scope: 'record' },
  'POST /alerts/:id/resolve': { audiences: ['office'], permission: 'alerts.handle', scope: 'record' },
})
