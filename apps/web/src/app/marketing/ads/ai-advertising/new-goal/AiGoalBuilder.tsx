'use client'

/**
 * CBN — AI Advertising · New Product Goal (the "AI Goal" campaign builder), matched
 * to Helium 10 Ads. Full-screen takeover (own top bar; the ads rail is covered).
 * Reuses the shared `.h10-*` design system + builder icons. Reached from the
 * Campaign Builder "AI Goal" card and the AI Advertising landing.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Video, Plus, Search, Trash2, Users, Target, Layers } from 'lucide-react'
import { IconAtom, IconEye, IconBars, IconLine } from '../../_shell/builder-icons'

type TargetKey = 'impression' | 'sales' | 'roas'
type BudgetMode = 'strict' | 'shared'

const TARGETS: Array<{ key: TargetKey; title: string; Icon: typeof IconEye; bestFor: string; desc: string }> = [
  { key: 'impression', title: 'Impression & Click', Icon: IconEye, bestFor: 'New Products', desc: 'This strategy aims to increase impressions and clicks. It is suitable for new products that require traffic.' },
  { key: 'sales', title: 'Sales', Icon: IconBars, bestFor: 'Gross Revenue', desc: 'This strategy aims to increase orders and sales. It is suitable for products that require orders or clearing inventory.' },
  { key: 'roas', title: 'ROAS', Icon: IconLine, bestFor: 'Most Scenarios', desc: 'This strategy emphasizes an adjustment mode focused on ROAS/ACOS and is suitable for most scenarios.' },
]

const BUDGET_MODES: Array<{ key: BudgetMode; title: string; Icon: typeof Target; desc: string; audience: string; chips: string[] }> = [
  { key: 'strict', title: 'Strict Control', Icon: Target, desc: 'Individual products have independent budgets. AI will create a campaign for each ASIN.', audience: 'Experienced Advertisers | Specialized Campaigns', chips: ['Precision Control', 'Budget Safeguarding', 'Data-Driven', 'Scalability'] },
  { key: 'shared', title: 'Shared Budget', Icon: Layers, desc: 'Users allocate a single budget that is shared across multiple selected products managed by AI.', audience: 'New Advertisers', chips: ['Simplified Management', 'Dynamic Allocation', 'Time-Efficiency'] },
]

export function AiGoalBuilder() {
  const router = useRouter()
  const [goalName, setGoalName] = useState('')
  const [target, setTarget] = useState<TargetKey>('impression')
  const [budgetMode, setBudgetMode] = useState<BudgetMode>('strict')
  const [totalBudget, setTotalBudget] = useState('')
  const [excludeText, setExcludeText] = useState('')
  const [excluded, setExcluded] = useState<string[]>([])
  const [showAddProducts, setShowAddProducts] = useState(false)
  const exitTo = '/marketing/ads/campaign-builder'

  const addExcluded = () => {
    const toks = excludeText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    if (!toks.length) return
    setExcluded((prev) => Array.from(new Set([...prev, ...toks])).slice(0, 10))
    setExcludeText('')
  }

  return (
    <div className="h10-aig">
      {/* top bar */}
      <header className="h10-aig-top">
        <button type="button" className="x" onClick={() => router.push(exitTo)} aria-label="Close"><X size={20} /></button>
        <span className="brand"><IconAtom size={22} /> AI Advertising</span>
        <span className="sep" />
        <span className="crumb">New Product Goal</span>
        <span className="grow" />
        <button type="button" className="learn"><Video size={15} /> Learn</button>
        <button type="button" className="launch" disabled>Launch</button>
      </header>

      <div className="h10-aig-body">
        <div className="h10-aig-wrap">

          {/* Product Goal Details */}
          <section className="h10-aig-sec">
            <h2>Product Goal Details</h2>
            <div className="h10-aig-card">
              <label className="h10-aig-field">
                <span className="lbl">Goal Name <i className="req">*</i></span>
                <input value={goalName} onChange={(e) => setGoalName(e.target.value)} placeholder="Enter a goal name" />
              </label>
            </div>
          </section>

          {/* Select AI Target */}
          <section className="h10-aig-sec">
            <h2>Select AI Target</h2>
            <div className="h10-aig-targets">
              {TARGETS.map((t) => (
                <button type="button" key={t.key} className={`h10-aig-target ${target === t.key ? 'on' : ''}`} onClick={() => setTarget(t.key)}>
                  <span className="ic"><t.Icon size={26} /></span>
                  <span className="ttl">{t.title}</span>
                  <span className="bf">Best for <b>{t.bestFor}</b></span>
                  <span className="desc">{t.desc}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Product Setup */}
          <section className="h10-aig-sec">
            <h2>Product Setup</h2>
            <div className="h10-aig-card">

              <div className="h10-aig-sub">
                <h3>Budget Mode</h3>
                <p>Select a Budget mode based on the application scenario</p>
                <div className="h10-aig-budget">
                  {BUDGET_MODES.map((b) => (
                    <button type="button" key={b.key} className={`h10-aig-bcard ${budgetMode === b.key ? 'on' : ''}`} onClick={() => setBudgetMode(b.key)}>
                      <span className="bh"><span className="bic"><b.Icon size={18} /></span><span className="bt">{b.title}</span></span>
                      <span className="bd">{b.desc}</span>
                      <span className="ba"><Users size={13} /> {b.audience}</span>
                      <span className="bchips">{b.chips.map((c) => <span className={`chip ${budgetMode === b.key ? 'on' : ''}`} key={c}>{c}</span>)}</span>
                    </button>
                  ))}
                </div>
              </div>

              {budgetMode === 'shared' && (
                <div className="h10-aig-sub">
                  <h3>Total Budget</h3>
                  <span className="h10-aig-money"><span className="pf">€</span><input inputMode="decimal" value={totalBudget} onChange={(e) => setTotalBudget(e.target.value)} placeholder="Please enter" /></span>
                </div>
              )}

              <div className="h10-aig-sub">
                <h3>Product Selection</h3>
                <p>Select products for AI Advertising to manage</p>
                <div className="h10-aig-pselbar">
                  <span className="cnt">0 Product Added</span>
                  <span className="grow" />
                  <button type="button" className="h10-am-btn" disabled><Trash2 size={13} /> Remove All</button>
                  <button type="button" className="h10-am-btn primary" onClick={() => setShowAddProducts(true)}><Plus size={13} /> Add Products</button>
                </div>
                <div className="h10-aig-psel">
                  <div className="psel-head"><span className="c-prod">Product</span><span className="c-lqs">LQS</span></div>
                  <div className="psel-empty">
                    <ProductsEmptyArt />
                    <div className="t">No Product Added</div>
                    <button type="button" className="h10-am-btn sm" onClick={() => setShowAddProducts(true)}><Plus size={13} /> Add Products</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Keywords */}
          <section className="h10-aig-sec">
            <h2>Keywords</h2>
            <div className="h10-aig-card">
              <div className="h10-aig-sub">
                <h3 className="dot green">Add Seed Keywords</h3>
                <div className="h10-aig-kw-empty">
                  <ProductsEmptyArt />
                  <div className="t">Select a product above to add keywords to this product goal.</div>
                </div>
              </div>
              <div className="h10-aig-sub">
                <h3 className="dot purple">Exclude Keywords</h3>
                <p>Exclude specific search terms from triggering your ads to avoid irrelevant traffic and reduce costs.</p>
                <div className="h10-aig-kwgrid">
                  <div className="kw-enter">
                    <textarea value={excludeText} onChange={(e) => setExcludeText(e.target.value)} onBlur={addExcluded} placeholder="Enter keywords you do not want to target" />
                  </div>
                  <div className="kw-added">
                    <div className="kw-added-h"><span>{excluded.length}/10 Added</span><button type="button" className="rm" onClick={() => setExcluded([])} disabled={!excluded.length}><Trash2 size={12} /> Remove All</button></div>
                    <div className="kw-added-col">Keyword</div>
                    {excluded.length === 0 ? (
                      <div className="kw-added-empty"><ProductsEmptyArt /></div>
                    ) : (
                      <ul className="kw-added-list">{excluded.map((k) => <li key={k}>{k}<button type="button" onClick={() => setExcluded((p) => p.filter((x) => x !== k))} aria-label={`Remove ${k}`}><X size={12} /></button></li>)}</ul>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Advanced Targeting */}
          <section className="h10-aig-sec">
            <h2>Advanced Targeting</h2>
            <div className="h10-aig-card adv">
              <p className="adv-note">Set a single keyword count for the maximum number of related keywords to expand each product goal. The AI will continuously optimize within this range to find the best-performing keywords.</p>
            </div>
          </section>

        </div>
      </div>

      {showAddProducts && <AddProductsModal onClose={() => setShowAddProducts(false)} />}
    </div>
  )
}

