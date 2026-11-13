'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { checkMeasures, findCustomers, getTemplate, listContacts, listMtmStyles, listPeople, listTemplates, recordProfile, recordRevision, type Person, type ProfileRecord, type Recorded, type Revision } from './api'
import {
  brokenRules,
  checkMeasuresOf,
  draftFromRevision,
  emptyDraft,
  formPoints,
  formProblems,
  newProfileBodyOf,
  newRevisionBodyOf,
  readProblem,
  saveProblemsOf,
  type MtmCan,
} from './model'
import type { MeasurementsDialogActions, MeasurementsDialogModel } from './view-model'

/**
 * The measurement dialog's work, for both containers (the list's New measurements, the record's New revision): the pickers read
 * on open (customers searched as typed, the customer's contacts, the garment types, the office people, the MTM styles), the
 * template's points read when a garment type is picked, B-W2b-248's check run on what is typed (debounced; only while the
 * template's made-to-measure rules are on: the rules broken, and the base size suggested against a style picked), and the save:
 * ONE call with one Idempotency-Key kept for a retry, its refusal read in our words at each field.
 */
export function useMeasurementsDialog({ api, can, me, companyId, offline, onSaved }: { api: ApiClient; can: MtmCan; me: Person; companyId: string | null; offline: boolean; onSaved: (answer: Recorded) => void }) {
  const [model, setModel] = useState<MeasurementsDialogModel | null>(null)
  const key = useRef<string | null>(null)
  const current = useRef<MeasurementsDialogModel | null>(null)
  current.current = model
  const revisionOf = useRef<{ profileId: string; notice: { ref: string; at: string } } | null>(null)
  const patch = useCallback((next: Partial<MeasurementsDialogModel>) => setModel((now) => (now ? { ...now, ...next } : now)), [])

  const readShared = useCallback(() => {
    if (can.people)
      listPeople(api)
        .then((people) => patch({ people }))
        .catch(() => patch({ people: null }))
    if (can.styles)
      listMtmStyles(api, companyId)
        .then((styles) => patch({ styles }))
        .catch(() => patch({ styles: [] }))
    else patch({ styles: [] })
  }, [api, can.people, can.styles, companyId, patch])

  /** New measurements (design mtm.new). */
  const openNew = useCallback(() => {
    key.current = null
    revisionOf.current = null
    const now = new Date().toISOString()
    setModel({
      mode: 'new',
      customers: { items: null, problem: null },
      customerQ: '',
      partyId: '',
      contacts: { items: [], problem: null },
      contactId: '',
      riderName: '',
      templates: { items: null, problem: null },
      garmentType: '',
      template: null,
      points: null,
      pointsProblem: null,
      draft: emptyDraft(now),
      people: null,
      me,
      problems: {},
      flags: [],
      checking: false,
      styles: null,
      styleId: '',
      suggested: null,
      busy: false,
      offline,
      notice: null,
      leaving: false,
    })
    if (can.parties)
      findCustomers(api, '', companyId)
        .then((items) => patch({ customers: { items, problem: null } }))
        .catch((error: unknown) => patch({ customers: { items: [], problem: readProblem(error) } }))
    else patch({ customers: { items: [], problem: 'held.noParties' } })
    if (can.styles)
      listTemplates(api)
        .then((answer) => patch({ templates: { items: answer.templates, problem: null } }))
        .catch((error: unknown) => patch({ templates: { items: [], problem: readProblem(error) } }))
    else patch({ templates: { items: [], problem: 'held.noTemplates' } })
    readShared()
  }, [api, can.parties, can.styles, companyId, me, offline, patch, readShared])

  /** New revision from the revision on screen (the old one stays; orders keep theirs). */
  const openRevision = useCallback(
    (record: ProfileRecord, from: Revision) => {
      key.current = null
      revisionOf.current = { profileId: record.latestId, notice: { ref: record.revisions[0]?.privacyNoticeRef ?? from.privacyNoticeRef, at: record.revisions[0]?.privacyNoticeAt ?? from.privacyNoticeAt } }
      const now = new Date().toISOString()
      setModel({
        mode: 'revision',
        fixed: { riderName: record.riderName, customer: record.customer.name, garmentType: record.garmentType, revision: record.revisions[0]?.revision ?? 0 },
        template: record.template ? { id: record.template.id, code: record.template.code, name: record.template.name, rulesOn: record.template.rulesOn } : null,
        points: record.template ? formPoints(record.template.points) : [],
        pointsProblem: record.template ? null : 'off.noTemplate',
        draft: draftFromRevision(from, now),
        people: null,
        me,
        problems: {},
        flags: [],
        checking: false,
        styles: null,
        styleId: '',
        suggested: null,
        busy: false,
        offline,
        notice: null,
        leaving: false,
      })
      readShared()
    },
    [me, offline, readShared],
  )

  // The customers as typed (debounced).
  const customerQ = model?.mode === 'new' ? (model.customerQ ?? '') : null
  useEffect(() => {
    if (customerQ === null || !can.parties) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      findCustomers(api, customerQ, companyId, controller.signal)
        .then((items) => patch({ customers: { items, problem: null } }))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) patch({ customers: { items: [], problem: readProblem(error) } })
        })
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, customerQ, can.parties, companyId, patch])

  // The customer's contacts when the customer changes.
  const partyId = model?.mode === 'new' ? (model.partyId ?? '') : ''
  useEffect(() => {
    if (!partyId) return
    const controller = new AbortController()
    patch({ contacts: { items: null, problem: null }, contactId: '' })
    listContacts(api, partyId, controller.signal)
      .then((items) => {
        const rider = items.find((contact) => contact.roles.includes('RIDER'))
        patch({ contacts: { items, problem: null }, contactId: rider?.id ?? '', riderName: rider?.name ?? current.current?.riderName ?? '' })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) patch({ contacts: { items: [], problem: readProblem(error) } })
      })
    return () => controller.abort()
  }, [api, partyId, patch])

  // The template's points when a garment type is picked.
  const garment = model?.mode === 'new' ? (model.garmentType ?? '') : ''
  const templateId = model?.mode === 'new' ? (model.templates?.items?.find((template) => template.code === garment)?.id ?? '') : ''
  useEffect(() => {
    if (!templateId) return
    const controller = new AbortController()
    patch({ points: null, pointsProblem: null, flags: [], suggested: null })
    getTemplate(api, templateId, controller.signal)
      .then((template) => patch({ template: { id: template.id, code: template.code, name: template.name, rulesOn: template.rulesOn }, points: formPoints(template.points) }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) patch({ pointsProblem: readProblem(error) })
      })
    return () => controller.abort()
  }, [api, templateId, patch])

  // B-W2b-248's check on what is typed (only while the template's rules are on), debounced.
  const checkTemplate = model?.template?.rulesOn ? model.template.id : null
  const measures = model?.points ? JSON.stringify(checkMeasuresOf(model.draft, model.points)) : ''
  const styleId = model?.styleId ?? ''
  useEffect(() => {
    if (!checkTemplate || !measures || !can.styles) {
      patch({ flags: [], suggested: null, checking: false })
      return
    }
    const parsed = JSON.parse(measures) as Record<string, { value: string; unit: string }>
    if (Object.keys(parsed).length === 0) {
      patch({ flags: [], suggested: null, checking: false })
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      patch({ checking: true })
      checkMeasures(api, { templateId: checkTemplate, measurements: parsed, ...(styleId ? { styleId } : {}) }, controller.signal)
        .then((check) => patch({ checking: false, flags: brokenRules(check), suggested: styleId ? { size: check.baseSize.size, how: check.baseSize.how } : null }))
        .catch(() => {
          if (!controller.signal.aborted) patch({ checking: false })
        })
    }, 500)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, checkTemplate, measures, styleId, can.styles, patch])

  const save = useCallback(async () => {
    const now = current.current
    if (!now || now.busy || !now.points) return
    const problems = formProblems(now.draft, now.points, { needNotice: now.mode === 'new', now: new Date().toISOString() })
    if (Object.keys(problems).length > 0) {
      patch({ problems, notice: { key: 'form.problem.fix', params: { count: Object.keys(problems).length }, tone: 'danger' } })
      return
    }
    patch({ busy: true, notice: null, problems: {} })
    key.current ??= newIdempotencyKey()
    try {
      const answer =
        now.mode === 'new'
          ? await recordProfile(api, newProfileBodyOf({ partyId: now.partyId ?? '', contactId: now.contactId || null, riderName: now.contactId ? (now.contacts?.items?.find((contact) => contact.id === now.contactId)?.name ?? now.riderName ?? '') : (now.riderName ?? ''), garmentType: now.garmentType ?? '' }, now.draft, now.points, me.id), key.current)
          : await recordRevision(api, revisionOf.current?.profileId ?? '', newRevisionBodyOf(now.draft, now.points, me.id, revisionOf.current?.notice ?? null), key.current)
      key.current = null
      setModel(null)
      onSaved(answer)
    } catch (error) {
      const refused = saveProblemsOf(error, now.draft, now.points, now.mode)
      patch({ busy: false, problems: refused.fields, notice: { ...refused.notice, tone: 'danger' } })
    }
  }, [api, me.id, onSaved, patch])

  const dirty = (now: MeasurementsDialogModel | null) => !!now && Object.values(now.draft.values).some((value) => value.trim() !== '')

  const actions: MeasurementsDialogActions = {
    onCustomerQ: (q) => patch({ customerQ: q }),
    onCustomer: (id) => patch({ partyId: id }),
    onRider: (next) => patch({ ...(next.contactId !== undefined ? { contactId: next.contactId } : {}), ...(next.riderName !== undefined ? { riderName: next.riderName } : {}) }),
    onGarment: (code) => patch({ garmentType: code, template: null, points: null }),
    onDraft: (next) => setModel((now) => (now ? { ...now, draft: { ...now.draft, ...next } } : now)),
    onValue: (code, value) =>
      setModel((now) => {
        if (!now) return now
        const problems = { ...now.problems }
        delete problems[code]
        return { ...now, problems, draft: { ...now.draft, values: { ...now.draft.values, [code]: value.slice(0, 12) } } }
      }),
    onConfirm: (code, checked) => setModel((now) => (now ? { ...now, draft: { ...now.draft, confirmed: checked ? [...new Set([...now.draft.confirmed, code])] : now.draft.confirmed.filter((entry) => entry !== code) } } : now)),
    onStyle: (id) => patch({ styleId: id, suggested: null }),
    onSave: () => void save(),
    onClose: () => {
      const now = current.current
      if (dirty(now) && !now?.leaving) patch({ leaving: true })
      else setModel(null)
    },
    onKeep: () => patch({ leaving: false }),
    onDiscard: () => setModel(null),
  }

  return { model: model ? { ...model, offline } : null, actions, openNew, openRevision, close: () => setModel(null) }
}
