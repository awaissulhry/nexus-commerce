import type { CustomLineFields, CustomLineKind, DraftFile, DraftFileAnnounce, DraftRecord, HeaderBody, PersonFields, SizeAsk } from './schema'

/**
 * The ONE draft order's commands (THE SIMPLE ORDER START, od-w1.1): each host gives them through this port — the portal on
 * `/portal/order-requests/:id/…` (its session's party), the office on `/sales/order-requests/:id/…` (the draft's own customer, after
 * its right). Same bodies, same answers (the draft's record), the same draft commands behind both doors (13-backend § 2, § 4). The
 * shared part never fetches (no `lib/api` in a view): the host's container calls the port and hands the views their model. Every
 * write carries the DRAFT's version and an Idempotency-Key; a body names no party and no company.
 */

/** A catalogue line's change: its sizes, its colour, its note. */
export interface LineChange {
  version: number
  sizes?: SizeAsk[]
  colourwayId?: string
  note?: string | null
}

/** Where a file's bytes go once it is announced (a presigned PUT). */
export interface DraftFileTicket {
  file: DraftFile
  upload: { method: 'PUT' | 'GET'; url: string; headers: Record<string, string>; expiresAt: string }
}

export interface OrderDraftPort {
  read(id: string, signal?: AbortSignal): Promise<DraftRecord>
  header(id: string, body: { version: number } & HeaderBody, idempotencyKey: string): Promise<DraftRecord>
  changeLine(id: string, lineId: string, body: LineChange, idempotencyKey: string): Promise<DraftRecord>
  /** A line of any kind out (its people with it). */
  removeLine(id: string, lineId: string, version: number, idempotencyKey: string): Promise<DraftRecord>
  addCustomLine(id: string, body: { version: number; line: { kind: CustomLineKind } & CustomLineFields }, idempotencyKey: string): Promise<DraftRecord>
  changeCustomLine(id: string, lineId: string, body: { version: number } & CustomLineFields, idempotencyKey: string): Promise<DraftRecord>
  addPeople(id: string, lineId: string, body: { version: number; people: PersonFields[] }, idempotencyKey: string): Promise<DraftRecord>
  changePerson(id: string, lineId: string, personId: string, body: { version: number } & Partial<PersonFields>, idempotencyKey: string): Promise<DraftRecord>
  removePerson(id: string, lineId: string, personId: string, version: number, idempotencyKey: string): Promise<DraftRecord>
  announceFile(id: string, body: DraftFileAnnounce, idempotencyKey: string): Promise<DraftFileTicket>
  completeFile(id: string, fileId: string, idempotencyKey: string): Promise<DraftFile>
  /** The FILE's version; the draft as read comes back. */
  removeFile(id: string, fileId: string, version: number, idempotencyKey: string): Promise<DraftRecord>
}
