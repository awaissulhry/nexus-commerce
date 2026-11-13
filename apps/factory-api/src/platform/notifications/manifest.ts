import { defineManifest } from '../../core/manifest'

/**
 * The notification centre (B-W2a-20; PLT-138, PLT-142; design home.notifications, the shell's bell): office only, each
 * person their own notifications and their own digest. home.view reaches Home (the bell, the page); every row is the
 * reader's own (`record`: the handlers read only the session's person's rows).
 */
export const manifest = defineManifest({
  'GET /notifications': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /notifications/counts': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /notifications/read': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /notifications/done': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /notifications/snooze': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /notifications/wake': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /notifications/digest': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'PUT /notifications/digest': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  // B-W2b-385 (PLT-140, PLT-141, PLT-151): my own matrix, devices and followed views (home.view, my rows only); the defaults
  // of the office roles (home.notifications.manage, tenant-wide).
  'GET /notifications/preferences': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'PUT /notifications/preferences': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'DELETE /notifications/preferences': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /notifications/role-defaults': { audiences: ['office'], permission: 'home.notifications.manage', scope: 'tenant' },
  'PUT /notifications/role-defaults': { audiences: ['office'], permission: 'home.notifications.manage', scope: 'tenant' },
  'GET /notifications/push': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /notifications/push/devices': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'DELETE /notifications/push/devices/:deviceId': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /notifications/push/test': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /notifications/following/views': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'PUT /notifications/following/views/:viewId': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'DELETE /notifications/following/views/:viewId': { audiences: ['office'], permission: 'home.view', scope: 'record' },
})
