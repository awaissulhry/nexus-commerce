'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ComplianceGate } from '@nexus/factory-domain/compliance/requirements/rules'
import type { EvidenceRule } from '@nexus/factory-domain/quality/lab/rules'
import { newIdempotencyKey } from '../../../lib/api/client'
import { createRequirement, editRequirement, readCrVi, readCrViMaterials, readGates, readMarkets, readRequirements, saveCrVi, switchRequirement, writeW1, type CrViMaterial, type Requirement } from './api'
import {
  crViLoosens,
  EMPTY_REQUIREMENT,
  gateChangeOf,
  gateChanged,
  gateDraftOf,
  looseningsOf,
  missingSuggestions,
  requirementBodyOf,
  suggestionBody,
  switchesOff,
  switchHeld,
  valueOf,
  type GateDraft,
  type Read,
} from './model'
import { each, useRead, writingOf, type TabContext } from './use-settings'
import { IDLE, type AddRequirementState, type Cr6Actions, type Cr6State, type GatesActions, type GatesState, type Writing } from './view-model'

/**
 * Chromium VI (rm-cr6): the rule in force for the scope (this company or every company), the materials that need the test, the
 * draft; Apply saves at once when it tightens, else asks the confirm in words with the reason, then the step-up.
 */
export function useCr6(context: TabContext): { state: Cr6State; actions: Cr6Actions } {
  const { api, active, can, address, companyId, guard, notify, stamp, tick } = context
  const [settings, loadSettings, setSettings] = useRead<Awaited<ReturnType<typeof readCrVi>>>()
  const [materials, setMaterials] = useState<Read<{ materials: CrViMaterial[]; count: number }> | null>(null)
  const [draft, setDraft] = useState<EvidenceRule | null>(null)
  const [loosen, setLoosen] = useState<{ reason: string } | null>(null)
  const [writing, setWriting] = useState<Writing>(IDLE)
  const scopeCompany = address.scope === 'company' ? companyId : null

  const read = useCallback(
    (quiet = false) => {
      if (!can.crViView) return
      void loadSettings(() => readCrVi(api, scopeCompany), quiet).then((value) => value && stamp())
      if (can.materialsView) {
        if (!quiet) setMaterials({ status: 'loading' })
        readCrViMaterials(api).then(
          (value) => setMaterials({ status: 'ready', value }),
          () => setMaterials({ status: 'error', problem: 'problem.read' }),
        )
      } else setMaterials(null)
    },
    [api, can.crViView, can.materialsView, scopeCompany, loadSettings, stamp],
  )
  useEffect(() => {
    if (!active) return
    setDraft(null)
    read()
  }, [active, read])
  useEffect(() => {
    if (active && tick > 0) read(true)
  }, [tick])

  const save = useCallback(
    async (reason: string | null) => {
      const current = valueOf(settings)
      if (!current || !draft) return
      setWriting({ busy: true, problem: null })
      try {
        const loosening = crViLoosens(current.crViEvidenceRule, draft)
        const key = newIdempotencyKey()
        const saved = await guard('stepUp.loosen', () => saveCrVi(api, { companyId: scopeCompany, rule: draft, version: current.version, reason }, key))
        setSettings({ status: 'ready', value: saved })
        setDraft(null)
        setLoosen(null)
        setWriting(IDLE)
        notify({ tone: 'success', key: loosening ? 'notice.crViLoosened' : 'notice.crViTightened' })
      } catch (error) {
        const failed = writingOf(error)
        setWriting(failed)
        if (failed.problem?.key === 'problem.conflict') read(true)
      }
    },
    [api, settings, draft, scopeCompany, guard, notify, read, setSettings],
  )

  return {
    state: { settings, materials, draft, loosen, writing },
    actions: {
      onScope: (scope) => context.go({ scope }),
      onDraft: (rule) => {
        setDraft(rule)
        setWriting(IDLE)
      },
      onApply: () => {
        const current = valueOf(settings)
        if (!current || !draft) return
        if (crViLoosens(current.crViEvidenceRule, draft)) setLoosen({ reason: '' })
        else void save(null)
      },
      onReason: (reason) => setLoosen({ reason }),
      onConfirm: () => void save(loosen?.reason.trim() ?? null),
      onCancel: () => {
        setLoosen(null)
        setWriting(IDLE)
      },
      onRetry: () => read(),
    },
  }
}

/**
 * Gates (rm-gates): the matrix and the person's drafts per row; Apply writes each changed row (gates, override roles and days
 * by PATCH, the switch by PUT), a looser change after the confirm in words; each write asks the step-up when the API wants it
 * (the code holds five minutes, so one code covers the rest). Add requirement: the suggested rows (OFF with the reason) or
 * one of the person's own.
 */
