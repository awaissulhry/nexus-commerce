import { EMPTY_COMPOSE, typedIn, type ComposeDraft, type KeptCompose } from './model'

/**
 * B-TH-287 (threads plan TH-9, N6 = L2-G14; P-CUS-NEW.message-F02 "Draft saves itself", P-HOME.actions-F02; wall W08, W37): the portal's
 * New order kept ON THE SERVER — one draft per person (apps/factory-api platform/threads/drafts.ts, `GET|PUT|DELETE
 * /portal/drafts/new-request`), so the person finds what they typed on another computer ("Draft saved 10:42"). The pure part: the
 * draft as the API keeps it (the message as its words, the other fields beside it), which copy wins on arrival (the server's or this
 * device's), the line under the message, and the saver — a pause in typing saves, leaving saves, a send or a discard never lets a
 * late save bring the words back. No React, no API client.
 *
 * Brand wall (W08, W37): the draft is the writer's own. The body names no person, no party and no company — the API takes the person
 * (and so their customer) from the session; a preview of the portal by the office saves nothing.
 */

/** A pause in typing this long saves the draft on the server (the device copy is written sooner, ~0.6 s). */
export const SERVER_SAVE_MS = 2000

/** The draft as the API answers it (platform/threads contract `draftView`, the fields this compose reads). */
export interface ServerDraftView {
  readonly body: string
  readonly fields: Readonly<Record<string, unknown>>
  readonly savedAt: string
  readonly version: number
}

/** The draft on the server as the compose reads it: what was typed, when it was saved (ms), its version. */
export interface ServerDraft {
  readonly draft: ComposeDraft
  readonly savedAt: number
  readonly version: number
}

