'use client'

/**
 * AqlCounter — the sample counter of a final inspection (gap G6, SCR-097, QHS-058): how many pieces of the sample are
 * inspected, the defects found per class against its accept and reject numbers, and the verdict as it stands.
 *
 *   <AqlCounter label="AQL 2,5 · livello II" sampleSize={50} inspected={n} onInspectedChange={setN}
 *               classes={[{ id: 'major', label: 'Maggiori', accept: 3, defects: 1 }, …]} onDefectsChange={setDefects}
 *               inspectedLabel="Ispezionati" sampleLabel={(i, n) => `${i} di ${n}`} thresholdLabel={(ac, re) => `Ac ${ac} · Re ${re}`}
 *               verdictLabels={{ open: 'In corso', accept: 'Accettato', reject: 'Rifiutato' }} … />
 *
 * - Single sampling (`aqlModel.ts`): a class at its reject number rejects the lot at once; the lot is accepted only
 *   when the whole sample is inspected with every class at or under its accept number. The app gives the plan.
 * - Glanceable: the inspected count as a big numeral over the sample size, a bar, the verdict as icon + word in its
 *   tone (colour never alone), and one row per class with its own big count, − and +.
 * - The "+ one piece" button is the main action (primary, with words); − buttons are held at zero, + inspected at the
 *   sample size — focusable and announced with their reason. A polite live region says each change.
 * - Every word comes from the app. Signing the result is the PIN pad's job (G4), not this counter's.
 */
import { useId, useState, type CSSProperties } from 'react'
import { Check, Minus, OctagonX, Plus, TriangleAlert } from 'lucide-react'

import { FloorButton } from '../FloorButton'
import { aqlClassState, aqlCount, aqlProgress, aqlRejectAt, aqlVerdict, type AqlClass, type AqlClassState, type AqlVerdict } from './aqlModel'
import '../floor.css'
import './aqlCounter.css'

export interface AqlCounterProps {
  /** The plan in words ("AQL 2,5 · livello II · n 50"). */
  label: string
  /** n: the pieces to inspect. */
  sampleSize: number
  /** Pieces inspected so far. */
  inspected: number
  onInspectedChange: (inspected: number) => void
  /** Defect classes, most severe first, each with its accept number Ac. */
  classes: readonly AqlClass[]
  onDefectsChange: (classId: string, defects: number) => void
  /** "Ispezionati" — the inspected count's name. */
  inspectedLabel: string
  /** (23, 50) => "23 di 50" — the count in words for a screen reader. */
  sampleLabel: (inspected: number, sampleSize: number) => string
  /** (3, 4) => "Accetta fino a 3 · rifiuta da 4". */
  thresholdLabel: (accept: number, reject: number) => string
  verdictLabels: { readonly [V in AqlVerdict]: string }
  /** A word per class state ("Al limite"), shown beside the class. Optional: the icon and tone always show. */
  classStateLabels?: { readonly [S in AqlClassState]?: string }
  /** "Pezzo controllato" — the main + button. */
  addInspectedLabel: string
  /** "Togli un pezzo". */
  removeInspectedLabel: string
  /** ("Maggiori") => "Un difetto maggiore in più". */
  addDefectLabel: (classLabel: string) => string
  /** ("Maggiori") => "Un difetto maggiore in meno". */
  removeDefectLabel: (classLabel: string) => string
  /** Why + is held when the sample is done ("Campione completo"). */
  sampleDoneLabel: string
  /** Why − is held at zero ("Già a zero"). */
  nothingToRemoveLabel: string
  id?: string
}

const VERDICT_ICON = { open: null, accept: <Check />, reject: <OctagonX /> } as const
const STATE_ICON = { ok: <Check />, limit: <TriangleAlert />, reject: <OctagonX /> } as const

