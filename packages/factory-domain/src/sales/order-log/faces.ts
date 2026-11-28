/**
 * The ONE order log, three faces (owb- order workflow, research R-base D; design plan § 5zk C, § 5zl; prototype core.js whoFace
 * and P_WHAT). The log is the AuditLog rows of one order's records (the order, its lines, its request, its shipments, its
 * files); this file says WHO each reader sees on a row and WHICH rows a customer may read. Pure: the API reads the rows (in
 * the tenant's scope, for ONE record, after the brand wall) and the names, and passes them in; the builder
 * (./build, owb-b3) makes the answer.
 *
 *   office  a person by name: an office user, a customer's person; a floor worker by name only where the site's PERFORMANCE
 *           gate is open (apps/factory-api people/privacy/worker-gate — its rule is pure already: the API passes its `open`
 *           here as `workerNamesOpen`), else the DEPARTMENT the work was done in, never the worker
 *   portal  "The factory" for ANY factory person (office or floor), never a name; the customer's own colleague by name; and
 *           only the rows of the ALLOW-list below — never a hide-list: a new kind of row stays hidden until it is put here
 *   floor   "You" for the device's own worker, "Office" for the office (and the customer: the floor never reads a customer's
 *           name), the DEPARTMENT for another worker — never a colleague's name on the floor
 *   SYSTEM  a row the system wrote (a scheduler, a rule), in every door
 */

/** Who wrote an audit row (AuditLog.audience). */
export const LOG_AUDIENCES = ['OFFICE', 'FLOOR', 'PARTNER', 'LINK', 'SYSTEM'] as const
export type LogAudience = (typeof LOG_AUDIENCES)[number]

/** The three doors that read the log. */
export const LOG_DOORS = ['office', 'portal', 'floor'] as const
export type LogDoor = (typeof LOG_DOORS)[number]

export const WHO_FACES = ['PERSON', 'THE_FACTORY', 'YOU', 'OFFICE', 'DEPARTMENT', 'SYSTEM'] as const
export type WhoFace = (typeof WHO_FACES)[number]

/** The `who` of a log row (OrderLogRow.who). */
export interface WhoOfRow {
  readonly face: WhoFace
  /** A name only on PERSON; null on every other face. */
  readonly name: string | null
  /** The department's number on DEPARTMENT (when known); else null. */
  readonly departmentNo: number | null
}

/** What the face rule reads of a row, as the API looked it up. */
export interface LogActorRow {
  readonly audience: LogAudience
  readonly actorId: string
  /**
   * The actor's name: an office user's, a customer person's (a partner or link session), a worker's. The rule decides whether
   * it is shown; the API may leave a worker's name null where the gate is closed (worker-gate `lookup` returns no id then).
   */
  readonly actorName: string | null
  /** PARTNER and LINK rows: the party of the person who wrote it. */
  readonly actorPartyId?: string | null
  /** FLOOR rows: the department of the station the work was done at, when known. */
  readonly departmentNo?: number | null
}

/** The reader's side of the rule. */
export interface FaceGate {
  /** office: the site's PERFORMANCE gate is open (people/privacy worker-gate `open`): a worker may be named. */
  readonly workerNamesOpen: boolean
  /** portal: the reader's party (its own colleagues show by name). */
  readonly viewerPartyId?: string | null
  /** floor: the device's signed-in worker ("You"). */
  readonly viewerWorkerId?: string | null
}

const face = (kind: WhoFace, name: string | null = null, departmentNo: number | null = null): WhoOfRow => ({ face: kind, name: kind === 'PERSON' ? name : null, departmentNo: kind === 'DEPARTMENT' ? departmentNo : null })

/** Who a reader of `door` sees on one row. */
export function whoFaceOf(row: LogActorRow, door: LogDoor, gate: FaceGate): WhoOfRow {
  if (row.audience === 'SYSTEM') return face('SYSTEM')
  const department = row.departmentNo ?? null
  switch (door) {
    case 'office':
      if (row.audience === 'FLOOR') return gate.workerNamesOpen && row.actorName ? face('PERSON', row.actorName) : face('DEPARTMENT', null, department)
      return face('PERSON', row.actorName)
    case 'portal': {
      const ownParty = (row.audience === 'PARTNER' || row.audience === 'LINK') && !!gate.viewerPartyId && row.actorPartyId === gate.viewerPartyId
      return ownParty ? face('PERSON', row.actorName) : face('THE_FACTORY')
    }
    case 'floor':
      if (row.audience === 'FLOOR') return gate.viewerWorkerId && row.actorId === gate.viewerWorkerId ? face('YOU') : face('DEPARTMENT', null, department)
      return face('OFFICE')
  }
}

