'use client'

/**
 * AX3.3 — the bulk rename, with every old → new name on screen.
 *
 * Renaming is not cosmetic here. Most of this account's campaign names do not
 * contain the product token, so substituting the product alone leaves the name
 * byte-identical and the replication is blocked as a duplicate. This panel is
 * where that gets fixed, and the preview is where the operator sees it worked
 * — before the plan, not after it.
 *
 * Three tools, in the order they apply: swap the product token, find-and-replace
 * (Google Ads Editor's move, and the one that fixes an entire convention at
 * once), then a prefix and suffix.
 */
import { Plus, Trash2, AlertTriangle, Wand2 } from 'lucide-react'
import { Button } from '@/design-system/primitives'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import { applyNamingLocal, retoken, type NamingRules } from './replicate-types'

export function NamingPanel({
  sourceToken, setSourceToken, targetToken, setTargetToken, naming, setNaming, sourceNames, guessed, liveNames,
}: {
  sourceToken: string; setSourceToken: (v: string) => void
  targetToken: string; setTargetToken: (v: string) => void
  naming: NamingRules; setNaming: (n: NamingRules) => void
  sourceNames: string[]
  guessed: string
  /** Campaign names already live in the destination market, for the collision flag. */
  liveNames: Set<string>
}) {
  const preview = sourceNames.map((from) => ({
    from,
    to: applyNamingLocal(retoken(from, sourceToken, targetToken), naming),
  }))
  const seen = new Map<string, number>()
  for (const p of preview) seen.set(p.to.toLowerCase(), (seen.get(p.to.toLowerCase()) ?? 0) + 1)
  const clash = (to: string) => liveNames.has(to.toLowerCase()) || (seen.get(to.toLowerCase()) ?? 0) > 1
  const clashes = preview.filter((p) => clash(p.to)).length
  const unchanged = preview.filter((p) => p.from === p.to).length

  const setRep = (i: number, patch: Partial<{ from: string; to: string }>) =>
    setNaming({ ...naming, replacements: naming.replacements.map((r, j) => (j === i ? { ...r, ...patch } : r)) })

  return (
    <div className="h10-spw-card h10-rep-naming">
      <div className="h10-rep-tokens">
        <label className="h10-spw-field">
          <span className="lbl">Product in the source names</span>
          <input value={sourceToken} onChange={(e) => setSourceToken(e.target.value)} placeholder="AIREON" aria-label="Source product token" />
          {guessed && guessed !== sourceToken && (
            <span className="h10-rep-guesswrap"><Button variant="ghost" size="sm" onClick={() => setSourceToken(guessed)}>
              <Wand2 size={12} aria-hidden /> Use “{guessed}” — found in most of the selected names
            </Button></span>
          )}
          <span className="hint">Removed from every name and keyword, then replaced below.</span>
        </label>
        <span className="h10-rep-arrow" aria-hidden>→</span>
        <label className="h10-spw-field">
          <span className="lbl">Product it becomes <i className="req">*</i></span>
          <input value={targetToken} onChange={(e) => setTargetToken(e.target.value)} placeholder="VENTRA" aria-label="New product token" />
          <span className="hint">Also replaces the brand keywords, so “giacca aireon” becomes “giacca ventra”.</span>
        </label>
      </div>

      <div className="h10-rep-namerow">
        <label className="h10-spw-field sm">
          <span className="lbl">Prefix</span>
          <input value={naming.prefix} onChange={(e) => setNaming({ ...naming, prefix: e.target.value })} placeholder="e.g. Q1-" aria-label="Name prefix" />
        </label>
        <label className="h10-spw-field sm">
          <span className="lbl">Suffix</span>
          <input value={naming.suffix} onChange={(e) => setNaming({ ...naming, suffix: e.target.value })} placeholder="e.g. -v2" aria-label="Name suffix" />
        </label>
      </div>

      <div className="h10-rep-reps">
        <span className="lbl">Find and replace</span>
        {naming.replacements.map((r, i) => (
          <div className="row" key={i}>
            <input value={r.from} onChange={(e) => setRep(i, { from: e.target.value })} placeholder="find" aria-label={`Find text ${i + 1}`} />
            <span className="arr" aria-hidden>→</span>
            <input value={r.to} onChange={(e) => setRep(i, { to: e.target.value })} placeholder="replace with" aria-label={`Replace with ${i + 1}`} />
            <button type="button" className="del" onClick={() => setNaming({ ...naming, replacements: naming.replacements.filter((_, j) => j !== i) })} aria-label={`Remove replacement ${i + 1}`}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <span><Button variant="link" size="sm" onClick={() => setNaming({ ...naming, replacements: [...naming.replacements, { from: '', to: '' }] })}>
          <Plus size={13} aria-hidden /> Add a replacement
        </Button></span>
      </div>

      <div className="h10-rep-preview">
        <div className="hd">
          <b>Every campaign, renamed</b>
          {clashes > 0 && (
            <span className="bad"><AlertTriangle size={13} aria-hidden /> {clashes} name{clashes === 1 ? '' : 's'} already taken or duplicated — these will block the launch</span>
          )}
          {clashes === 0 && unchanged > 0 && (
            <span className="warn"><AlertTriangle size={13} aria-hidden /> {unchanged} name{unchanged === 1 ? '' : 's'} unchanged — add a prefix or a replacement</span>
          )}
        </div>
        <div className="rows">
          {preview.length === 0 && <div className="none">Select a source first.</div>}
          {preview.map((p, i) => (
            <div className={`row ${clash(p.to) ? 'bad' : p.from === p.to ? 'same' : ''}`} key={i}>
              <span className="from" title={p.from}>{p.from}</span>
              <span className="arr" aria-hidden>→</span>
              <span className="to" title={p.to}>{p.to}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
