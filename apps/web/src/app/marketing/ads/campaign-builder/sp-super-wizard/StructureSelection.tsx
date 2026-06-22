'use client'

/**
 * SPW.2 — Structure selection (Helium 10 match). Standard (5 campaigns) and
 * Advanced (11 campaigns) render a visual structure diagram: the ASIN → a chunky
 * arrow → rows of [Campaign · AdGroup · Match Type · Keyword Type] joined by dotted
 * connectors, with a Rule Based / AI Control automation toggle spanning the rows.
 * Custom Scheme (the naming-rule builder) lands in SPW.3.
 */
import { type Dispatch, type SetStateAction, Fragment } from 'react'
import { Atom } from 'lucide-react'
import { CustomScheme, type CustomKeywordType, type TargetingKind } from './CustomScheme'
import { InfoTip } from '../../campaigns/InfoTip'

export type StructureMode = 'standard' | 'advanced' | 'custom'
export type AutomationMode = 'rule' | 'ai'
export type StructureRow = { c: string; a: string; m: string; k: string }

const KW = ['Brand', 'Competitor', 'Category']

export function standardRows(): StructureRow[] {
  const base = [{ m: 'Auto', k: '-' }, ...KW.map((k) => ({ m: 'Broad & Phrase & Exact', k })), { m: 'PAT', k: '-' }]
  return base.map((r, i) => ({ ...r, c: `Campaign ${i + 1}`, a: `AdGroup ${i + 1}` }))
}
export function advancedRows(): StructureRow[] {
  const rows: Array<{ m: string; k: string }> = [{ m: 'Auto', k: '-' }]
  for (const m of ['Broad', 'Phrase', 'Exact']) for (const k of KW) rows.push({ m, k })
  rows.push({ m: 'PAT', k: '-' })
  return rows.map((r, i) => ({ ...r, c: `Campaign ${i + 1}`, a: `AdGroup ${i + 1}` }))
}

function StructureArrow() {
  return (
    <svg width="44" height="34" viewBox="0 0 44 34" fill="none" aria-hidden>
      <defs><linearGradient id="spwarrow" x1="0" y1="0" x2="44" y2="0"><stop offset="0" stopColor="#7cc0f5" /><stop offset="1" stopColor="#1f8de0" /></linearGradient></defs>
      <path d="M2 13h22V5l18 12-18 12v-8H2z" fill="url(#spwarrow)" />
    </svg>
  )
}

function AsinBox({ image }: { image: string | null }) {
  return (
    <div className="h10-spw-st-asin">
      <div className="box">
        {image ? <img src={image} alt="" /> : <span className="ph" />}
        <span className="tag">
          <svg viewBox="0 0 28 16" width="26" height="15" aria-hidden><text x="3" y="12" fontSize="12" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">a</text><path d="M3 13c3.4 2 7.6 2 10.8-.2" stroke="#ff9900" strokeWidth="1.3" fill="none" strokeLinecap="round" /></svg>
        </span>
      </div>
    </div>
  )
}

function StructureDiagram({ rows, asinImage, automationMode, setAutomationMode, aiDisabled }: {
  rows: StructureRow[]
  asinImage: string | null
  automationMode: AutomationMode
  setAutomationMode: (m: AutomationMode) => void
  aiDisabled?: boolean
}) {
  const span = `2 / span ${rows.length}`
  return (
    <div
      className="h10-spw-st-grid"
      style={{ gridTemplateColumns: '128px 52px minmax(92px,1fr) 26px minmax(92px,1fr) 26px minmax(150px,1.35fr) 26px minmax(86px,1fr) 152px' }}
    >
      <span className="hd" style={{ gridColumn: 1, gridRow: 1 }}>ASIN</span>
      <span className="hd" style={{ gridColumn: 3, gridRow: 1 }}>Campaign</span>
      <span className="hd" style={{ gridColumn: 5, gridRow: 1 }}>AdGroup</span>
      <span className="hd" style={{ gridColumn: 7, gridRow: 1 }}>Match Type</span>
      <span className="hd" style={{ gridColumn: 9, gridRow: 1 }}>Keyword Type</span>
      <span className="hd am" style={{ gridColumn: 10, gridRow: 1 }}>Automation Mode</span>

      <div style={{ gridColumn: 1, gridRow: span, alignSelf: 'center', justifySelf: 'center' }}><AsinBox image={asinImage} /></div>
      <div style={{ gridColumn: 2, gridRow: span, alignSelf: 'center', justifySelf: 'center' }}><StructureArrow /></div>

      {rows.map((r, i) => {
        const gr = i + 2
        return (
          <Fragment key={i}>
            <span className="cell" style={{ gridColumn: 3, gridRow: gr }}>{r.c}</span>
            <span className="conn" style={{ gridColumn: 4, gridRow: gr }} />
            <span className="cell" style={{ gridColumn: 5, gridRow: gr }}>{r.a}</span>
            <span className="conn" style={{ gridColumn: 6, gridRow: gr }} />
            <span className="pill mt" style={{ gridColumn: 7, gridRow: gr }}>{r.m}</span>
            <span className="conn" style={{ gridColumn: 8, gridRow: gr }} />
            <span className={`pill kw ${r.k === '-' ? 'none' : ''}`} style={{ gridColumn: 9, gridRow: gr }}>{r.k}</span>
          </Fragment>
        )
      })}

      <div className="h10-spw-st-am" style={{ gridColumn: 10, gridRow: span, alignSelf: 'center' }}>
        <div className="h10-spw-st-toggle" role="group" aria-label="Automation Mode">
          <button type="button" className={automationMode === 'rule' ? 'on' : ''} onClick={() => setAutomationMode('rule')}>Rule Based</button>
          <button type="button" className={`ai ${automationMode === 'ai' ? 'on' : ''}`} disabled={aiDisabled} onClick={() => !aiDisabled && setAutomationMode('ai')} title={aiDisabled ? 'Custom scheme does not support AI control' : undefined}>
            <Atom size={13} /> AI Control
          </button>
        </div>
      </div>
    </div>
  )
}