/**
 * The floor's face of many rows at once (owb- S5's basket read calls it: `floorFaceOf(rows, gate)`): "You", "Office" or the
 * department, never a name.
 */
export function floorFaceOf(rows: readonly LogActorRow[], gate: Pick<FaceGate, 'viewerWorkerId'>): WhoOfRow[] {
  return rows.map((row) => whoFaceOf(row, 'floor', { workerNamesOpen: false, viewerWorkerId: gate.viewerWorkerId ?? null }))
}

// ---- the actions: one word and one icon each ----------------------------------------------------------------------------------

/**
 * The audit actions of the warehouse leg (S3 ss1), "Take it back" (S1 po1.2) and the picture (owb-b3): the base names them
 * here so the allow-list and the faces hold them before their commands land. A command writes its audit row with these names
 * (`tools.audit({ action: … })`, or its command name equal to it).
 */
export const PICTURE_SET_ACTION = 'orders.picture.set'
export const TAKE_BACK_ACTION = 'portalOrdering.takeBack'
export const LEG_ARRIVED_ACTION = 'shipping.warehouseLeg.arrived'
export const LEG_FORWARDED_ACTION = 'shipping.warehouseLeg.forwarded'
export const LEG_LABEL_ACTION = 'shipping.warehouseLeg.label'

/** The words of the log (factory-web lib/change-log: `action.<KEY>` in its catalogue, EN + IT). */
export const ORDER_LOG_ACTIONS = [
  'DRAFT_STARTED',
  'DRAFT_CHANGED',
  'LINES_ADDED',
  'LINE_CHANGED',
  'LINE_TAKEN_OUT',
  'PEOPLE_CHANGED',
  'PRICES_TAKEN',
  'FILE_ADDED',
  'ARTWORK_SHARED',
  'SENT',
  'TAKEN_BACK',
  'WITHDRAWN',
  'REFUSED',
  'CONFIRMED',
  'PROMISE_MOVED',
  'PICTURE_SET',
  'DELIVER_TO',
  'CHANGE_ACCEPTED',
  'READY',
  'CANCELLED',
  'CLOSED',
  'SHIPPED',
  'AT_OUR_WAREHOUSE',
  'LABEL_RECEIVED',
  'SENT_ON',
  'DELIVERED',
  // owb-b7 (S2 ask 09:18, S5 ask 09:28; the base's allow-list): OFFICE words only — none of their actions is on the customer's
  // ALLOW-list below (the customer never reads the floor restriction, who answered a notice, a download, who was given the order,
  // a basket's move or a route change).
  'RESTRICTION_CHANGED',
  'NOTICE_ANSWERED',
  'FILES_DOWNLOADED',
  'DESIGNER_GIVEN',
  'CHANGED_ON_FLOOR',
  'OTHER',
] as const
export type OrderLogAction = (typeof ORDER_LOG_ACTIONS)[number]

export interface ActionFace {
  readonly key: OrderLogAction
  /** ONE lucide icon (kebab-case id; design § 5zl "one icon per kind of change"). */
  readonly icon: string
}