/** The body of `PUT /portal/drafts/new-request`: no audience (a New order is no reply), the message, the other fields, the version read. */
export interface ServerDraftBody {
  readonly audience: null
  readonly body: string
  readonly fields: { readonly subject: string; readonly customerRef: string; readonly wantedDate: string; readonly shipToAddressId: string }
  readonly version?: number
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The server's draft as a compose draft (the message is its words; a day not written as YYYY-MM-DD is dropped), or null when empty. */
export function fromServerDraft(view: ServerDraftView | null | undefined): ServerDraft | null {
  if (!view) return null
  const savedAt = Date.parse(view.savedAt)
  const wanted = text(view.fields.wantedDate)
  const draft: ComposeDraft = {
    subject: text(view.fields.subject),
    message: text(view.body),
    customerRef: text(view.fields.customerRef),
    wantedDate: /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : '',
    shipToAddressId: text(view.fields.shipToAddressId),
  }
  return typedIn(draft) && Number.isFinite(savedAt) ? { draft, savedAt, version: view.version } : null
}

/** What goes to the server: the typed fields only — never a person, a party or a company (the API takes them from the session). */
export function serverDraftBody(draft: ComposeDraft, version: number | null): ServerDraftBody {
  return {
    audience: null,
    body: draft.message,
    fields: { subject: draft.subject, customerRef: draft.customerRef, wantedDate: draft.wantedDate, shipToAddressId: draft.shipToAddressId },
    ...(version !== null ? { version } : {}),
  }
}

/**
 * Which copy the page opens with: the newer of the server's and this device's (the same moment: the server's). A device copy that was
 * already saved on the server (`onServer`) while the server — read without a fault — keeps none was sent or discarded elsewhere: it is
 * dropped (`forget`), so a request sent from another computer never comes back here.
 */
export function newerDraft(server: ServerDraft | null, device: KeptCompose | null, serverRead: boolean): { readonly source: 'server' | 'device'; readonly draft: ComposeDraft; readonly savedAt: number; readonly forget: boolean } | null {
  if (device && serverRead && !server && device.onServer) return { source: 'device', draft: EMPTY_COMPOSE, savedAt: device.savedAt, forget: true }
  if (server && (!device || server.savedAt >= device.savedAt)) return { source: 'server', draft: server.draft, savedAt: server.savedAt, forget: false }
  if (device) return { source: 'device', draft: device.draft, savedAt: device.savedAt, forget: false }
  return null
}

/** The device's own line (unchanged from B-TH-220): kept (when), the device refused it, nothing kept yet. */
export type DeviceKept = { readonly state: 'kept'; readonly at: string } | { readonly state: 'failed' } | { readonly state: 'none' }

/** What the server did with the draft, as the line under the message says it. */
export type ServerSave = { readonly state: 'idle' } | { readonly state: 'saved'; readonly at: number; readonly replaced: boolean } | { readonly state: 'failed' }

/**
 * The line under the message (the view's `kept`): offline is the view's own line; then the server — "Draft saved 10:42" (with "a
 * newer draft … was replaced" when another tab or computer had saved after this one read), or "Not saved · Retry" (saying when the
 * text still stays on this device) — and without the server (a preview, nothing saved yet) the device's own line as before.
 */
export function keptLineOf(
  server: ServerSave,
  device: DeviceKept,
  time: (ms: number) => string,
): { state: 'kept'; at: string } | { state: 'failed' } | { state: 'none' } | { state: 'saved'; at: string; replaced: boolean } | { state: 'notSaved'; device: boolean } {
  if (server.state === 'saved') return { state: 'saved', at: time(server.at), replaced: server.replaced }
  if (server.state === 'failed') return { state: 'notSaved', device: device.state === 'kept' }
  return device
}

/** What the saver does with the outside world (the page gives the API calls and what it draws). */
export interface DraftSaverIo {
  /** The server may be asked now (a buyer, not a preview, online). */
  readonly enabled: () => boolean
  readonly save: (body: ServerDraftBody) => Promise<{ readonly savedAt: string; readonly version: number; readonly replacedNewer: boolean }>
  readonly discard: () => Promise<void>
  readonly onSaved: (saved: { readonly savedAt: number; readonly version: number; readonly replacedNewer: boolean; readonly draft: ComposeDraft; readonly typedSince: boolean }) => void
  readonly onFailed: () => void
  readonly onDiscarded?: () => void
  readonly setTimer?: (run: () => void, ms: number) => unknown
  readonly clearTimer?: (id: unknown) => void
}

export interface DraftSaver {
  /** The version the server holds (read on arrival), or null: none. */
  known: (version: number | null) => void
  /** The person typed: the draft is saved after a pause. */
  typed: (draft: ComposeDraft) => void
  /** Save what waits now (leaving the page, Retry, back online). */
  flush: () => void
  /** A send starts: no save goes meanwhile; a save already on its way is remembered. */
  sending: () => void
  /** The send failed: what was typed waits to be saved again. */
  sendFailed: () => void
  /** The send went (the API cleared the draft in its own command): a save that was on its way is taken back by a DELETE. */
  sent: () => void
  /** Discard draft: the server's copy goes (and a save on its way is taken back after it lands). */
  discarded: () => void
  /** The page goes: no timer is left behind (`flush` first to save what waits). */
  stop: () => void
}

/**
 * The saver: ONE save at a time on the server, the newest typed draft after a pause, the version last read sent with it ("newest wins":
 * the answer says when another tab's newer draft was replaced). An empty draft is a DELETE (when the server holds one). A send or a
 * discard cancels the waiting save; a save that was on its way when the send started — it might land after the send's own clearing —
 * is followed by a DELETE once it lands, so the words never come back.
 */
export function draftSaver(io: DraftSaverIo, waitMs = SERVER_SAVE_MS): DraftSaver {
  const setTimer = io.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
  const clearTimer = io.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let version: number | null = null
  let timer: unknown = null
  let pending: ComposeDraft | null = null
  let flying = 0
  /** A send or a discard happened while a save was on its way (or the send started with one on its way): DELETE when it lands. */
  let takeBack = false
  /** The send has started: nothing is saved until it went or failed. */
  let holding = false
  let flyingAtSend = false

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const removeOnServer = () => {
    version = null
    io.discard().then(
      () => io.onDiscarded?.(),
      () => undefined,
    )
  }
  const landed = () => {
    flying -= 1
    if (flying === 0 && takeBack) {
      takeBack = false
      removeOnServer()
      return true
    }
    return takeBack
  }
  const go = () => {
    stopTimer()
    if (holding || pending === null || !io.enabled()) return
    const draft = pending
    pending = null
    if (!typedIn(draft)) {
      if (version !== null) removeOnServer()
      return
    }
    flying += 1
    io.save(serverDraftBody(draft, version)).then(
      (answer) => {
        if (landed()) return
        version = answer.version
        io.onSaved({ savedAt: Date.parse(answer.savedAt), version: answer.version, replacedNewer: answer.replacedNewer, draft, typedSince: pending !== null })
        // Typed again while it was on its way: that one goes next.
        if (pending !== null && timer === null) timer = setTimer(go, waitMs)
      },
      () => {
        if (landed()) return
        // Not saved: the words wait for the next pause, Retry or the way back online.
        pending ??= draft
        io.onFailed()
      },
    )
  }

  return {
    known: (read) => {
      version = read
    },
    typed: (draft) => {
      pending = draft
      stopTimer()
      if (!holding) timer = setTimer(go, waitMs)
    },
    flush: go,
    sending: () => {
      stopTimer()
      holding = true
      flyingAtSend = flying > 0
    },
    sendFailed: () => {
      holding = false
      flyingAtSend = false
      if (pending !== null) timer = setTimer(go, waitMs)
    },
    sent: () => {
      stopTimer()
      holding = false
      pending = null
      if (flying > 0) takeBack = true
      else if (flyingAtSend) removeOnServer()
      else version = null
      flyingAtSend = false
    },
    discarded: () => {
      stopTimer()
      pending = null
      if (flying > 0) takeBack = true
      removeOnServer()
    },
    stop: stopTimer,
  }
}
