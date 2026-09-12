'use client'

/**
 * FX.1 — /design/formula-lab. The cell states for Owner D16 (formulas), mocked for review.
 *
 * WHAT THIS IS. Wave-4 §1.3 describes the formula UX in six prose steps and no lane owned a
 * drawing of it. The Owner's words on this item were "the UI has to be absolutely pinnacle, and
 * also the UX. I would not compromise at all on it" — so the states get looked at before they get
 * built. PES.2/AG.1 build the real editor and the real mark FROM this page; nothing here is
 * product code and nothing here is imported by a product surface.
 *
 * 🔴 WHAT IS REAL AND WHAT IS DRAWN — the whole value of this page depends on the reader knowing
 * which is which, so it is also stated on the page itself, not only here:
 *   REAL   the provenance tints and mark styling come from the engine's own
 *          `design-system/grid/theme/grid.css`, imported below. `.nds-cell-is-pinned`,
 *          `.nds-cell-is-ai-draft` and the `.nds-cell-prov*` colours are whatever the engine
 *          says they are today — if they change, this page changes with them.
 *   REAL   the `$` autocomplete is the DS `ListboxPanel` (#484) driven by an EXTERNAL query,
 *          which is the mode its own docstring says was added for this exact editor.
 *   DRAWN  the cell BOX (height, padding, border). AG's stylesheet is not loaded here — importing
 *          `ag-grid-*` outside `design-system/grid/` and `app/design/grid-lab/` is a guard
 *          violation (`check-ag-grid-import-boundary.mjs`), and this page does not need a grid to
 *          show a cell. The box is a token-built approximation; the MARKS on it are real.
 *   DRAWN  the `ƒ` mark itself. `CellProvenance` is eight members today and `formula` is not one
 *          of them (`renderers/provenance.ts:49`). Adding it is PES.2's, so this page draws the
 *          proposal rather than editing the engine to make its own mock true.
 *   MOCK   the preview line evaluates LOCALLY over a fixed attribute map. The real editor calls
 *          `POST /api/pim/formulas/preview`, which exists and is live. Labelled on the page.
 *
 * Refs: `docs/2026-09-02-wave4-design.md` §1.2 (D16.1–D16.8), §1.3 (the six steps, whose wording
 * this page quotes verbatim), §1.6 (A)–(H) (the ratified corrections), §9.6/§9.6b (the mark
 * vocabulary and the bar for minting a member).
 */
import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, Link2, Pencil, Share2, Sigma, Sparkles } from 'lucide-react'

import { Button, Input, Pill, SegmentedControl } from '@/design-system/primitives'
import { ListboxPanel } from '@/design-system/components/ListboxPanel'
import type { ListboxOption } from '@/design-system/components/Listbox'

// The engine's own stylesheet — so every tint and mark colour on this page is the shipped one.
import '@/design-system/grid/theme/grid.css'
// Page-local type classes that read the DS tokens. See the file header: the DS ships no type
// classes, so there is nowhere else for a size to live. Two sizes are off-scale and flagged there.
import s from './formula-lab.module.css'

// ── the row this page is about ──────────────────────────────────────────────────────────────
// GALE-JACKET's real master values (`app/design/grid-lab/sheetFixture.ts`), plus the
// `athlete_type` §1.3's worked example uses. Kept tiny and local: the point of this page is the
// cell states, not a data set.
const ATTRS: Record<string, string> = {
  brand: 'XAVIA',
  athlete_type: 'Motorcyclist',
  product_type: 'Giacca Da Moto',
  gender: 'Men',
  outerMaterial: 'Cordura',
  protectionLevel: 'CE Level 2',
  season: 'All season',
  countryOfOrigin: 'PK',
}

/** `$brand — Brand`: the key is what the operator types, the English label is how they find it. */
const COLUMN_OPTIONS: ListboxOption[] = [
  { value: 'brand', label: '$brand — Brand' },
  { value: 'athlete_type', label: '$athlete_type — Athlete Type' },
  { value: 'product_type', label: '$product_type — Product Type' },
  { value: 'gender', label: '$gender — Gender' },
  { value: 'outerMaterial', label: '$outerMaterial — Outer material' },
  { value: 'protectionLevel', label: '$protectionLevel — Protector level' },
  { value: 'season', label: '$season — Season' },
  { value: 'countryOfOrigin', label: '$countryOfOrigin — Origin' },
]

/**
 * A MOCK of the preview line. Handles string literals and `$ref` joined by `+`, which is exactly
 * what §1.3's example needs and no more.
 *
 * 🔴 It is deliberately NOT a second implementation of the language. `expr.ts` is 34 functions and
 * a Pratt parser; a lab that reimplemented a tenth of it would drift and start disagreeing with
 * the engine about what an operator's formula means. This returns an ERROR for anything it cannot
 * do, so the page can never quietly show a result the real engine would not produce.
 */
