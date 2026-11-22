'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { useLocale } from '../../../lib/i18n/provider'
import type { FileAsk, OrderFilesRead, UploadPlace } from '../../../lib/record-thread/files-view/model'
import type { FileKind } from '../../../record-panels/model'
import { listFiles } from '../../../record-panels/api'
import {
  askBody,
  askRefusalOf,
  dayAfter,
  newAskDraft,
  windowBody,
  windowHeld,
  withWho,
  type AskAbilities,
  type AskChoices,
  type AskDoor,
  type AskList,
  type AsksState,
  type AskWindow,
} from '../../../lib/record-thread/files-view/asks/asks'
import { askCustomerForFile, askError, changeFileAsk, fileAskAct, makeFileAsk, notForThisReader, readAskChoices, type AskChoicesRead } from './file-asks-api'
import { shareWithParty } from './api'

/**
 * F-OF-201 … F-OF-203 (order FILES tab W2; 13-backend B-OF-031…033) — the container of "Waiting for files": the window open on the band
 * (Ask for a file… · Accept · Ask again · Ask for an update · Reassign · Change · Cancel), the pickers it reads, the commands it sends
 * (each at the ask's version; a refusal said in words in the window), and the doors that lead elsewhere — "Upload for this ask" opens the
 * ONE upload window prefilled (use-file-upload) and answers the ask with its files; "Open what arrived" shows the first file in the ONE
 * viewer; Accept's "Share with <customer>" is the file's own visibility command (files.manage). After each act the order's files read is
 * read again (its `asks`). The order's container (use-order-files) mounts it: the tab and the order's thread window get the same.
 */

const READING = { state: 'reading', items: [] } as const
const HIDDEN = { state: 'hidden', items: [] } as const
type Named = { readonly id: string; readonly name: string }
type Step = { readonly id: string; readonly seq: number; readonly name: string }

