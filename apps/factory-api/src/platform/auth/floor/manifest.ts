import { defineManifest, PUBLIC, SIGNED_IN } from '../../../core/manifest'

/**
 * Floor sign-in (plan A1 §3.10 "Floor"). The device's own routes are public: they check the device token (or the
 * enrolment code) and the CSRF double submit themselves, before any operator is signed in. The signed-in operator's
 * routes need a floor session (any: a worker whose PIN must change still reaches them). The Office's routes are scoped
 * by record: the handler checks each device, worker, badge and site with can() and filters lists with scopeWhere(). A
 * worker's floor roles and credentials (badges, PIN) also need a fresh office step-up (workers.roles, workers.credentials).
 */
export const manifest = defineManifest({
  'POST /floor/device/enrol': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /floor/device': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  // B-W2a-42: the tablet's own state (app version, battery, queue count); the device token and CSRF, like the enrolment.
  'POST /floor/device/state': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /floor/sign-in': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /floor/sign-out': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /floor/switch': { audiences: ['floor'], permission: SIGNED_IN, scope: 'site' },
  'GET /floor/me': { audiences: ['floor'], permission: SIGNED_IN, scope: 'site' },
  'POST /floor/pin': { audiences: ['floor'], permission: SIGNED_IN, scope: 'site' },
  'POST /floor/step-up': { audiences: ['floor'], permission: SIGNED_IN, scope: 'site' },
  // B-W2b-52: the kiosk check (PLT-227; the device token and CSRF, like the tablet's state) and crew mode (PLT-059: from a
  // signed-in station tablet; a join is a sign-in, so no permission beyond the session, as POST /floor/switch).
  'POST /floor/device/kiosk': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /floor/crew': { audiences: ['floor'], permission: SIGNED_IN, scope: 'site' },
  'POST /floor/crew/join': { audiences: ['floor'], permission: SIGNED_IN, scope: 'site' },
  'POST /floor/crew/switch': { audiences: ['floor'], permission: SIGNED_IN, scope: 'site' },
  'POST /floor/crew/leave': { audiences: ['floor'], permission: SIGNED_IN, scope: 'site' },
  'POST /floor/crew/end': { audiences: ['floor'], permission: SIGNED_IN, scope: 'site' },

  'GET /auth/floor/devices': { audiences: ['office'], permission: 'devices.view', scope: 'record' },
  'POST /auth/floor/devices': { audiences: ['office'], permission: 'devices.manage', scope: 'record' },
  'POST /auth/floor/devices/:deviceId/enrolment': { audiences: ['office'], permission: 'devices.manage', scope: 'record' },
  'PATCH /auth/floor/devices/:deviceId': { audiences: ['office'], permission: 'devices.manage', scope: 'record' },
  'POST /auth/floor/devices/:deviceId/revoke': { audiences: ['office'], permission: 'devices.revoke', scope: 'record' },
  'GET /auth/floor/sites/:siteId/settings': { audiences: ['office'], permission: 'devices.view', scope: 'record' },
  'PUT /auth/floor/sites/:siteId/settings': { audiences: ['office'], permission: 'devices.manage', scope: 'record' },

  'GET /auth/floor/workers': { audiences: ['office'], permission: 'workers.view', scope: 'record' },
  'POST /auth/floor/workers': { audiences: ['office'], permission: 'workers.manage', scope: 'record' },
  'PATCH /auth/floor/workers/:workerId': { audiences: ['office'], permission: 'workers.manage', scope: 'record' },
  'POST /auth/floor/workers/:workerId/deactivate': { audiences: ['office'], permission: 'workers.manage', scope: 'record' },
  'POST /auth/floor/workers/:workerId/reactivate': { audiences: ['office'], permission: 'workers.manage', scope: 'record' },
  'PUT /auth/floor/workers/:workerId/roles': { audiences: ['office'], permission: 'workers.roles', scope: 'record' },
  'POST /auth/floor/workers/:workerId/badges': { audiences: ['office'], permission: 'workers.credentials', scope: 'record' },
  'POST /auth/floor/badges/:badgeId/revoke': { audiences: ['office'], permission: 'workers.credentials', scope: 'record' },
  'POST /auth/floor/workers/:workerId/pin-reset': { audiences: ['office'], permission: 'workers.credentials', scope: 'record' },
})