function mockPreview(src: string): { value: string | null; error: string | null } {
  const body = src.startsWith('=') ? src.slice(1) : src
  if (body.trim() === '') return { value: null, error: null }
  const parts: string[] = []
  let i = 0
  let expectOperand = true
  while (i < body.length) {
    const c = body[i]
    if (c === ' ') { i += 1; continue }
    if (expectOperand && c === '"') {
      const end = body.indexOf('"', i + 1)
      if (end === -1) return { value: null, error: `unterminated string at ${i}` }
      parts.push(body.slice(i + 1, end))
      i = end + 1
      expectOperand = false
      continue
    }
    if (expectOperand && c === '$') {
      let j = i + 1
      while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j += 1
      const name = body.slice(i + 1, j)
      if (name === '') return { value: null, error: `\`$\` must be followed by an attribute name at ${i}` }
      // The honest failure §1.3 step 2 shows: a typo names an attribute that does not exist, and
      // it is reported with its POSITION, not as an empty result.
      if (!(name in ATTRS)) return { value: null, error: `unknown attribute $${name} at ${i}` }
      parts.push(ATTRS[name])
      i = j
      expectOperand = false
      continue
    }
    if (!expectOperand && c === '+') { i += 1; expectOperand = true; continue }
    return { value: null, error: `this lab preview only does string literals and $refs joined by \`+\` — the real engine does the rest` }
  }
  if (expectOperand) return { value: null, error: 'the formula ends with `+`' }
  return { value: parts.join(''), error: null }
}

// ── the cell chrome ─────────────────────────────────────────────────────────────────────────

const CELL_BOX: CSSProperties = {
  // The box is a lab approximation (see the header). Tokens, so it moves with the DS.
  // 🔴 The 13px that used to live here is now `s.body` on each consumer — `ds-conformance-guard`
  // forbids an inline fontSize even inside a shared CSSProperties object. Every consumer of
  // CELL_BOX must therefore also carry `s.body`, or its cells silently inherit 16px.
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  height: 'var(--nds-grid-cell-size, 32px)',
  padding: '0 var(--nds-grid-cell-pad-x, 10px)',
  borderBottom: '1px solid var(--nds-border-subtle)',
  borderRight: '1px solid var(--nds-border-subtle)',
  color: 'var(--nds-grid-cell-fg, var(--nds-text))',
  // 🔴 NO `background` here. `.nds-ag-wrap .ag-cell.nds-cell-is-pinned` sets one via a class, and
  // an inline background would beat it — the tint would silently never render and this page would
  // report the engine as plainer than it is.
}

/**
 * The mark, drawn exactly as `provenanceMark.tsx` draws one: `nds-cell-prov` PLUS the engine's own
 * variant class, and no colour of its own.
 *
 * 🔴 This took a correction from PES.2 and it is the sharpest lesson on this page. The first
 * version passed an inline `colour`, and for the two `mapped` rows passed `colour=""` — so they
 * rendered uncoloured, which is exactly what the product did, and the page claimed it was showing
 * "the engine's real classes". It was not. It was showing MY absence of a colour next to the
 * engine's absence of a rule: the right picture for the wrong reason, and the moment PES.2 defined
 * `.nds-cell-prov-mapped` this page would have gone on drawing the defect as though unfixed — and
 * my own acceptance measurement would have reported a false failure of their work.
 *
 * A mock that supplies the value it then measures is measuring itself. The class is now the ONLY
 * source of the colour, so this page tracks the engine whether the engine is right or wrong.
 */
function Mark({ icon: Icon, cls, title }: { icon: typeof Sigma; cls: string; title: string }) {
  return (
    <span className={`nds-cell-prov ${cls}`} aria-hidden title={title}>
      <Icon size={11} strokeWidth={2.25} />
    </span>
  )
}

/**
 * The proposed `formula` mark: a bare `ƒ`, which is the glyph D16.2 names.
 *
 * 🔴 NOT lucide's `FunctionSquare`, which was the first thing tried and is wrong here on the
 * screen rather than in principle: every other member of this vocabulary is an UNBOXED glyph
 * (Σ mapped, ✎ pinned, 🔗 inherited, ✦ ai), and a boxed icon at 11px reads as a checkbox before it
 * reads as a function. lucide 0.263.1 — the version apps/web actually resolves — has no unboxed
 * variant, so the character itself is both the closer match to the spec and the closer match to
 * its siblings. Measured by zooming the rendered mark, not by reasoning about the icon set.
 *
 * 🔴 It carries NO COLOUR OF ITS OWN, and that is the point rather than an omission. My first
 * version hard-coded `--nds-cyan-700`; I then measured it at 2.17:1 on the dark ground and the hub
 * ruled the colour into the engine as `--nds-prov-formula-fg` (DS.2) behind
 * `.nds-cell-prov-formula` (PES.2, which waits for `CellProvenance` to gain the member). So the
 * glyph wears the engine class and nothing else: today it inherits the cell's text colour, which is
 * the honest picture of "the glyph is ruled, the colour is not landed yet", and the day the rule
 * lands this page shows it with no edit from me.
 *
 * Only the TYPOGRAPHY is local — italic, weight, size. Those are what make a `ƒ` read as a
 * function rather than an `f`, and they are not what was ruled into the engine.
 */