export function StructureSelection({ mode, setMode, automationMode, setAutomationMode, asinImage, customKeywordTypes, setCustomKeywordTypes, customTargetingTypes, setCustomTargetingTypes, customNameTokens, setCustomNameTokens, previewNames, remember, setRemember, autoNegate, setAutoNegate }: {
  mode: StructureMode
  setMode: (m: StructureMode) => void
  automationMode: AutomationMode
  setAutomationMode: (m: AutomationMode) => void
  asinImage: string | null
  customKeywordTypes: CustomKeywordType[]
  setCustomKeywordTypes: Dispatch<SetStateAction<CustomKeywordType[]>>
  customTargetingTypes: TargetingKind[]
  setCustomTargetingTypes: Dispatch<SetStateAction<TargetingKind[]>>
  customNameTokens: string[]
  setCustomNameTokens: Dispatch<SetStateAction<string[]>>
  previewNames: string[]
  remember: boolean
  setRemember: (v: boolean) => void
  autoNegate: boolean
  setAutoNegate: (v: boolean) => void
}) {
  const TABS: Array<{ key: StructureMode; label: string }> = [
    { key: 'standard', label: 'Standard' },
    { key: 'advanced', label: 'Advanced' },
    { key: 'custom', label: 'Custom Scheme' },
  ]
  return (
    <div className="h10-spw-card h10-spw-st-card">
      <div className="h10-spw-st-tabs" role="tablist" aria-label="Structure mode">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={mode === t.key} className={mode === t.key ? 'on' : ''} onClick={() => setMode(t.key)}>{t.label}</button>
        ))}
      </div>
      {mode === 'custom' ? (
        <CustomScheme keywordTypes={customKeywordTypes} setKeywordTypes={setCustomKeywordTypes} targetingTypes={customTargetingTypes} setTargetingTypes={setCustomTargetingTypes} nameTokens={customNameTokens} setNameTokens={setCustomNameTokens} previewNames={previewNames} remember={remember} setRemember={setRemember} />
      ) : (
        <div className="h10-spw-st-panel">
          <div className="h10-spw-st-title">Structure</div>
          <StructureDiagram rows={mode === 'advanced' ? advancedRows() : standardRows()} asinImage={asinImage} automationMode={automationMode} setAutomationMode={setAutomationMode} />
        </div>
      )}

      <div className="h10-spw-st-auto">
        <label className="sw">
          <input type="checkbox" className="h10-spw-sw" checked={autoNegate} onChange={(e) => setAutoNegate(e.target.checked)} aria-label="Auto-negate to isolate campaigns" />
          <span className="t">Auto-negate to isolate campaigns</span>
          <InfoTip tip="Adds ad-group-level negatives so each search term serves from one campaign — Exact gets none, Phrase neg-exacts its keywords, Broad neg-exacts + neg-phrases them, and the Auto campaign neg-exacts every keyword so it only finds new terms. All editable per campaign in Step 2." />
        </label>
        <span className="h">{mode === 'standard'
          ? 'Standard combines match types, so this only isolates the Auto campaign from your keywords.'
          : 'Each search term serves from exactly one campaign — no self-competition, cleaner data.'}</span>
      </div>
    </div>
  )
}
