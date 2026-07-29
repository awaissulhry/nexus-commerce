'use client'

/**
 * AX3.3 — what comes across, Amazon's own copy-dialog pattern.
 *
 * Two of these are load-bearing rather than preferences. Turning OFF negatives
 * makes the new campaigns broader than the source, which is the opposite of what
 * "copy this structure" implies — so it says so. Turning off auto groups leaves
 * an Auto campaign with nothing to target, which is exactly the defect AX3.0
 * fixed, so it says that too.
 */
import { AlertTriangle } from 'lucide-react'
import { COPY_ITEMS, type CopyScope } from './replicate-types'

export function CopyScopePanel({ scope, setScope }: { scope: CopyScope; setScope: (s: CopyScope) => void }) {
  const off = COPY_ITEMS.filter((i) => !scope[i.key])
  return (
    <div className="h10-spw-card h10-rep-scope">
      <div className="grid">
        {COPY_ITEMS.map((i) => (
          <label className={`item ${scope[i.key] ? 'on' : ''}`} key={i.key}>
            <input
              type="checkbox"
              checked={scope[i.key]}
              onChange={() => setScope({ ...scope, [i.key]: !scope[i.key] })}
              aria-label={i.label}
            />
            <span className="t">
              <b>{i.label}</b>
              <span className="h">{i.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {!scope.negatives && (
        <p className="h10-rep-scope-warn">
          <AlertTriangle size={13} aria-hidden />
          Without the negatives the copies are <b>broader</b> than the source — they will buy traffic the original pays to avoid.
        </p>
      )}
      {!scope.autoClauses && (
        <p className="h10-rep-scope-warn">
          <AlertTriangle size={13} aria-hidden />
          Any Auto campaign in the source will be created with <b>no targeting at all</b> and can never run.
        </p>
      )}
      {off.length > 0 && (
        <p className="h10-rep-scope-note">Excluded: {off.map((i) => i.label.toLowerCase()).join(', ')}. The preflight will restate this before anything is created.</p>
      )}
    </div>
  )
}