function FormulaGlyph({ title = 'Formula' }: { title?: string }) {
  return (
    <span
      className={`nds-cell-prov nds-cell-prov-formula ${s.body}`}
      style={{ fontStyle: 'italic', fontWeight: 700, lineHeight: 1 }}
      aria-hidden
      title={title}
    >
      ƒ
    </span>
  )
}

function Cell({
  children, className, width = 300, title,
}: { children: ReactNode; className?: string; width?: number; title?: string }) {
  return (
    <div className="nds-ag-wrap" style={{ background: 'var(--nds-grid-bg, var(--nds-surface))', width }}>
      <div className={['ag-cell', s.body, className].filter(Boolean).join(' ')} style={CELL_BOX} title={title}>
        <span className="nds-cell-value">{children}</span>
      </div>
    </div>
  )
}

// ── page chrome ─────────────────────────────────────────────────────────────────────────────

const PANEL: CSSProperties = {
  border: '1px solid var(--nds-border)',
  borderRadius: 'var(--nds-radius-md, 8px)',
  background: 'var(--nds-surface)',
  color: 'var(--nds-text)',
  padding: '16px',
}

/** One state, drawn in BOTH themes side by side — the hub asked for both, and a toggle shows one. */
function StatePair({
  step, title, whatItSays, nextClick, children,
}: { step: string; title: string; whatItSays: string; nextClick: string; children: ReactNode }) {
  return (
    <section style={{ ...PANEL, marginBottom: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <Pill tone="neutral">{step}</Pill>
        <h3 className={s.h2} style={{ margin: 0, fontWeight: 600 }}>{title}</h3>
      </div>
      <p className={s.body} style={{ margin: '0 0 12px', color: 'var(--nds-text-muted)', maxWidth: '78ch' }}>
        {whatItSays}
      </p>
      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
        <ThemeFrame label="Light">{children}</ThemeFrame>
        <ThemeFrame label="Dark" dark>{children}</ThemeFrame>
      </div>
      <p className={s.sm} style={{ margin: '12px 0 0', color: 'var(--nds-text-muted)' }}>
        <strong style={{ color: 'var(--nds-text)' }}>Next click:</strong>{' '}{nextClick}
      </p>
    </section>
  )
}

function ThemeFrame({ label, dark, children }: { label: string; dark?: boolean; children: ReactNode }) {
  return (
    <div>
      <div className={s.xs} style={{ textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--nds-text-muted)', marginBottom: '6px' }}>
        {label}
      </div>
      <div
        className={dark ? 'dark' : undefined}
        style={{
          background: 'var(--nds-surface)',
          border: '1px solid var(--nds-border)',
          borderRadius: 'var(--nds-radius-md, 8px)',
          padding: '14px',
          // The tokens re-resolve inside `.dark`; the text colour has to be taken from them HERE
          // or the dark frame inherits the light page's colour and reports a contrast it does not
          // have (reference_contrast_probe_own_background).
          color: 'var(--nds-text)',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ── the interactive editor state ────────────────────────────────────────────────────────────

/**
 * §1.3 step 1–2: typing `=` switches the cell to formula mode; `$` opens autocomplete; a preview
 * line sits under the field.
 *
 * The autocomplete is the DS `ListboxPanel` with an EXTERNAL `query` — the mode its docstring was
 * written for ("the grid's `=`-mode editor filters `$column` autocomplete from a cell the operator
 * is typing INTO, so a second input inside the panel would be a second place to type").
 */
function FormulaEditor() {
  const [src, setSrc] = useState('="Gale Jacket " + $brand + " " + $athlete_type')
  const caretToken = useMemo(() => {
    // The token the operator is mid-way through typing: everything after the last `$` that is
    // still an identifier. Empty when they are not inside a reference — the panel then closes.
    const m = /\$([A-Za-z0-9_]*)$/.exec(src)
    return m ? m[1] : null
  }, [src])
  const preview = useMemo(() => mockPreview(src), [src])

  return (
    <div style={{ width: 420 }}>
      {/* The editor is the cell, in place — not a dialog and not a bar above the grid (D16.3,
          and §1.4 struck the formula bar: one way to do a thing).

          It is the DS `Input` at `size="xs"`, which that component's own docstring calls "the
          dense grid-cell tier" — so the field an operator types a formula into is the field the
          rest of the studio uses, and the `ƒ` rides in as its `leadingIcon` rather than as a
          second thing floating beside it. A hand-rolled <input> here would also be exactly what
          `check-raw-primitives-ratchet` forbids a new file. */}
      {/* `.nds-field` is `inline-flex`, so it sizes to the input's default ~20-character width and
          clipped the formula at 231px inside a 420px cell (measured, not guessed). A GRID parent
          stretches it to the column with no change to the DS component and no utility class. */}
      <div style={{ display: 'grid' }}>
        <Input
          size="xs"
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          aria-label="Formula"
          spellCheck={false}
          leadingIcon={<FormulaGlyph />}
          className={s.mono} style={{
            fontFamily: 'var(--font-jetbrains-mono, ui-monospace), ui-monospace, monospace',
          }}
        />
      </div>

      {/*
        🔴 A DESIGN DECISION, made because the first drawing of this page was wrong on screen.

        The autocomplete was absolutely positioned under the field, which is where a popover
        belongs — and it covered the preview line, the one thing §1.3 step 2 exists to show. An
        operator picking `$athlete_type` cannot see what the formula currently evaluates to at the
        moment they most want to: while they are choosing the reference.

        So the panel sits IN FLOW and the preview line reflows below it. The editor is already an
        overlay over the sheet, so it may grow downward; nothing is hidden behind anything. This is
        a proposal to PES.2/AG.1, not a lab shortcut — the alternative (offsetting the popover far
        enough to clear the preview) leaves a gap that reads as two unrelated panels.
      */}
      {caretToken !== null && (
        <ListboxPanel
          options={COLUMN_OPTIONS}
          query={caretToken}
          autoFocus={false}
          onCommit={(v) => setSrc((s) => s.replace(/\$[A-Za-z0-9_]*$/, `$${v}`))}
          onCancel={() => setSrc((s) => s.replace(/\$[A-Za-z0-9_]*$/, (t) => t))}
          /* `.nds-combo-pop` caps itself at `max-width: 320px`, which a plain `width: 100%` loses to;
             the panel's own docstring hands geometry to the caller, so the caller states both. */
          style={{ position: 'static', marginTop: '2px', width: '100%', maxWidth: '100%', maxHeight: '168px' }}
        />
      )}

      {/* The preview line. §1.3 step 2 gives both readings verbatim. */}
      <div className={s.sm} style={{ marginTop: '8px', fontFamily: 'var(--font-jetbrains-mono, ui-monospace), ui-monospace, monospace' }}>
        {preview.error ? (
          <span style={{ color: 'var(--nds-danger-text)' }}>⚠ {preview.error}</span>
        ) : (
          <span style={{ color: 'var(--nds-text)' }}>{preview.value === null ? '—' : preview.value}</span>
        )}
      </div>
      <div className={s.xs} style={{ marginTop: '4px', color: 'var(--nds-text-muted)' }}>
        preview · mocked locally in this lab; the real editor calls{' '}
        <code>POST /api/pim/formulas/preview</code>{' '} </div>
    </div>
  )
}

// ── the page ────────────────────────────────────────────────────────────────────────────────

export default function FormulaLabPage() {
  const [width, setWidth] = useState('1440')

  return (
    <div style={{ padding: '24px', background: 'var(--nds-surface-sunken)', minHeight: '100vh', color: 'var(--nds-text)' }}>
      <header style={{ ...PANEL, marginBottom: '16px' }}>
        <h1 className={s.title} style={{ margin: '0 0 6px', fontWeight: 650 }}>Formula cell states — D16</h1>
        <p className={s.body} style={{ margin: '0 0 10px', color: 'var(--nds-text-muted)', maxWidth: '88ch' }}>
          The six steps of wave-4 §1.3, drawn for review before PES.2/AG.1 build them. The Owner&rsquo;s
          words on this item: <em>&ldquo;The UI has to be absolutely pinnacle, and also the UX. I would not
          compromise at all on it.&rdquo;</em>{' '} </p>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <SegmentedControl
            ariaLabel="Viewport width"
            options={[{ value: '1440', label: '1440' }, { value: '1728', label: '1728' }]}
            value={width}
            onChange={setWidth}
            size="sm"
          />
          <span className={s.sm} style={{ color: 'var(--nds-text-muted)' }}>
            frame width — the states are geometry-independent, but the editor and its panel are checked at both
          </span>
        </div>
      </header>

      {/* 🔴 The honesty panel. It is first because a reviewer who reads the states without it will
          believe the engine already has a `formula` member and a coloured `mapped` mark. */}
      <section style={{ ...PANEL, marginBottom: '16px', borderColor: 'var(--nds-warning-strong)' }}>
        <h2 className={s.h2} style={{ margin: '0 0 8px', fontWeight: 600 }}>What on this page is real</h2>
        <ul className={s.body} style={{ margin: 0, paddingLeft: '18px', lineHeight: 1.65, maxWidth: '92ch' }}>
          <li>
            <strong>Real:</strong>{' '}every tint and mark colour comes from the engine&rsquo;s own
            <code> design-system/grid/theme/grid.css</code>, imported by this page.
          </li>
          <li>
            <strong>Real:</strong> the <code>$</code> autocomplete is the DS <code>ListboxPanel</code>{' '}(#484)
            driven by an external query — the mode its docstring was written for.
          </li>
          <li>
            <strong>Real and live:</strong> the whole backend. <code>expr.ts</code>{' '}(34 functions),
            <code> CellFormula</code>, <code>MasterFieldRule</code>, and 12 endpoints under
            <code> /api/pim/formulas/*</code> registered at <code>index.ts:756</code>.
          </li>
          <li>
            <strong>Drawn, not real:</strong> the <code>ƒ</code> mark. <code>CellProvenance</code>{' '}is eight
            members today (<code>renderers/provenance.ts:49</code>) and <code>formula</code>{' '}is not one of
            them. This page draws the proposal rather than editing the engine to make its own mock true.
          </li>
          <li>
            <strong>Drawn, not real:</strong>{' '}the cell box (height, padding, borders). AG&rsquo;s stylesheet is
            not loaded here — importing it outside the engine and <code>grid-lab/</code>{' '}is a guard violation.
          </li>
          <li>
            <strong>Mocked:</strong>{' '}the preview line evaluates locally over a fixed attribute map, and refuses
            anything beyond literals and <code>$refs</code> joined by <code>+</code>{' '}rather than half-implementing
            the language.
          </li>
        </ul>
      </section>

      {/* Found by this page, ruled by the hub, fixed by PES.2 in `grid.css` at 07:20:55. Kept and
          restated rather than deleted: the Owner saw it as a defect and should see it CLOSED. */}
      <section style={{ ...PANEL, marginBottom: '16px', borderColor: 'var(--nds-border)' }}>
        <h2 className={s.h2} style={{ margin: '0 0 8px', fontWeight: 600 }}>
          Found here, now fixed: the <code>mapped</code>{' '}marks had no CSS at all
        </h2>
        <p className={s.body} style={{ margin: '0 0 8px', lineHeight: 1.65, maxWidth: '92ch' }}>
          <strong>What it was.</strong> <code>provenance.ts</code> emitted <code>nds-cell-is-mapped</code>{' '}and
          <code> nds-cell-is-mapped-shared</code>, and <code>provenanceMark.tsx</code>{' '}emitted
          <code> nds-cell-prov-mapped</code> and <code>nds-cell-prov-mapped-shared</code> — and a grep of all
          253 stylesheets returned <strong>zero rules for any of the four</strong>, against a positive control
          that found the sibling <code>cell-is-pinned</code> in 25 files. §9.6 shipped with its classifier
          tested (14 tests, 5/5 mutations killed) and its <em>appearance</em>{' '}never defined. No guard parses
          CSS for a class the TSX references, and the tests assert a class is <em>applied</em>, never that it
          <em> does</em>{' '}anything.
        </p>
        <p className={s.body} style={{ margin: 0, lineHeight: 1.65, maxWidth: '92ch' }}>
          <strong>What it is now.</strong> <code>grid.css:536,538</code> give both marks
          <code> var(--nds-grid-muted-fg)</code> — the quietest token that still passes, because on a
          thousand-SKU sheet <code>mapped</code> is the most common provenance there is. The same edit
          deleted <code>opacity: 0.75</code> from <code>.nds-cell-prov</code>{' '}(<code>:515</code>), which was
          costing every mark about a third of its contrast. <strong>The rows below now read the engine&rsquo;s
          own rules</strong>, so this page tracks that file whether it is right or wrong.
        </p>
      </section>

      {/* 🔴 Measured in this page, in the browser, in both themes — the check grid.css's own comment
          demands ("Contrast is verified in BOTH themes, in the browser, before this ships") and
          which the shipped marks do not all pass. */}
      <section style={{ ...PANEL, marginBottom: '16px', borderColor: 'var(--nds-warning-strong)' }}>
        <h2 className={s.h2} style={{ margin: '0 0 8px', fontWeight: 600 }}>
          Mark contrast — ACCEPTANCE: 15/15, on the live marks
        </h2>
        <p className={s.body} style={{ margin: '0 0 10px', lineHeight: 1.65, maxWidth: '92ch' }}>
          🔴 <strong>These are the BEFORE numbers</strong>{' '}— what this page measured at 07:0x, and why
          <code> grid.css</code>{' '}changed at 07:20:55. Kept as the record, not as the current state. They
          composite <code>.nds-cell-prov</code>&rsquo;s then-<code>opacity: 0.75</code>{' '}over each mark&rsquo;s
          real background, which is what the eye receives; reading the token pair alone overstates every one by
          about a third. The arrow is what the same mark would score with that alpha dropped. 3:1 is the bar for
          a graphical object that carries meaning.
          <br />
          <strong>The AFTER table is not here yet</strong>{' '}and will not be guessed. PES.2&rsquo;s half has
          landed; DS.2&rsquo;s <code>--nds-prov-ai-fg</code>{' '}and <code>--nds-prov-formula-fg</code>{' '}have
          not, so <code>ai</code>{' '}still rides its <code>purple-700</code>{' '}fallback and <code>formula</code>{' '}
          has no rule at all. On the ruled acceptance: <code>pinned</code>{' '}and <code>inherited</code>{' '}must
          land on the &ldquo;opacity dropped&rdquo; column exactly; the other four take new colours and are
          re-measured fresh, each ≥ 3:1 over the cell ground and its own tint, in both themes.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <div className={s.mono} style={{ display: 'grid', gridTemplateColumns: 'auto auto auto auto', gap: '2px 18px', minWidth: '440px' }}>
            {[
              ['mark  (ground · ai-tint · pinned-tint)', 'light', 'dark', ''],
              ['✦ ai  --nds-prov-ai-fg', '7.10 · 5.67 · 6.48', '8.25 · 8.64 · 7.37', 'PASSES all six'],
              ['ƒ formula  --nds-prov-formula-fg', '5.36 · 4.27 · 4.88', '8.43 · 8.83 · 7.53', 'token PASSES; no rule consumes it yet'],
              ['Σ mapped · mappedShared', '5.32 · 4.24 · 4.85', '7.38 · 7.73 · 6.60', 'PASSES — muted-fg, as ruled'],
              ['✎ pinned  --nds-primary', '4.79 · 3.82 · 4.36', '5.59 · 5.86 · 4.99', 'PASSES all six'],
              ['🔗 inherited  --nds-prov-inherited-fg', '5.98 · 4.77 · 5.45', '8.44 · 8.85 · 7.55', 'PASSES — was 2.55/2.67/2.28 on the old token'],
              ['formula input (type, not contrast)', 'DS xs · 11.5px', 'DS xs · 11.5px', 'was an inline 12.5px the DS offers only on its sm tier'],
            ].map((r, i) => (
              <Fragment key={r[0]}>
                <div style={{ fontWeight: i === 0 ? 600 : 400, color: i === 0 ? 'var(--nds-text-muted)' : 'var(--nds-text)' }}>{r[0]}</div>
                <div style={{ fontFamily: 'var(--font-jetbrains-mono, ui-monospace), ui-monospace, monospace', color: 'var(--nds-text)' }}>{r[1]}</div>
                <div style={{ fontFamily: 'var(--font-jetbrains-mono, ui-monospace), ui-monospace, monospace', color: 'var(--nds-text)' }}>{r[2]}</div>
                <div style={{ color: 'var(--nds-text-muted)' }}>{r[3]}</div>
              </Fragment>
            ))}
          </div>
        </div>
        <p className={s.body} style={{ margin: '10px 0 0', lineHeight: 1.65, maxWidth: '92ch' }}>
          <strong>Verdict: 15 / 15.</strong>{' '}Every provenance mark clears 3:1 over the cell ground and
          over both tints, in both themes, measured on the LIVE marks after PES.2 wired
          <code> --nds-prov-inherited-fg</code>{' '}at <code>grid.css:523</code>{' '}(08:29:18). The painted
          colour of the inherited mark is <code>rgb(147,197,253)</code>, and its three dark readings land on
          my pre-check to the hundredth.
          <br />
          <br />
          <em>Superseded, kept for the record:</em>{' '}the run before that wiring was twelve of fifteen —
          <strong>three failed, all of them
          <code> inherited</code>{' '}in dark</strong>{' '}— 2.55 on the cell ground, 2.67 on the AI tint, 2.28 on
          the pinned tint. The cause is the stylesheet, not the mark: <code>--nds-info-strong</code>{' '}is
          <code> var(--nds-blue-700)</code>{' '}declared in <code>:root</code>{' '}at <code>tokens.css:107</code>{' '}
          and never re-declared in <code>.dark</code>. Same defect class DS.2 has just fixed for <code>ai</code>{' '}
          and <code>formula</code>; <code>inherited</code>{' '}was left on the old token because deleting the
          alpha was never the whole problem for that row. It needs a <code>--nds-prov-inherited-fg</code>{' '}with
          a dark value, exactly like its two siblings.
          <br />
          <br />
          🔴 <strong>A correction to my own earlier table.</strong>{' '}It reported <code>ai</code>{' '}at 2.07 in
          BOTH themes. A uniform answer across inputs that should have differed is the tell, and I missed it —
          DS.2 caught it. That probe discarded the alpha channel when reading a background, so
          <code> color-mix(in srgb, var(--nds-purple-600) 10%, transparent)</code>{' '}— the AI tint — was read as
          SOLID purple-600: purple text on a purple ground, theme-invariant, so both themes returned the same
          wrong number. Every ratio above composites semi-transparent grounds properly, and the light
          <code> ai</code>{' '}cell-ground reading of 7.10 agrees with DS.2&rsquo;s independent measurement to the
          hundredth.
        </p>
      </section>

      <div style={{ width: `${width}px`, maxWidth: '100%', overflowX: 'auto' }}>
        <StatePair
          step="§1.3 · 3"
          title="At rest — the value, with the ƒ mark"
          whatItSays="The cell shows the evaluated VALUE, never the formula (D16.3). The mark says the value was computed here; the tooltip carries the formula and what it reads."
          nextClick="Opening the editor shows the FORMULA, not the text — which is why this needs its own member and not a tooltip on `mapped` (§9.6b: it changes what the operator does next)."
        >
          <Cell title={'="Gale Jacket " + $brand + " " + $athlete_type · reads: brand, athlete_type'}>
            <FormulaGlyph />
            <span className="nds-cell-value-text">Gale Jacket XAVIA Motorcyclist</span>
          </Cell>
          <div className={s.xsPlus} style={{ marginTop: '8px', color: 'var(--nds-text-muted)' }}>
            tooltip: <code>=&quot;Gale Jacket &quot; + $brand + &quot; &quot; + $athlete_type</code>{' '}· reads: brand, athlete_type
          </div>
        </StatePair>

        <StatePair
          step="§1.3 · 1–2"
          title="Editing — = mode, $ autocomplete, live preview"
          whatItSays="Typing `=` switches the cell to formula mode: mono field, ƒ in the cell's left edge, and the $ key opens autocomplete filtered as they type. Type into it — the panel is live, and so is the preview line."
          nextClick="Enter commits and the server stores formula + value; Esc cancels. The panel is the DS ListboxPanel, so it is the same list the studio's selects use."
        >
          <FormulaEditor />
        </StatePair>

        <StatePair
          step="§1.3 · 2 (error)"
          title="A typo is reported with its position — never as an empty result"
          whatItSays="§1.3's own second reading: `⚠ unknown attribute $athlete_typo at 26` in red. The formula stays in the field; nothing is stored."
          nextClick="Fix the name. Nothing was written, so there is nothing to undo — the failure is in the editor, before the write."
        >
          <div style={{ width: 420 }}>
            <div className="nds-ag-wrap" style={{ background: 'var(--nds-grid-bg, var(--nds-surface))' }}>
              <div className={`ag-cell ${s.body}`} style={{ ...CELL_BOX, width: 420, boxShadow: 'inset 0 0 0 2px var(--nds-danger-text)' }}>
                <FormulaGlyph />
                <span
                  className={`nds-cell-value-text ${s.mono}`}
                  style={{ fontFamily: 'var(--font-jetbrains-mono, ui-monospace), ui-monospace, monospace', }}
                >
                  =&quot;Gale Jacket &quot; + $brand + &quot; &quot; + $athlete_typo
                </span>
              </div>
            </div>
            <div className={s.sm} style={{ marginTop: '8px', color: 'var(--nds-danger-text)', fontFamily: 'var(--font-jetbrains-mono, ui-monospace), ui-monospace, monospace' }}>
              ⚠ unknown attribute $athlete_typo at 26
            </div>
          </div>
        </StatePair>

        <StatePair
          step="D16.4 · §1.6(G)"
          title="A stored formula that errors — ⚠ ƒ, no value"
          whatItSays="A formula whose result the field would refuse (over a cap in either unit, not in the closed list, empty where required) is STORED as a formula in an error state. §1.6(G): the stored value is CLEARED — the cell never leaves the last good value sitting under an error mark, and never invents one."
          nextClick="Open the editor and fix the formula, or pin a literal. The cell is honestly empty meanwhile: an operator must not read a stale value as current."
        >
          <Cell title="Formula error — result is 96 characters, over the 80-character cap from Amazon · IT. No value is stored.">
            {/* Lab-local: no engine provenance member covers a formula ERROR, so this ⚠ is drawn here and is
                 not a claim about the engine. The ƒ beside it is the engine class. */}
            <span className="nds-cell-prov" style={{ color: 'var(--nds-warning-strong)' }} aria-hidden title="Formula error">
              <AlertTriangle size={11} strokeWidth={2.25} />
            </span>
            <FormulaGlyph />
            <span className="nds-cell-value-text" style={{ color: 'var(--nds-text-muted)', fontStyle: 'italic' }}>
              —
            </span>
          </Cell>
          <div className={s.xsPlus} style={{ marginTop: '8px', color: 'var(--nds-text-muted)', maxWidth: '46ch' }}>
            tooltip: Formula error — result is 96 characters, over the 80-character cap from Amazon · IT. No value is stored.
          </div>
        </StatePair>

        <StatePair
          step="§1.3 · 5 · D16.6"
          title="A literal typed over a formula — pinned, with the formula one click away"
          whatItSays="The operator's latest explicit act wins: the literal is stored and the CellFormula row is deleted. It is not lost — §1.6(F) writes an AuditLog row (`formula.pinned`) carrying enough to re-create it, so it becomes a restore point with its own restore kind."
          nextClick="&ldquo;Restore formula&rdquo; re-creates the formula row and re-evaluates. The tint below is the engine's real `.nds-cell-is-pinned`."
        >
          <div>
            <Cell className="nds-cell-is-pinned" title="Pinned on this row — it no longer follows the formula">
              <Mark icon={Pencil} cls="nds-cell-prov-pinned" title="Pinned" />
              <span className="nds-cell-value-text">Custom title</span>
            </Cell>
            <div style={{ marginTop: '10px' }}>
              <Button variant="quiet" size="sm">Restore formula</Button>
            </div>
          </div>
        </StatePair>

        <StatePair
          step="D16.2"
          title="The precedence chain, as ONE mark per cell"
          whatItSays="ai > formula > mappedShared > mapped > the existing chain. A cell wears exactly one mark — the fact that most changes what the operator does next (§9.6b's corrected principle: not 'the weakest claim wins')."
          nextClick="Each mark redirects somewhere different: the AI draft to a decision, the formula to the formula, a mapping to the RULE on another surface, an inherited value to the parent."
        >
          <div style={{ display: 'grid', gap: '0' }}>
            <Cell className="nds-cell-is-ai-draft" width={340} title="Drafted by AI and not yet approved">
              <Mark icon={Sparkles} cls="nds-cell-prov-ai" title="AI-drafted" />
              <span className="nds-cell-value-text">Giacca Gale — proposta AI</span>
            </Cell>
            <Cell width={340} title="Formula — change the formula, not this cell">
              <FormulaGlyph />
              <span className="nds-cell-value-text">Gale Jacket XAVIA Motorcyclist</span>
            </Cell>
            <Cell className="nds-cell-is-mapped-shared" width={340} title="Derived per product — every alias shares this value">
              <Mark icon={Share2} cls="nds-cell-prov-mapped nds-cell-prov-mapped-shared" title="Derived per product" />
              <span className="nds-cell-value-text">XAVIA Giacca Da Moto</span>
            </Cell>
            <Cell className="nds-cell-is-mapped" width={340} title="Derived by a mapping rule — change the rule, not this cell">
              <Mark icon={Sigma} cls="nds-cell-prov-mapped" title="Derived by a mapping rule" />
              <span className="nds-cell-value-text">XAVIA</span>
            </Cell>
            <Cell className="nds-cell-is-inherited" width={340} title="Inherited from GALE-JACKET — edit to give this row its own value">
              <Mark icon={Link2} cls="nds-cell-prov-inherited" title="Inherited" />
              <span className="nds-cell-value-text">All season</span>
            </Cell>
          </div>
          <p className={s.xsPlus} style={{ margin: '10px 0 0', color: 'var(--nds-text-muted)', maxWidth: '60ch' }}>
            Every mark here carries the engine&rsquo;s own variant class and NO local colour, so what you see is
            what <code>grid.css</code> says today. That is a correction: these marks used to take an inline
            colour, and the two <code>mapped</code>{' '}rows an empty one — which drew the right picture for the
            wrong reason and would have gone on drawing the defect after PES.2 fixed it. The <code>ƒ</code>{' '}
            inherits its colour because <code>.nds-cell-prov-formula</code>{' '}does not exist yet; it will take
            the rule the day it lands, with no edit here.
          </p>
        </StatePair>
      </div>
    </div>
  )
}