export function useFileAsks(
  api: ApiClient,
  input: {
    readonly orderId: string | null
    readonly read: OrderFilesRead | null
    readonly partyId: string | null
    readonly companyId: string | null
    readonly lines: AskChoices['lines']
    readonly workOrders: AskChoices['workOrders']
    readonly can: AskAbilities
    readonly today: string
    readonly focus?: string | null
    readonly reload: () => void
    /** The ONE upload window, prefilled for an ask (use-file-upload `openForAsk`). */
    readonly openForAsk: (input: { readonly place: UploadPlace; readonly kind: FileKind; readonly sheet: boolean; readonly priced: boolean; readonly forAsk: { readonly id: string; readonly words: string | null; readonly by: string; readonly dueOn: string; readonly target: string } }) => void
    /** The ONE viewer at a file of the order (it shows only what the read lists). */
    readonly openFile: (fileId: string) => void
  },
) {
  const locale = useLocale() // S2 (#1881): the server's refusal words in the reader's language
  const [window, setWindow] = useState<AskWindow | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<AsksState['problem']>(null)
  const [notice, setNotice] = useState<AsksState['notice']>(null)
  // S3 (#1884, B-OF-035): the pickers come from ONE walled read of the order's choices (people, roles, teams, work orders and their steps).
  const [picked, setPicked] = useState<{ readonly state: 'reading' | 'failed' | 'hidden' } | { readonly state: 'ready'; readonly read: AskChoicesRead } | null>(null)
  const latest = useRef(input)
  latest.current = input
  const askOf = (askId: string): FileAsk | null => latest.current.read?.asks?.find((one) => one.id === askId) ?? null

  // ---- the pickers: read when a window that picks opens (once a page; a refused read hides its kind) ----
  const picks = window?.kind === 'ask' || window?.kind === 'reassign'
  const orderId = input.orderId
  const loadPicks = useCallback(() => {
    if (!orderId) return
    setPicked({ state: 'reading' })
    readAskChoices(api, orderId)
      .then((read) => setPicked({ state: 'ready', read }))
      .catch((error: unknown) => setPicked({ state: notForThisReader(error) ? 'hidden' : 'failed' }))
  }, [api, orderId])
  useEffect(() => {
    if (picks && picked === null) loadPicks()
  }, [picks, picked, loadPicks])

  // The work order picked (the ask's draft, or the floor ask being reassigned): its steps and its site's teams.
  const reassigned = window?.kind === 'reassign' ? askOf(window.askId) : null
  const workOrderId = window?.kind === 'ask' ? window.draft.workOrderId : reassigned?.lands.type === 'WorkOrder' ? reassigned.lands.id : null
  const read = picked?.state === 'ready' ? picked.read : null
  // The work orders the reader reaches (the choices' own, with their steps), else the order's live ones until the read is there.
  // fx5w (W-04): with each one's status when the read gives it — the window offers a floor ask only the ones the floor works now (asks.ts).
  const workOrders = read ? read.workOrders.map((one) => ({ id: one.id, number: one.number, siteId: one.siteId, ...(one.status ? { status: one.status } : {}) })) : input.workOrders
  const choiceWorkOrders = useRef(workOrders)
  choiceWorkOrders.current = workOrders
  const siteId = workOrderId ? (workOrders.find((one) => one.id === workOrderId)?.siteId ?? null) : null
  const list = <T,>(items: (choices: AskChoicesRead) => readonly T[]): AskList<T> => (read ? { state: 'ready', items: items(read) } : picked?.state === 'hidden' ? HIDDEN : picked?.state === 'failed' ? { state: 'failed', items: [] } : READING)
  const choices: AskChoices = {
    people: list((one) => one.people.map((person): Named => ({ id: person.id, name: person.name }))),
    officeRoles: list((one) => one.officeRoles.map((role) => ({ id: role.id, name: role.name, ...(role.reach !== undefined ? { reach: role.reach } : {}) }))), // fx5w (W-08): its reach
    // A floor role or team: of the plant of the work order picked (a floor ask lands on one); before a pick, every plant's.
    floorRoles: list((one) => one.floorRoles.filter((role) => !siteId || role.siteIds.includes(siteId)).map((role): Named => ({ id: role.id, name: role.name }))),
    teams: siteId ? list((one) => one.teams.filter((team) => team.siteId === siteId).map((team): Named => ({ id: team.id, name: team.name }))) : { state: 'ready', items: [] },
    steps: workOrderId ? list((one) => (one.workOrders.find((order) => order.id === workOrderId)?.steps ?? []).map((step): Step => ({ id: step.id, seq: step.seq, name: step.name }))) : { state: 'ready', items: [] },
    lines: input.lines,
    workOrders,
    truncated: read?.truncated ?? false,
  }

  const open = (next: AskWindow | null) => {
    setProblem(null)
    setNotice(null)
    setWindow(next)
  }

  /** A command's refusal, in words, in the window; the read is read again (the ask may have moved meanwhile). */
  const refused = (error: unknown) => {
    setProblem(askRefusalOf(askError(error), locale))
    latest.current.reload()
  }

  const submit = async () => {
    const asked = window
    const { orderId: id, partyId, companyId } = latest.current
    if (!asked || !id || busy) return
    const ask = asked.kind === 'ask' ? null : askOf(asked.askId)
    if (asked.kind !== 'ask' && !ask) return open(null)
    if (windowHeld(asked, ask)) return
    setBusy(true)
    setProblem(null)
    try {
      if (asked.kind === 'ask') {
        const draft = asked.draft
        if (draft.who === 'CUSTOMER') {
          if (!partyId) return
          await askCustomerForFile(api, { partyId, orderId: id, companyId, dueOn: draft.dueOn || null })
        } else await makeFileAsk(api, id, askBody({ ...draft, who: draft.who }))
      } else if (ask) {
        if (asked.kind === 'change') await changeFileAsk(api, id, ask.id, windowBody(asked, ask))
        else await fileAskAct(api, id, ask.id, asked.kind === 'again' ? 'ask-again' : asked.kind, windowBody(asked, ask))
        // Accept's "Share with <customer>": each file's own visibility command, at its version (files.manage; the customer of THIS order).
        if (asked.kind === 'accept' && asked.share && partyId && ask.answered) {
          try {
            const { files } = await listFiles(api, { type: ask.lands.type, id: ask.lands.id })
            for (const fileId of ask.answered.fileIds) {
              const now = files.find((file) => file.id === fileId)
              if (now) await shareWithParty(api, now, partyId)
            }
          } catch {
            setNotice({ key: 'accept.shareFailed' })
          }
        }
      }
      setWindow(null)
      latest.current.reload()
    } catch (error) {
      refused(error)
    } finally {
      setBusy(false)
    }
  }

  /** A row's door: a window, the upload for the ask, the viewer on what arrived, a link. */
  const door = (askId: string, which: AskDoor) => {
    const ask = askOf(askId)
    if (!ask) return
    const today = latest.current.today
    switch (which) {
      case 'accept':
        return open({ kind: 'accept', askId, share: false })
      case 'again':
        return open({ kind: 'again', askId, reason: '', dueOn: ask.dueOn })
      case 'chase':
        return open({ kind: 'chase', askId })
      case 'change':
        return open({ kind: 'change', askId, words: ask.words ?? '', dueOn: ask.dueOn || dayAfter(today, 3) })
      case 'reassign':
        return open({ kind: 'reassign', askId, who: ask.who.kind, pick: null, reason: '' })
      case 'cancel':
        return open({ kind: 'cancel', askId, reason: '' })
      case 'upload':
      case 'uploadFor': {
        const step = ask.lands.step
        const target = step ? `${ask.lands.label} · ${step.seq} · ${step.name}` : ask.lands.label
        const kind: UploadPlace['kind'] = ask.lands.type === 'SalesOrder' ? 'order' : ask.lands.type === 'SalesOrderLine' ? 'line' : 'workOrder'
        latest.current.openForAsk({
          place: { key: `ask:${ask.id}`, record: { type: ask.lands.type, id: ask.lands.id }, kind, what: ask.lands.label, audiences: ['OFFICE'] },
          kind: (['DOCUMENT', 'PHOTO', 'ATTACHMENT'].includes(ask.fileKind) ? ask.fileKind : 'ATTACHMENT') as FileKind,
          sheet: ask.bodyData,
          priced: ask.priced,
          forAsk: { id: ask.id, words: ask.words, by: ask.askedBy.name, dueOn: ask.dueOn, target },
        })
        return
      }
      case 'check': {
        const first = ask.answered?.fileIds[0]
        if (first) latest.current.openFile(first)
        return
      }
      case 'copyLink': {
        if (typeof globalThis.window === 'undefined') return
        const { origin, pathname, search } = globalThis.window.location
        const params = new URLSearchParams(search)
        params.set('tab', 'files')
        params.set('ask', askId)
        void navigator.clipboard?.writeText(`${origin}${pathname}?${params.toString()}#asks`).catch(() => undefined)
        return
      }
    }
  }

  /** "Upload for this ask": once its files are in, the ask is answered with them (at its version); a refusal is said on the band. */
  const answer = async (askId: string, fileIds: readonly string[]) => {
    const ask = askOf(askId)
    const id = latest.current.orderId
    if (!ask || !id || fileIds.length === 0) return
    try {
      await fileAskAct(api, id, askId, 'answer', { version: ask.version, fileIds: [...fileIds] })
      setNotice(null)
    } catch (error) {
      setNotice(askRefusalOf(askError(error), locale))
    } finally {
      latest.current.reload()
    }
  }

  const state: AsksState = { can: input.can, window, choices, busy, problem, notice, focus: input.focus ?? null, today: input.today }
  return {
    state,
    answer,
    actions: {
      /** "Ask for a file…": a new draft (a document, a person, the order, due in three days). */
      onAskNew: () => open({ kind: 'ask', draft: newAskDraft(dayAfter(latest.current.today, 3)) }),
      /** The window's fields; a new "Who" moves a floor ask to a work order (asks.ts withWho). */
      onAskWindow: (next: AskWindow) => {
        setProblem(null)
        setWindow((now) => (now?.kind === 'ask' && next.kind === 'ask' && now.draft.who !== next.draft.who ? { kind: 'ask', draft: withWho(next.draft, next.draft.who, { workOrders: choiceWorkOrders.current }) } : next))
      },
      onAskSubmit: () => void submit(),
      onAskClose: () => open(null),
      onAskDoor: door,
      onAskRetryPicks: loadPicks,
      onAskDismiss: () => setNotice(null),
    },
  }
}