export function AqlCounter({
  label,
  sampleSize,
  inspected,
  onInspectedChange,
  classes,
  onDefectsChange,
  inspectedLabel,
  sampleLabel,
  thresholdLabel,
  verdictLabels,
  classStateLabels,
  addInspectedLabel,
  removeInspectedLabel,
  addDefectLabel,
  removeDefectLabel,
  sampleDoneLabel,
  nothingToRemoveLabel,
  id,
}: AqlCounterProps) {
  const labelId = useId()
  const [said, setSaid] = useState('')
  const n = aqlCount(sampleSize)
  const done = aqlCount(inspected, n)
  const verdict = aqlVerdict({ sampleSize: n, inspected: done, classes })

  const setInspected = (next: number) => {
    const value = aqlCount(next, n)
    setSaid(sampleLabel(value, n))
    onInspectedChange(value)
  }
  const setDefects = (cls: AqlClass, next: number) => {
    const value = aqlCount(next)
    setSaid(`${cls.label} ${value}`)
    onDefectsChange(cls.id, value)
  }

  return (
    <section id={id} className="nds-floor-aql" aria-labelledby={labelId} data-verdict={verdict}>
      <div className="nds-floor-aql-head">
        <div id={labelId} className="nds-floor-aql-title">
          {label}
        </div>
        <span className="nds-floor-aql-verdict" data-verdict={verdict} role="status">
          {VERDICT_ICON[verdict] ? (
            <span className="nds-floor-icon" aria-hidden>
              {VERDICT_ICON[verdict]}
            </span>
          ) : null}
          {verdictLabels[verdict]}
        </span>
      </div>

      <div className="nds-floor-aql-sample">
        <div className="nds-floor-aql-count">
          <span className="nds-floor-aql-name">{inspectedLabel}</span>
          <span className="nds-floor-aql-numeral" aria-hidden>
            {done}
            <span className="nds-floor-aql-of"> / {n}</span>
          </span>
          <span className="nds-floor-sr">{sampleLabel(done, n)}</span>
          <span className="nds-floor-aql-bar" aria-hidden>
            <span className="nds-floor-aql-bar-fill" style={{ '--nds-aql-done': aqlProgress(n, done) } as CSSProperties} />
          </span>
        </div>
        <div className="nds-floor-aql-sample-actions">
          <FloorButton
            size="lg"
            icon={<Minus />}
            aria-label={removeInspectedLabel}
            heldReason={done === 0 ? nothingToRemoveLabel : null}
            onClick={() => setInspected(done - 1)}
          />
          <FloorButton size="lg" variant="primary" icon={<Plus />} heldReason={done >= n ? sampleDoneLabel : null} onClick={() => setInspected(done + 1)}>
            {addInspectedLabel}
          </FloorButton>
        </div>
      </div>

      <ul className="nds-floor-aql-classes">
        {classes.map((cls) => {
          const state = aqlClassState(cls)
          const defects = aqlCount(cls.defects)
          const word = classStateLabels?.[state]
          return (
            <li key={cls.id} className="nds-floor-aql-class" data-state={state}>
              <span className="nds-floor-icon nds-floor-aql-class-icon" aria-hidden>
                {STATE_ICON[state]}
              </span>
              <span className="nds-floor-aql-class-text">
                <span className="nds-floor-aql-class-name">{cls.label}</span>
                <span className="nds-floor-aql-class-meta">{thresholdLabel(aqlCount(cls.accept), aqlRejectAt(cls))}</span>
              </span>
              {word ? <span className="nds-floor-aql-class-status">{word}</span> : null}
              <span className="nds-floor-aql-class-count">
                <FloorButton
                  icon={<Minus />}
                  aria-label={removeDefectLabel(cls.label)}
                  heldReason={defects === 0 ? nothingToRemoveLabel : null}
                  onClick={() => setDefects(cls, defects - 1)}
                />
                <span className="nds-floor-aql-class-number">{defects}</span>
                <FloorButton icon={<Plus />} aria-label={addDefectLabel(cls.label)} onClick={() => setDefects(cls, defects + 1)} />
              </span>
            </li>
          )
        })}
      </ul>
      <span className="nds-floor-sr" aria-live="polite" aria-atomic="true">
        {said}
      </span>
    </section>
  )
}