/** The face of an action key: its icon. */
export const ACTION_ICONS: Readonly<Record<OrderLogAction, string>> = Object.freeze({
  DRAFT_STARTED: 'file-plus',
  DRAFT_CHANGED: 'pencil',
  LINES_ADDED: 'list-plus',
  LINE_CHANGED: 'pencil-line',
  LINE_TAKEN_OUT: 'list-minus',
  PEOPLE_CHANGED: 'users',
  PRICES_TAKEN: 'tag',
  FILE_ADDED: 'paperclip',
  ARTWORK_SHARED: 'palette',
  SENT: 'send',
  TAKEN_BACK: 'rotate-ccw',
  WITHDRAWN: 'undo-2',
  REFUSED: 'circle-x',
  CONFIRMED: 'circle-check',
  PROMISE_MOVED: 'calendar-clock',
  PICTURE_SET: 'image',
  DELIVER_TO: 'map-pin',
  CHANGE_ACCEPTED: 'git-pull-request',
  READY: 'package-check',
  CANCELLED: 'ban',
  CLOSED: 'archive',
  SHIPPED: 'truck',
  AT_OUR_WAREHOUSE: 'warehouse',
  LABEL_RECEIVED: 'file-text',
  SENT_ON: 'forward',
  DELIVERED: 'check-check',
  RESTRICTION_CHANGED: 'lock',
  NOTICE_ANSWERED: 'hand-coins',
  FILES_DOWNLOADED: 'download',
  DESIGNER_GIVEN: 'user-plus',
  CHANGED_ON_FLOOR: 'factory',
  OTHER: 'history',
})

/** The audit action → its word key. An action not here reads as OTHER (office only: OTHER is never on the allow-list). */
const ACTION_KEYS: Readonly<Record<string, OrderLogAction>> = Object.freeze({
  'portalOrdering.createDraft': 'DRAFT_STARTED',
  'portalOrdering.changeDraft': 'DRAFT_CHANGED',
  'portalOrdering.addLines': 'LINES_ADDED',
  'portalOrdering.addCustomLine': 'LINES_ADDED',
  'portalOrdering.reorder': 'LINES_ADDED',
  'portalOrdering.changeLine': 'LINE_CHANGED',
  'portalOrdering.changeCustomLine': 'LINE_CHANGED',
  'portalOrdering.removeLine': 'LINE_TAKEN_OUT',
  'portalOrdering.addPeople': 'PEOPLE_CHANGED',
  'portalOrdering.changePerson': 'PEOPLE_CHANGED',
  'portalOrdering.removePerson': 'PEOPLE_CHANGED',
  'portalOrdering.takePrices': 'PRICES_TAKEN',
  'portalOrdering.upload': 'FILE_ADDED',
  'files.completeUpload': 'FILE_ADDED',
  'orders.shareArtwork': 'ARTWORK_SHARED',
  'portalOrdering.send': 'SENT',
  [TAKE_BACK_ACTION]: 'TAKEN_BACK',
  'portalOrdering.withdraw': 'WITHDRAWN',
  'portalOrdering.refuse': 'REFUSED',
  'portalOrdering.accept': 'CONFIRMED',
  'portalOrdering.confirm': 'CONFIRMED',
  'orders.make': 'CONFIRMED',
  'orders.makeManual': 'CONFIRMED',
  'orders.approvalYes': 'CONFIRMED',
  'orders.changePromise': 'PROMISE_MOVED',
  [PICTURE_SET_ACTION]: 'PICTURE_SET',
  'orders.changeShipTo': 'DELIVER_TO',
  'orders.changeRequestAccepted': 'CHANGE_ACCEPTED',
  'orders.markReady': 'READY',
  'orders.cancel': 'CANCELLED',
  'orders.close': 'CLOSED',
  'shipping.ship': 'SHIPPED',
  'shipping.left': 'SHIPPED',
  [LEG_ARRIVED_ACTION]: 'AT_OUR_WAREHOUSE',
  [LEG_LABEL_ACTION]: 'LABEL_RECEIVED',
  [LEG_FORWARDED_ACTION]: 'SENT_ON',
  'shipping.recordPod': 'DELIVERED',
  'shipping.carrierPod': 'DELIVERED',
  'shipping.collectionDelivered': 'DELIVERED',
  // ---- owb-b7: office rows only (never CUSTOMER_ALLOWED_ACTIONS) ----
  // S2 owb-of1 (ask 09:18): Restrict on the floor or open it again (before/after floorRestricted); a customer's "I paid" notice
  // answered (after { noticeId, state }); Download all (after { files, leftOut }); the order given to the designer (after { userId, added }).
  'orders.restrict': 'RESTRICTION_CHANGED',
  'orders.paymentNotice.answer': 'NOTICE_ANSWERED',
  'orders.files.zip': 'FILES_DOWNLOADED',
  'orders.designer.give': 'DESIGNER_GIVEN',
  // S5 owb-fl2 (ask 09:28): a basket moved on the floor, the move taken back, its route changed, its route set back to normal —
  // ONE office word "Changed on the floor" (_owb-fl-common § 4).
  'production.baskets.move': 'CHANGED_ON_FLOOR',
  'production.baskets.moveUndo': 'CHANGED_ON_FLOOR',
  'production.baskets.route': 'CHANGED_ON_FLOOR',
  'production.baskets.routeNormal': 'CHANGED_ON_FLOOR',
  // ---- end owb-b7 ----
})