export function useGates(context: TabContext): { state: GatesState; actions: GatesActions } {
  const { api, active, can, address, guard, notify, stamp, tick, locale } = context
  const [matrix, loadMatrix] = useRead<Awaited<ReturnType<typeof readGates>>>()
  const [drafts, setDrafts] = useState<Record<string, GateDraft>>({})
  const [selected, setSelected] = useState<string[]>([])
  const [loosen, setLoosen] = useState<{ reason: string } | null>(null)
  const [override, setOverride] = useState<GatesState['override']>(null)
  const [add, setAdd] = useState<AddRequirementState | null>(null)
  const [writing, setWriting] = useState<Writing>(IDLE)

  const read = useCallback((quiet = false) => (can.view ? loadMatrix(() => readGates(api), quiet).then((value) => value && stamp()) : Promise.resolve()), [api, can.view, loadMatrix, stamp])
  useEffect(() => {
    if (active) void read()
  }, [active, read])
  useEffect(() => {
    if (active && tick > 0) void read(true)
  }, [tick])

  const rows = useMemo(() => valueOf(matrix)?.rows ?? [], [matrix])
  const rowOf = (code: string) => rows.find((row) => row.requirement.code === code) ?? null
  const draftOf = (code: string): GateDraft | null => {
    const row = rowOf(code)
    return row ? (drafts[code] ?? gateDraftOf(row)) : null
  }
  const put = (code: string, next: GateDraft) => {
    const row = rowOf(code)
    if (!row) return
    setDrafts((current) => {
      const copy = { ...current }
      if (gateChanged(row, next)) copy[code] = next
      else delete copy[code]
      return copy
    })
    setWriting(IDLE)
  }

  // Add requirement opens from the address: every requirement (the suggestions skip what exists) and the market codes.
  const openAdd = useCallback(
    (way: 'suggested' | 'own' = 'suggested') => {
      setAdd((current) => ({ way, requirements: { status: 'loading' }, markets: current?.markets ?? { status: 'loading' }, picked: current?.picked ?? [], reason: current?.reason ?? '', draft: current?.draft ?? EMPTY_REQUIREMENT, writing: IDLE }))
      readRequirements(api).then(
        (answer) => setAdd((current) => (current ? { ...current, requirements: { status: 'ready', value: answer.requirements } } : current)),
        () => setAdd((current) => (current ? { ...current, requirements: { status: 'error', problem: 'problem.read' } } : current)),
      )
      readMarkets(api, 'ALL').then(
        (answer) => setAdd((current) => (current ? { ...current, markets: { status: 'ready', value: answer.markets.map((market) => market.code) } } : current)),
        () => setAdd((current) => (current ? { ...current, markets: { status: 'error', problem: 'problem.read' } } : current)),
      )
    },
    [api],
  )
  useEffect(() => {
    if (!active || !address.add || !can.requirementsManage) {
      setAdd(null)
      return
    }
    if (!add) openAdd()
  }, [active, address.add, can.requirementsManage])

  /** Every changed row written: PATCH (gates, roles, days), then PUT switch; one at a time, refusals said. */
  const applyAll = async (reason: string | null) => {
    const changed = rows.filter((row) => gateChanged(row, drafts[row.requirement.code]))
    setWriting({ busy: true, problem: null })
    const result = await each(changed, async (row) => {
      const draft = drafts[row.requirement.code]!
      const moved = gateChangeOf(row, draft)
      let version = row.requirement.version
      if (moved.blocks || moved.roles || moved.days) {
        const answer = await guard('stepUp.loosen', () =>
          editRequirement(
            api,
            row.requirement.code,
            {
              version,
              ...(moved.blocks ? { blocks: COMPLIANCE_ORDER.filter((gate) => draft.blocks.includes(gate)) } : {}),
              ...(moved.roles ? { overrideRoleKeys: [...draft.overrideRoleKeys] } : {}),
              ...(moved.days ? { overrideMaxDays: draft.overrideMaxDays } : {}),
            },
            newIdempotencyKey(),
          ),
        )
        version = answer.requirement.version
      }
      if (moved.switched) {
        await guard('stepUp.loosen', () => switchRequirement(api, row.requirement.code, { version, on: draft.switchedOn, reason: draft.switchedOn ? null : reason }, newIdempotencyKey()))
      }
      setDrafts((current) => {
        const copy = { ...current }
        delete copy[row.requirement.code]
        return copy
      })
    })
    setLoosen(null)
    await read(true)
    if (result.refused.length > 0) {
      const first = result.refused[0]!
      setWriting({ busy: false, problem: { key: first.key, field: null } })
      notify({ tone: 'warning', key: 'notice.gatesPartly', params: { done: result.done, refused: result.refused.length, codes: result.refused.map((entry) => entry.item.requirement.code).join(', ') } })
    } else {
      setWriting(IDLE)
      notify({ tone: 'success', key: 'notice.gatesSaved', params: { count: result.done } })
    }
  }

  return {
    state: { matrix, drafts, selected, loosen, override, add, writing },
    actions: {
      onCell: (code, gate, blocks) => {
        const draft = draftOf(code)
        if (draft) put(code, { ...draft, blocks: blocks ? [...draft.blocks, gate] : draft.blocks.filter((entry) => entry !== gate) })
      },
      onSwitch: (code, on) => {
        const draft = draftOf(code)
        if (draft) put(code, { ...draft, switchedOn: on })
      },
      onSelected: setSelected,
      onBulkSwitch: (codes, on) => {
        for (const code of codes) {
          const row = rowOf(code)
          const draft = draftOf(code)
          if (row && draft && !switchHeld(row)) put(code, { ...draft, switchedOn: on })
        }
      },
      onOverride: (code) => {
        if (!code) return setOverride(null)
        const draft = draftOf(code)
        if (draft) setOverride({ code, roles: [...draft.overrideRoleKeys], days: draft.overrideMaxDays })
      },
      onOverrideDraft: (roles, days) => setOverride((current) => (current ? { ...current, roles, days } : current)),
      onOverrideKeep: () => {
        if (!override) return
        const draft = draftOf(override.code)
        if (draft) put(override.code, { ...draft, overrideRoleKeys: override.roles, overrideMaxDays: override.days })
        setOverride(null)
      },
      onDiscard: () => {
        setDrafts({})
        setWriting(IDLE)
      },
      onApply: () => {
        if (looseningsOf(rows, drafts).length > 0) setLoosen({ reason: '' })
        else void applyAll(null)
      },
      onReason: (reason) => setLoosen({ reason }),
      onConfirm: () => void applyAll(switchesOff(rows, drafts).length > 0 ? (loosen?.reason.trim() ?? '') : null),
      onCancel: () => {
        setLoosen(null)
        setWriting(IDLE)
      },
      onWriteW1: () => {
        setWriting({ busy: true, problem: null })
        writeW1(api, newIdempotencyKey()).then(
          (answer) => {
            setWriting(IDLE)
            notify({ tone: 'success', key: answer.created ? 'notice.w1Written' : 'notice.w1There' })
            void read(true)
          },
          (error) => setWriting(writingOf(error)),
        )
      },
      onAddWay: (way) => (add && add.requirements.status !== 'error' ? setAdd({ ...add, way, writing: IDLE }) : openAdd(way)),
      onAddPick: (codes) => setAdd((current) => (current ? { ...current, picked: codes, writing: IDLE } : current)),
      onAddReason: (reason) => setAdd((current) => (current ? { ...current, reason, writing: IDLE } : current)),
      onAddDraft: (draft) => setAdd((current) => (current ? { ...current, draft, writing: IDLE } : current)),
      onAddSave: () => {
        if (!add) return
        setAdd({ ...add, writing: { busy: true, problem: null } })
        const existing: Requirement[] = valueOf(add.requirements) ?? []
        const bodies = add.way === 'suggested' ? missingSuggestions(existing).filter((entry) => add.picked.includes(entry.code)).map((entry) => suggestionBody(entry, add.reason, locale)) : [requirementBodyOf(add.draft, locale)]
        void each(bodies, (body) => createRequirement(api, body, newIdempotencyKey()), 'create').then((result) => {
          void read(true)
          if (result.refused.length > 0) {
            const first = result.refused[0]!
            setAdd((current) => (current ? { ...current, writing: { busy: false, problem: { key: first.key, field: null } } } : current))
            if (result.done > 0) notify({ tone: 'warning', key: 'notice.requirementsPartly', params: { done: result.done, refused: result.refused.length } })
            return
          }
          notify({ tone: 'success', key: add.way === 'suggested' ? 'notice.suggestedAdded' : 'notice.requirementAdded', params: { count: result.done } })
          setAdd(null)
          context.go({ add: false })
        })
      },
      onRetry: () => void read(),
    },
  }
}

const COMPLIANCE_ORDER: readonly ComplianceGate[] = ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT']