/** Empty-state illustration (magnifier over a sheet) used by Product Selection + Keywords. */
function ProductsEmptyArt() {
  return (
    <svg className="h10-aig-emptyart" viewBox="0 0 80 64" fill="none" aria-hidden>
      <rect x="14" y="10" width="38" height="46" rx="3" fill="#eef2f7" />
      <rect x="20" y="18" width="26" height="3" rx="1.5" fill="#d4dce6" />
      <rect x="20" y="26" width="26" height="3" rx="1.5" fill="#d4dce6" />
      <rect x="20" y="34" width="18" height="3" rx="1.5" fill="#d4dce6" />
      <circle cx="50" cy="40" r="13" fill="#fff" stroke="#c2cdda" strokeWidth="2.5" />
      <line x1="59" y1="49" x2="66" y2="56" stroke="#c2cdda" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/** Add Products to Product Selection — structure matched to H10; product search wired in a follow-up. */
function AddProductsModal({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal aig-add" ref={ref} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add Products to Product Selection">
        <div className="h10-modal-h"><b>Add Products to Product Selection</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-b">
          <div className="aig-add-search"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by product name, ASIN or SKU" /></div>
          <div className="aig-add-grid">
            <div className="aig-add-list">
              <div className="psel-empty"><ProductsEmptyArt /><div className="t">No products</div></div>
            </div>
            <div className="aig-add-sel">
              <div className="aig-add-selh">Product Added</div>
              <div className="psel-empty"><ProductsEmptyArt /><div className="t">No Product Added</div></div>
            </div>
          </div>
        </div>
        <div className="h10-modal-f"><button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button><span className="grow" /><button type="button" className="h10-am-btn primary" onClick={onClose}>Add</button></div>
      </div>
    </div>
  )
}