/** The per-action map: an audit action → its word key and ONE lucide icon. */
export function actionFaceOf(action: string): ActionFace {
  const key = ACTION_KEYS[action] ?? 'OTHER'
  return { key, icon: ACTION_ICONS[key] }
}

/** Every audit action the log names, with its face (the web's word check reads it). */
export const ACTION_FACES: Readonly<Record<string, ActionFace>> = Object.freeze(Object.fromEntries(Object.entries(ACTION_KEYS).map(([action, key]) => [action, { key, icon: ACTION_ICONS[key] }])))

// ---- the customer's ALLOW-list ----------------------------------------------------------------------------------------------

/**
 * The audit actions a customer may read in the order's log — an ALLOW-list, never a hide-list (prototype P_WHAT, round 36
 * finding A3-08): the life of the order (sent, taken back, withdrawn or refused, confirmed, ready, cancelled), promise date
 * moves, where it is delivered, a change the factory accepted, the picture, artwork the factory shared, the shipments (shipped,
 * at the factory's warehouse, the label, sent on, delivered), the customer's own files. Never: a hold or its reason, Rush, a
 * cost, a price, a team, a worker, a basket's move, a floor step, a route change, an office note, a credit or approval step.
 * S2 owns this list after the base: a new kind of row reaches a customer only when it is added here (S1 and S4 ask).
 */
export const CUSTOMER_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  'portalOrdering.createDraft',
  'portalOrdering.changeDraft',
  'portalOrdering.addLines',
  'portalOrdering.addCustomLine',
  'portalOrdering.reorder',
  'portalOrdering.changeLine',
  'portalOrdering.changeCustomLine',
  'portalOrdering.removeLine',
  'portalOrdering.upload',
  'portalOrdering.send',
  TAKE_BACK_ACTION,
  'portalOrdering.withdraw',
  'portalOrdering.refuse',
  'portalOrdering.accept',
  'portalOrdering.confirm',
  'orders.make',
  'orders.makeManual',
  'orders.approvalYes',
  'orders.changePromise',
  PICTURE_SET_ACTION,
  'orders.changeShipTo',
  'orders.changeRequestAccepted',
  'orders.shareArtwork',
  'orders.markReady',
  'orders.cancel',
  'shipping.ship',
  'shipping.left',
  LEG_ARRIVED_ACTION,
  LEG_LABEL_ACTION,
  LEG_FORWARDED_ACTION,
  'shipping.recordPod',
  'shipping.carrierPod',
  'shipping.collectionDelivered',
])

/**
 * The allowed actions a customer reads only when its OWN people wrote the row ("lines added or taken out by the customer"; the
 * draft's header; its own uploads): the same action by the factory stays inside.
 */
export const CUSTOMER_OWN_ROWS_ONLY: ReadonlySet<string> = new Set([
  'portalOrdering.createDraft',
  'portalOrdering.changeDraft',
  'portalOrdering.addLines',
  'portalOrdering.addCustomLine',
  'portalOrdering.reorder',
  'portalOrdering.changeLine',
  'portalOrdering.changeCustomLine',
  'portalOrdering.removeLine',
  'portalOrdering.upload',
])

/** A customer (the reader's party) may read this row: its action is allowed, and an own-rows-only action was written by its own people. */
export function customerMayRead(row: Pick<LogActorRow, 'audience' | 'actorPartyId'> & { readonly action: string }, viewerPartyId: string): boolean {
  if (!CUSTOMER_ALLOWED_ACTIONS.has(row.action)) return false
  if (!CUSTOMER_OWN_ROWS_ONLY.has(row.action)) return true
  return (row.audience === 'PARTNER' || row.audience === 'LINK') && row.actorPartyId === viewerPartyId
}
