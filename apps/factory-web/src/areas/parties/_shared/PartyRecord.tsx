'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { RecordPanels } from '../../../record-panels/RecordPanels'
import {
  addAddress,
  addContact,
  addTaxIdentity,
  checkVies,
  getParty,
  listPurchaseOrdersOf,
  listQuotesOf,
  listSalesOrdersOf,
  moveParty,
  setDefaultAddresses,
  updateAddress,
  updateContact,
  updateParty,
  updateTaxIdentity,
  viesHistory,
  type Party,
  type PartyMove,
  type PurchaseOrderRow,
  type QuoteRow,
  type SalesOrderRow,
  type ViesCheck,
} from './api'
import { partyEvent, useLive, useRecordTab, useThreadDock } from './hooks'
import {
  addressBody,
  addressDraftOf,
  contactBody,
  failed,
  identitiesOf,
  identityBody,
  loaded,
  loading,
  partyName,
  partyPatch,
  problemKey,
  refusedFields,
  SIDES,
  type AddressDraft,
  type ContactDraft,
  type DealFilter,
  type IdentityDraft,
  type Loaded,
  type Notice,
  type PartyDraft,
  type RecordDialog,
  type Side,
} from './model'
import { PartyRecordView } from './view/PartyRecordView'

/**
 * The record container of both sides (`/w/<company>/sales/customers/<id>` SCR-033, `/w/<company>/purchasing/
 * suppliers/<id>` SCR-057): reads the party (`GET /parties/:id`), its VIES history on Tax & terms, and beside it the
 * customer's quotes and orders or the supplier's purchase orders when the person may read them (money only with its
 * grain: the API leaves the fields out). Every write sends the version read (COL-078): a 409 reads the record again and
 * says someone else changed it. The live stream reads the record again on its party's events; while a dialog or the
 * supplier's form holds unsaved work, a banner offers the reload instead (our edits are kept).
 */
export function PartyRecord({ side, partyId }: { side: Side; partyId: string }) {
  return (
    <WithMessages namespaces={['parties']}>
      <PartyRecordContainer side={side} partyId={partyId} />
    </WithMessages>
  )
}

