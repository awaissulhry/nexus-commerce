'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useLocale } from '../../../../lib/i18n/provider'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveChanges } from '../../../../record-panels/live'
import { readProblem, writeProblem, type Notice, type WriteProblem } from '../../library/model'
import { findMaterials, findOperations, listScales, listStyles } from '../../styles/api'
import { addEffect, addValue, getGroup, listGroups, moveGroup, moveValue, offerGroup, removeEffect, setPrice, setRules, updateEffect, updateGroup, updateValue, withdrawOffer, type GroupView } from '../api'
import {
  addValueBodyOf,
  decimalOf,
  effectBodyOf,
  effectPatchOf,
  formProblem,
  FREE_TEXT_START,
  OPTION_LIMITS,
  maxLengthProblemKey,
  movedSeq,
  offerPicksProblemKey,
  optionsCan,
  parseSurcharge,
  patternProblemKey,
  rulesBodyOf,
  tabOf,
  updateGroupBodyOf,
  withSizeQuantity,
  type PickedRef,
} from '../model'
import { useOnline } from '../online'
import type { CellMarks, GroupLoad, GroupRecordModel, RecordDialog, RulesModel } from '../view-model'
import { GroupRecordView } from './view/GroupRecordView'

/**
 * `/w/<company>/products/options/<id>` (SCR-114-record): reads the option group (product.styles.view) and writes through
 * B-W2b-229's routes, one command per write at the version it was read on (the group's for its fields, archive and rules;
 * the option's for its fields, effects and price; the offer's for a style's picks): every library write answers the whole
 * group, which the page takes as it is; a 409 reads it again. Live option_group.changed of this group (or style.updated of a
 * style that offers it) from someone else shows "Changed meanwhile · Reload". `?tab=options|rules|effects|styles`.
 */