function PartyRecordContainer({ side, partyId }: { side: Side; partyId: string }) {
  const config = SIDES[side]
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const can = {
    view: held.has('parties.view'),
    manage: held.has('parties.manage'),
    block: held.has('parties.block'),
    vies: held.has('parties.vies'),
    quotes: held.has('quotes.view'),
    orders: held.has('orders.view'),
    purchaseOrders: held.has('purchasing.view'),
    price: held.has('money.price'),
    cost: held.has('money.cost'),
    threads: held.has('threads.read'),
  }
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(config.tabs)
  const { dockOpen, toggleDock } = useThreadDock(side)
  const [party, setParty] = useState<Party | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(params?.get('vies') === 'failed' ? { key: 'vies.afterCreateFailed', tone: 'warning' } : null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [refused, setRefused] = useState<readonly string[]>([])
  const [history, setHistory] = useState<Loaded<ViesCheck>>(loading())
  const [quotes, setQuotes] = useState<Loaded<QuoteRow>>(loading())
  const [orders, setOrders] = useState<Loaded<SalesOrderRow>>(loading())
  const [purchaseOrders, setPurchaseOrders] = useState<Loaded<PurchaseOrderRow>>(loading())
  const [viesRunning, setViesRunning] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [deals, setDeals] = useState<DealFilter>('open')
  const dirty = useRef(false)

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      setParty(await getParty(api, partyId))
      setProblem(null)
      setChangedAt(null)
      setAsOf(new Date().toISOString())
    } catch (error) {
      setProblem(problemKey(error))
    }
  }, [api, can.view, partyId])

  const loadBeside = useCallback(async () => {
    if (!can.view) return
    const reads: Array<Promise<void>> = []
    if (side === 'customers' && can.quotes)
      reads.push(
        listQuotesOf(api, partyId).then(
          (answer) => setQuotes(loaded(answer.rows, answer.more)),
          (error: unknown) => setQuotes(failed(problemKey(error))),
        ),
      )
    if (side === 'customers' && can.orders)
      reads.push(
        listSalesOrdersOf(api, partyId).then(
          (answer) => setOrders(loaded(answer.rows, answer.more)),
          (error: unknown) => setOrders(failed(problemKey(error))),
        ),
      )
    if (side === 'suppliers' && can.purchaseOrders)
      reads.push(
        listPurchaseOrdersOf(api, partyId).then(
          (answer) => setPurchaseOrders(loaded(answer.rows, answer.more)),
          (error: unknown) => setPurchaseOrders(failed(problemKey(error))),
        ),
      )
    await Promise.all(reads)
  }, [api, can.orders, can.purchaseOrders, can.quotes, can.view, partyId, side])

  const loadHistory = useCallback(async () => {
    try {
      const answer = await viesHistory(api, partyId)
      setHistory(loaded(answer.checks, answer.nextCursor !== null))
    } catch (error) {
      setHistory(failed(problemKey(error)))
    }
  }, [api, partyId])

  useEffect(() => {
    void load()
    void loadBeside()
  }, [load, loadBeside])
  useEffect(() => {
    if (tab === 'tax' && can.view) void loadHistory()
  }, [tab, can.view, loadHistory])

  const live = useLive(
    (change) => {
      const event = partyEvent(change)
      if (!event || event.partyId !== partyId) return
      if (dialog || dirty.current) setChangedAt(new Date().toISOString())
      else {
        void load()
        if (change.type === 'party.vies_checked' && tab === 'tax') void loadHistory()
      }
    },
    () => {
      void load()
      void loadBeside()
    },
  )

  const closeDialog = () => {
    setDialog(null)
    setDialogProblem(null)
    setRefused([])
  }

  /** One write: the record it answers replaces ours; a 409 reads it again; the dialog shows a refusal at its fields. */
  const write = async (work: () => Promise<Party>, done: string, keepDialog = false): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    setRefused([])
    try {
      setParty(await work())
      setAsOf(new Date().toISOString())
      setNotice({ key: done, tone: 'success', params: { name: party ? partyName(party) : '' } })
      if (!keepDialog) closeDialog()
      return true
    } catch (error) {
      const key = problemKey(error)
      if (dialog) {
        setDialogProblem(key)
        setRefused(refusedFields(error))
      } else setNotice({ key, tone: key === 'problem.conflict' ? 'warning' : 'danger' })
      if (isApiError(error) && error.kind === 'conflict') void load()
      return false
    } finally {
      setBusy(false)
    }
  }

  const move = (kind: PartyMove, reason?: string) =>
    party ? write(() => moveParty(api, party.id, kind, { version: party.version, ...(reason ? { reason } : {}) }), `done.${kind}`) : Promise.resolve(false)

  const onCheckVies = async () => {
    if (!party) return
    setViesRunning(true)
    setNotice({ key: 'vies.checkingOne', tone: 'info', params: { name: partyName(party) } })
    try {
      const answer = await checkVies(api, party.id, party.companyId === null && session.company ? { companyId: session.company.id } : {})
      setParty(answer.party)
      setAsOf(new Date().toISOString())
      setNotice({
        key: `vies.done.${answer.check.result}`,
        tone: answer.check.result === 'VALID' ? 'success' : answer.check.result === 'INVALID' ? 'danger' : 'warning',
        params: { name: partyName(answer.party) },
      })
      if (tab === 'tax') void loadHistory()
    } catch (error) {
      setNotice({ key: isApiError(error) && error.kind === 'conflict' ? 'vies.refused' : problemKey(error), tone: 'danger' })
    } finally {
      setViesRunning(false)
    }
  }

  const onSaveAddress = (draft: AddressDraft, addressId?: string) => {
    if (!party) return
    if (!addressId) {
      void write(() => addAddress(api, party.id, { ...addressBody(draft), isDefaultBillTo: draft.isDefaultBillTo, isDefaultShipTo: draft.isDefaultShipTo }), 'done.addressAdded')
      return
    }
    const address = party.addresses.find((item) => item.id === addressId)
    if (!address) return
    const before = addressBody(addressDraftOf(address))
    const after = addressBody(draft)
    const changed = Object.fromEntries(Object.entries(after).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(before[field as keyof typeof before])))
    if (Object.keys(changed).length === 0) return closeDialog()
    void write(() => updateAddress(api, party.id, addressId, { ...changed, version: address.version }), 'done.addressSaved')
  }

  const onSaveContact = (draft: ContactDraft, contactId?: string) => {
    if (!party) return
    if (!contactId) {
      void write(() => addContact(api, party.id, contactBody(draft)), 'done.contactAdded')
      return
    }
    const contact = party.contacts.find((item) => item.id === contactId)
    if (!contact) return
    void write(() => updateContact(api, party.id, contactId, { ...contactBody(draft), version: contact.version }), 'done.contactSaved')
  }

  const onSaveIdentity = (draft: IdentityDraft, mode: 'new' | 'correct') => {
    if (!party) return
    const { current } = identitiesOf(party)
    if (mode === 'correct' && current) void write(() => updateTaxIdentity(api, party.id, current.id, { ...identityBody(draft, false), version: current.version }), 'done.identityCorrected')
    else void write(() => addTaxIdentity(api, party.id, identityBody(draft, true)), 'done.identityAdded')
  }

  const onSaveParty = async (before: PartyDraft, after: PartyDraft): Promise<boolean> => {
    if (!party) return false
    const patch = partyPatch(before, after)
    if (Object.keys(patch).length === 0) {
      closeDialog()
      return true
    }
    const ok = await write(() => updateParty(api, party.id, { ...patch, version: party.version }), 'done.saved')
    if (ok) dirty.current = false
    return ok
  }

  const name = party ? partyName(party) : ''
  const panels =
    party && can.threads ? (
      <RecordPanels
        record={{ type: config.recordType, id: party.id, companyId: party.companyId }}
        title={name}
        party={{ id: party.id, name, emails: party.contacts.filter((contact) => contact.status === 'ACTIVE' && contact.email).map((contact) => contact.email!) }}
      />
    ) : null
  const documents =
    party && can.threads ? (
      <RecordPanels
        record={{ type: config.recordType, id: party.id, companyId: party.companyId }}
        title={name}
        party={{ id: party.id, name, emails: party.contacts.filter((contact) => contact.status === 'ACTIVE' && contact.email).map((contact) => contact.email!) }}
        tab="files"
      />
    ) : null

  return (
    <PartyRecordView
      model={{
        side,
        prefix,
        tab,
        party,
        problem,
        can,
        asOf,
        live,
        changedAt,
        busy,
        notice,
        dialog,
        dialogProblem,
        refused,
        dockOpen,
        history,
        quotes,
        orders,
        purchaseOrders,
        viesRunning,
        saving,
        deals,
      }}
      panels={panels}
      documents={documents}
      actions={{
        onRetry: () => {
          setProblem(null)
          setParty(null)
          void load()
          void loadBeside()
        },
        onReload: () => {
          dirty.current = false
          closeDialog()
          void load()
        },
        onDock: toggleDock,
        onDialog: (next) => (next ? setDialog(next) : closeDialog()),
        onDismissNotice: () => setNotice(null),
        onSaveParty,
        onDirty: (value) => {
          dirty.current = value
        },
        onActivate: () => void move('activate'),
        onBlock: (reason) => void move('block', reason),
        onUnblock: () => void move('unblock'),
        onArchive: () => void move('archive'),
        onReactivate: () => void move('reactivate'),
        onCheckVies: () => void onCheckVies(),
        onSaveAddress,
        onAddressStatus: (addressId, status) => {
          const address = party?.addresses.find((item) => item.id === addressId)
          if (party && address) void write(() => updateAddress(api, party.id, addressId, { version: address.version, status }), status === 'ARCHIVED' ? 'done.addressArchived' : 'done.addressRestored')
        },
        onDefault: (which, addressId) => {
          if (!party) return
          const current = party.addresses.find((address) => (which === 'billTo' ? address.isDefaultBillTo : address.isDefaultShipTo))
          setSaving(`${which}:${addressId ?? current?.id ?? ''}`)
          void write(
            () => setDefaultAddresses(api, party.id, { version: party.version, ...(which === 'billTo' ? { billToAddressId: addressId } : { shipToAddressId: addressId }) }),
            'done.defaultSaved',
            true,
          ).finally(() => setSaving(null))
        },
        onSaveContact,
        onContactStatus: (contactId, status) => {
          const contact = party?.contacts.find((item) => item.id === contactId)
          if (party && contact) void write(() => updateContact(api, party.id, contactId, { version: contact.version, status }), status === 'ARCHIVED' ? 'done.contactArchived' : 'done.contactRestored')
        },
        onReceivesOrders: (contactId, on) => {
          const contact = party?.contacts.find((item) => item.id === contactId)
          if (!party || !contact) return
          setSaving(`orders:${contactId}`)
          const roles = on ? [...new Set([...contact.roles, 'ORDERS' as const])] : contact.roles.filter((role) => role !== 'ORDERS')
          void write(() => updateContact(api, party.id, contactId, { version: contact.version, roles }), on ? 'done.receivesPos' : 'done.noLongerPos', true).finally(() => setSaving(null))
        },
        onSaveIdentity,
        onDeals: setDeals,
        onCopyCode: () => {
          if (!party) return
          void navigator.clipboard?.writeText(party.code).then(
            () => setNotice({ key: 'record.copied', tone: 'success', params: { code: party.code } }),
            () => setNotice({ key: 'record.copyFailed', tone: 'warning', params: { code: party.code } }),
          )
        },
      }}
    />
  )
}