export function OptionGroupRecord({ groupId }: { groupId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const language = useLocale()
  const online = useOnline()
  const can = useMemo(() => optionsCan(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/products\/options\/[^/]+\/?$/, '')
  const tab = tabOf(params?.get('tab'))
  const companyId = session.company?.id ?? null

  const [group, setGroup] = useState<GroupLoad>({ status: 'loading' })
  const [save, setSave] = useState<GroupRecordModel['save']>({ state: 'idle', at: null })
  const [cells, setCells] = useState<CellMarks>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [refused, setRefused] = useState<WriteProblem | null>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [rules, setRulesModel] = useState<RulesModel>({ items: null, busy: false, problem: null, messages: [], groups: null, values: {} })
  const [scales, setScales] = useState<GroupRecordModel['scales']>({ items: null, chosen: null })
  const writing = useRef(0)
  const searchSeq = useRef(0)
  const current = group.status === 'ready' ? group.value : null
  const latest = useRef(current)
  latest.current = current

  const load = useCallback(async () => {
    try {
      setGroup({ status: 'ready', value: await getGroup(api, groupId) })
      setChanged(null)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setGroup({ status: 'notFound' })
      else if (isApiError(error) && error.kind === 'forbidden') setGroup({ status: 'forbidden' })
      else setGroup({ status: 'error', problem: readProblem(error) })
    }
  }, [api, groupId])

  useEffect(() => {
    void load()
  }, [load])

  // The rules' "other option" picks a group first: the active groups, read once the Rules tab opens.
  useEffect(() => {
    if (tab !== 'rules' || rules.groups !== null) return
    listGroups(api, { status: 'ACTIVE' })
      .then((answer) => setRulesModel((model) => ({ ...model, groups: answer.groups })))
      .catch(() => setRulesModel((model) => ({ ...model, groups: [] })))
  }, [tab, api, rules.groups])

  // Quantities per size: the size scales, read once the effects tab opens.
  useEffect(() => {
    if (tab !== 'effects' || scales.items !== null) return
    listScales(api, companyId)
      .then((items) => setScales((model) => ({ ...model, items })))
      .catch(() => setScales((model) => ({ ...model, items: [] })))
  }, [tab, api, companyId, scales.items])

  useLiveChanges({
    onChange: (change) => {
      if (writing.current > 0) return
      if (change.type === 'option_group.changed' && change.fields.optionGroupId === groupId) setChanged({ at: new Date().toISOString() })
      if (change.type === 'style.updated' && latest.current?.styles.some((offer) => offer.style.id === change.fields.styleId)) setChanged({ at: new Date().toISOString() })
    },
  })

  const mark = (key: string | null, state: CellMarks[string] | null) => {
    if (!key) return
    setCells((marks) => {
      const next = { ...marks }
      if (state) next[key] = state
      else delete next[key]
      return next
    })
  }

  /** One write: the answer is the group as the command left it. A refused cell keeps its mark and our words. */
  const write = async (run: (value: GroupView) => Promise<GroupView | null>, options: { cells?: string[]; success?: Notice; onDone?: () => void; onRefused?: (problem: WriteProblem) => void } = {}): Promise<boolean> => {
    const value = latest.current
    if (!value) return false
    writing.current++
    setBusy(true)
    setSave((state) => ({ state: 'saving', at: state.at }))
    setRefused(null)
    for (const cell of options.cells ?? []) mark(cell, { state: 'saving' })
    try {
      const answer = await run(value)
      if (answer) setGroup({ status: 'ready', value: answer })
      setSave({ state: 'idle', at: new Date().toISOString() })
      for (const cell of options.cells ?? []) mark(cell, null)
      if (options.success) setNotice(options.success)
      options.onDone?.()
      return true
    } catch (error) {
      const problem = formProblem(writeProblem(error))
      setRefused(problem)
      setSave((state) => ({ state: 'failed', at: state.at }))
      for (const cell of options.cells ?? []) mark(cell, { state: 'refused', problem: problem.key })
      if (options.onRefused) options.onRefused(problem)
      else setNotice({ key: problem.key, tone: 'danger' })
      if (problem.reload) void load()
      return false
    } finally {
      writing.current--
      setBusy(false)
    }
  }

  const valueOf = (valueId: string) => latest.current?.values.find((entry) => entry.id === valueId)
  /** A typed value that is not sent: the cell keeps its mark, and the reason is said once above the tab. */
  const refuse = (cell: string, key: string, params?: Record<string, string | number>) => {
    mark(cell, { state: 'refused', problem: key, ...(params ? { params } : {}) })
    setNotice({ key, tone: 'warning', ...(params ? { params } : {}) })
  }

  // ---- options ------------------------------------------------------------------------------------------------------

  const onValueCell = (valueId: string, field: 'code' | 'name' | 'freeTextMaxLength' | 'freeTextPattern', input: string | number | null) => {
    const value = valueOf(valueId)
    if (!value) return
    const cell = `${valueId}/${field}`
    if (field === 'code' && (typeof input !== 'string' || !/^\S+$/.test(input))) return refuse(cell, 'group.problem.codeForm', { max: OPTION_LIMITS.code })
    if (field === 'freeTextMaxLength' && (input === null || maxLengthProblemKey(String(input)))) return refuse(cell, 'value.problem.maxLength', { max: OPTION_LIMITS.freeTextLength })
    if (field === 'freeTextPattern' && typeof input === 'string') {
      const problem = patternProblemKey(input)
      if (problem) return refuse(cell, problem, { max: OPTION_LIMITS.pattern })
    }
    void write((group) => updateValue(api, group.id, valueId, { version: value.version, [field]: input }), { cells: [cell] })
  }

  const onFreeText = (valueId: string, on: boolean) => {
    const value = valueOf(valueId)
    if (!value) return
    const body = on ? { version: value.version, freeText: true, freeTextMaxLength: value.freeTextMaxLength ?? FREE_TEXT_START } : { version: value.version, freeText: false, freeTextMaxLength: null, freeTextPattern: null }
    void write((group) => updateValue(api, group.id, valueId, body), { cells: [`${valueId}/freeText`] })
  }

  const onPrice = (valueId: string, text: string) => {
    const value = valueOf(valueId)
    if (!value) return
    const effect = latest.current?.effects.find((entry) => entry.valueId === valueId && entry.kind === 'PRICE')
    const keys = [`${valueId}/price`, ...(effect ? [`${effect.id}/price`] : [])]
    const parsed = parseSurcharge(text)
    if (!parsed.ok) return keys.forEach((key) => refuse(key, parsed.key))
    void write((group) => setPrice(api, group.id, valueId, { version: value.version, ...parsed.body }), { cells: keys })
  }

  const onCertificate = (valueId: string, on: boolean) => {
    if (on) return setDialog({ kind: 'certificate', valueId, note: '', busy: false, problem: null })
    // Off: the option's "outside the certificate" effects are removed (each at the option's version as the last answer left it).
    void write(
      async (group) => {
        let answer: GroupView = group
        for (const effect of group.effects.filter((entry) => entry.valueId === valueId && entry.kind === 'CERTIFICATE')) {
          const value = answer.values.find((entry) => entry.id === valueId)!
          answer = await removeEffect(api, group.id, value, effect.id)
        }
        return answer
      },
      { cells: [`${valueId}/outsideCertificate`] },
    )
  }

  const onSaveCertificate = () => {
    if (dialog?.kind !== 'certificate') return
    const value = valueOf(dialog.valueId)
    if (!value) return
    const asked = dialog
    setDialog({ ...asked, busy: true, problem: null })
    void write((group) => addEffect(api, group.id, value.id, { version: value.version, kind: 'CERTIFICATE', note: asked.note.trim() }), {
      cells: [`${value.id}/outsideCertificate`],
      onDone: () => setDialog(null),
      onRefused: (problem) => setDialog({ ...asked, busy: false, problem: problem.key }),
    })
  }

  const onMoveValue = (valueId: string, by: -1 | 1) => {
    const value = valueOf(valueId)
    const seq = latest.current ? movedSeq(latest.current.values, valueId, by) : null
    if (!value || seq === null) return
    void write((group) => updateValue(api, group.id, valueId, { version: value.version, seq }))
  }

  const onValueStatus = (valueId: string, to: 'archive' | 'restore', reason: string) => {
    const value = valueOf(valueId)
    if (!value) return
    void write((group) => moveValue(api, group.id, value, to, reason || undefined), { success: { key: to === 'archive' ? 'notice.valueArchived' : 'notice.valueRestored', tone: 'success', params: { code: value.code } }, onDone: () => setDialog(null) })
  }

  const onAddValue = () => {
    if (dialog?.kind !== 'addValue') return
    const asked = dialog
    setDialog({ ...asked, busy: true, problem: null, refused: [], messages: [] })
    void write((group) => addValue(api, group.id, addValueBodyOf(asked.draft)), {
      success: { key: 'notice.valueAdded', tone: 'success', params: { code: asked.draft.code.trim() } },
      onDone: () => setDialog(null),
      onRefused: (problem) => setDialog({ ...asked, busy: false, problem: problem.key, refused: problem.paths, messages: problem.messages }),
    })
  }

  // ---- rules --------------------------------------------------------------------------------------------------------

  const onOtherGroup = (otherId: string) => {
    if (rules.values[otherId] && rules.values[otherId] !== 'failed') return
    setRulesModel((model) => ({ ...model, values: { ...model.values, [otherId]: 'loading' } }))
    getGroup(api, otherId)
      .then((other) => setRulesModel((model) => ({ ...model, values: { ...model.values, [otherId]: other.values.map((value) => ({ id: value.id, code: value.code, name: value.name, status: value.status })) } })))
      .catch(() => setRulesModel((model) => ({ ...model, values: { ...model.values, [otherId]: 'failed' } })))
  }

  // A saved rule naming another group's option: that group's options are read so the picker lists them.
  useEffect(() => {
    if (!current || tab !== 'rules') return
    for (const rule of current.rules) if (rule.other.groupId !== current.id && rules.values[rule.other.groupId] === undefined) onOtherGroup(rule.other.groupId)
  }, [current, tab])

  const onSaveRules = () => {
    const items = rules.items
    if (!items) return
    setRulesModel((model) => ({ ...model, busy: true, problem: null, messages: [] }))
    void write((group) => setRules(api, group.id, rulesBodyOf(group, items)), {
      success: { key: 'notice.rulesSaved', tone: 'success' },
      onDone: () => setRulesModel((model) => ({ ...model, items: null, busy: false })),
      onRefused: (problem) => setRulesModel((model) => ({ ...model, busy: false, problem: problem.key, messages: problem.messages })),
    })
  }

  // ---- effects ------------------------------------------------------------------------------------------------------

  const effectOf = (effectId: string) => latest.current?.effects.find((entry) => entry.id === effectId)

  const onEffectCell = (effectId: string, field: 'qty' | 'minutes' | 'note', text: string) => {
    const effect = effectOf(effectId)
    const value = effect ? valueOf(effect.valueId) : undefined
    if (!effect || !value) return
    const cell = `${effectId}/${field}`
    let input: string | null
    if (field === 'note') {
      input = text.trim() || null
      if (input === null && effect.kind === 'CERTIFICATE') return refuse(cell, 'effect.problem.certificate')
    } else {
      const typed = decimalOf(text)
      if (typed === undefined) return refuse(cell, field === 'qty' ? 'effect.problem.qty' : 'effect.problem.minutes')
      input = typed
    }
    void write((group) => updateEffect(api, group.id, value.id, effectId, { version: value.version, [field]: input }), { cells: [cell] })
  }

  const onEffectSize = (effectId: string, size: string, input: string | null) => {
    const effect = effectOf(effectId)
    const value = effect ? valueOf(effect.valueId) : undefined
    if (!effect || !value) return
    const cell = `${effectId}/size:${size}`
    const next = withSizeQuantity(effect.sizeQuantities, size, input)
    if (next === null && effect.qty === null) return refuse(cell, 'effect.problem.qtyNeeded')
    void write((group) => updateEffect(api, group.id, value.id, effectId, { version: value.version, sizeQuantities: next }), { cells: [cell] })
  }

  const onSearch = (picker: 'material' | 'target' | 'operation', q: string) => {
    if (dialog?.kind !== 'effect') return
    const mine = ++searchSeq.current
    setDialog({ ...dialog, [picker]: { q, results: q.trim() === '' ? (dialog[picker].results ?? null) : null } })
    if (q.trim() === '') return
    const found: Promise<PickedRef[]> = picker === 'operation' ? findOperations(api, q, null, companyId).then((rows) => rows.map((row) => ({ id: row.id, code: row.code, name: row.name }))) : findMaterials(api, q, companyId).then((rows) => rows.map((row) => ({ id: row.id, code: row.code, name: row.name })))
    found
      .then((results) => {
        if (mine !== searchSeq.current) return
        setDialog((open) => (open?.kind === 'effect' ? { ...open, [picker]: { q, results } } : open))
      })
      .catch(() => setDialog((open) => (open?.kind === 'effect' ? { ...open, [picker]: { q, results: [] } } : open)))
  }

  const onSaveEffect = () => {
    if (dialog?.kind !== 'effect') return
    const asked = dialog
    const value = valueOf(asked.draft.valueId)
    if (!value) return
    const effect = asked.effectId ? effectOf(asked.effectId) : undefined
    if (asked.mode === 'edit' && effect) {
      const patch = effectPatchOf(effect, asked.draft, value.version)
      if (!patch) return setDialog(null)
      setDialog({ ...asked, busy: true, problem: null, refused: [], messages: [] })
      void write((group) => updateEffect(api, group.id, value.id, effect.id, patch), {
        success: { key: 'notice.effectSaved', tone: 'success', params: { code: value.code } },
        onDone: () => setDialog(null),
        onRefused: (problem) => setDialog({ ...asked, busy: false, problem: problem.key, refused: problem.paths, messages: problem.messages }),
      })
      return
    }
    setDialog({ ...asked, busy: true, problem: null, refused: [], messages: [] })
    void write((group) => addEffect(api, group.id, value.id, effectBodyOf(asked.draft, value.version)), {
      success: { key: 'notice.effectAdded', tone: 'success', params: { code: value.code } },
      onDone: () => setDialog(null),
      onRefused: (problem) => setDialog({ ...asked, busy: false, problem: problem.key, refused: problem.paths, messages: problem.messages }),
    })
  }

  const onRemoveEffect = (effectId: string) => {
    const effect = effectOf(effectId)
    const value = effect ? valueOf(effect.valueId) : undefined
    if (!effect || !value) return
    void write((group) => removeEffect(api, group.id, value, effectId), { success: { key: 'notice.effectRemoved', tone: 'success', params: { code: value.code } }, onDone: () => setDialog(null) })
  }

  // ---- styles -------------------------------------------------------------------------------------------------------

  const onOfferCell = (offerId: string, field: 'minPicks' | 'maxPicks', input: number | null | 'invalid') => {
    const group = latest.current
    const offer = group?.styles.find((entry) => entry.id === offerId)
    if (!group || !offer) return
    const cell = `${offerId}/${field}`
    if (input === 'invalid') return refuse(cell, 'styles.problem.whole')
    const min = field === 'minPicks' ? input : offer.minPicks
    const max = field === 'maxPicks' ? input : offer.maxPicks
    const problem = offerPicksProblemKey(group.kind, group, min, max)
    if (problem) return refuse(cell, problem)
    void write(
      async (value) => {
        await offerGroup(api, offer.style.id, value.id, { version: offer.version, [field]: input })
        return getGroup(api, value.id)
      },
      { cells: [cell] },
    )
  }

  const onFindStyles = (q: string) => {
    if (dialog?.kind !== 'styles') return
    const mine = ++searchSeq.current
    setDialog({ ...dialog, q, results: null })
    listStyles(api, { q, status: 'OPEN', limit: 50 })
      .then((page) => {
        if (mine === searchSeq.current) setDialog((open) => (open?.kind === 'styles' ? { ...open, results: page.styles.map((style) => ({ id: style.id, code: style.code, name: style.name, status: style.status })) } : open))
      })
      .catch(() => setDialog((open) => (open?.kind === 'styles' ? { ...open, results: [] } : open)))
  }

  // The Add styles dialog lists the first styles as soon as it opens.
  const stylesOpen = dialog?.kind === 'styles' && dialog.results === null && dialog.q === '' && !dialog.outcome
  useEffect(() => {
    if (stylesOpen) onFindStyles('')
  }, [stylesOpen])

  const onAddStyles = () => {
    if (dialog?.kind !== 'styles') return
    const asked = dialog
    const styles = (asked.results ?? []).filter((style) => asked.picked.includes(style.id))
    setDialog({ ...asked, busy: true })
    void write(async (value) => {
      const added: string[] = []
      const refusedStyles: Array<{ code: string; key: string; message: string | null }> = []
      for (const style of styles) {
        try {
          await offerGroup(api, style.id, value.id, { version: null })
          added.push(style.code)
        } catch (error) {
          const problem = formProblem(writeProblem(error))
          refusedStyles.push({ code: style.code, key: problem.key, message: problem.messages[0] ?? null })
        }
      }
      setDialog({ ...asked, busy: false, outcome: { added, refused: refusedStyles } })
      return getGroup(api, value.id)
    })
  }

  const onWithdraw = (offerId: string) => {
    const offer = latest.current?.styles.find((entry) => entry.id === offerId)
    if (!offer) return
    void write(
      async (value) => {
        const answer = await withdrawOffer(api, offer.style.id, value.id, offer.version)
        setNotice({ key: 'notice.withdrawn', tone: 'success', params: { code: offer.style.code, words: language === 'it' ? answer.words.it : answer.words.en } })
        return getGroup(api, value.id)
      },
      { cells: [`${offerId}/withdraw`], onDone: () => setDialog(null) },
    )
  }

  // ---- the group ----------------------------------------------------------------------------------------------------

  const onSaveGroup = () => {
    if (dialog?.kind !== 'edit') return
    const asked = dialog
    const body = latest.current ? updateGroupBodyOf(latest.current, asked.form.draft) : null
    if (!body) return setDialog(null)
    setDialog({ kind: 'edit', form: { ...asked.form, busy: true, problem: null, refused: [], messages: [] } })
    void write((group) => updateGroup(api, group.id, body), {
      success: { key: 'notice.groupSaved', tone: 'success', params: { code: asked.form.draft.code.trim() } },
      onDone: () => setDialog(null),
      onRefused: (problem) => setDialog({ kind: 'edit', form: { ...asked.form, busy: false, problem: problem.key, refused: problem.paths, messages: problem.messages } }),
    })
  }

  const onMoveGroup = (to: 'archive' | 'restore', reason: string) => {
    void write((group) => moveGroup(api, group, to, reason || undefined), { success: { key: to === 'archive' ? 'notice.groupArchived' : 'notice.groupRestored', tone: 'success' }, onDone: () => setDialog(null) })
  }

  const companyName = current?.companyId ? (session.companies.find((company) => company.id === current.companyId)?.name ?? null) : null
  const model: GroupRecordModel = { prefix, can, tab, group, locale: INTL_LOCALE[language], save, cells, busy, notice, refused, changed, offline: !online, rules, scales, dialog, companyName }

  return (
    <GroupRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onReload: () => void load(),
        onDialog: setDialog,
        onDismissNotice: () => setNotice(null),
        onGroupDraft: (draft) => setDialog((open) => (open?.kind === 'edit' ? { kind: 'edit', form: { ...open.form, draft, refused: [] } } : open)),
        onSaveGroup,
        onMoveGroup,
        onValueCell,
        onFreeText,
        onPrice,
        onCertificate,
        onSaveCertificate,
        onMoveValue,
        onValueStatus,
        onAddValue,
        onRules: (items) => setRulesModel((model) => ({ ...model, items, problem: items ? model.problem : null, messages: items ? model.messages : [] })),
        onSaveRules,
        onOtherGroup,
        onEffectCell,
        onEffectSize,
        onSizeRefused: (size, text) => setNotice({ key: 'effects.notNumber', tone: 'warning', params: { size, text } }),
        onScale: (scaleId) => setScales((model) => ({ ...model, chosen: scaleId })),
        onSearch,
        onSaveEffect,
        onRemoveEffect,
        onOfferCell,
        onFindStyles,
        onAddStyles,
        onWithdraw,
      }}
    />
  )
}
