'use client'

import { useMemo, useState, type ReactNode } from 'react'

import { Field } from '@/design-system/components'
import {
  SizeGridEditor,
  SizeGridView,
  sizeGridOffers,
  sizeGridTotals,
  type SizeGridColour,
  type SizeGridCurve,
  type SizeGridIssue,
  type SizeGridSize,
  type SizeGridValue,
} from '@/design-system/grid'
import { DensityProvider } from '@/design-system/lib/density'
import { Select } from '@/design-system/primitives'

/*
 * 2026-10-28 — the size grid (gap G9): colour × size quantities for a quote line, an order, a style and a work order.
 * Made-up colourways, sizes and curves. Verify, light and dark, 1440 and 390 px:
 *  - Tab walks the cells row by row; the arrows move between cells (left and right at the edge of the number), Enter
 *    moves down, Shift+Enter up, Escape puts back what the cell had; Tan 3XL is not offered and is skipped;
 *  - typing updates the row, column and grand totals at once; a screen reader hears them (status region);
 *  - paste a block copied from a spreadsheet (tab between values, newline between rows) into a cell: it lands from
 *    that cell, and what could not land is said under the grid;
 *  - Fill by curve is held until there are pieces to share; it fills each colour (or one) exactly to the total;
 *  - 1 to 5 pieces in a cell shows the example's warning; a colour over 500 pieces its error (the screen's rules);
 *  - the made-to-measure switch hides the grid and shows the profile picker the app renders;
 *  - the portal grid (comfortable tier) has 44 px cells in 16 px type; at 390 px each grid scrolls inside its own
 *    box and the page does not scroll sideways.
 */
const LETTERS: SizeGridSize[] = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'].map((k) => ({ key: k, label: k }))
const COLOURS: SizeGridColour[] = [
  { key: 'black', label: 'Black', swatch: 'black' },
  { key: 'navy', label: 'Navy', swatch: 'navy' },
  { key: 'tan', label: 'Tan', swatch: 'tan', offered: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
]
const CURVES: SizeGridCurve[] = [
  { key: 'core', label: 'Core run', ratios: { XS: 1, S: 2, M: 3, L: 3, XL: 2, XXL: 1, '3XL': 1 } },
  { key: 'large', label: 'Large-led', ratios: { M: 1, L: 2, XL: 3, XXL: 2, '3XL': 1 } },
  { key: 'pct', label: 'Per cent', ratios: { S: '12.5', M: '25', L: '33.3', XL: '20.8', XXL: '8.4' } },
]
const START: SizeGridValue = {
  black: { S: 4, M: 12, L: 12, XL: 6 },
  navy: { M: 8, L: 8 },
  tan: {},
}

/** The NUMERIC sizes a portal line might use (a jacket in EU sizes). */
const EU: SizeGridSize[] = ['44', '46', '48', '50', '52', '54', '56', '58', '60'].map((k) => ({ key: k, label: k }))
const PORTAL_COLOURS: SizeGridColour[] = [
  { key: 'black', label: 'Black', swatch: 'black' },
  { key: 'brown', label: 'Brown', swatch: 'saddlebrown', offered: ['46', '48', '50', '52', '54', '56'] },
]

const MIN_PER_SIZE = 6
const MAX_PER_COLOUR = 500

/** The example's own rules, as a screen would pass them: a warning per cell, an error per colour. */
function issuesOf(value: SizeGridValue, colours: readonly SizeGridColour[], sizes: readonly SizeGridSize[]): SizeGridIssue[] {
  const out: SizeGridIssue[] = []
  const totals = sizeGridTotals(value, colours, sizes)
  for (const c of colours) {
    for (const s of sizes) {
      const q = sizeGridOffers(c, s.key) ? (value[c.key]?.[s.key] ?? 0) : 0
      if (q > 0 && q < MIN_PER_SIZE) out.push({ colour: c.key, size: s.key, message: `Below the ${MIN_PER_SIZE}-piece minimum per size.`, tone: 'warning' })
    }
    if ((totals.rows[c.key] ?? 0) > MAX_PER_COLOUR) out.push({ colour: c.key, message: `More than the ${MAX_PER_COLOUR} pieces one dye lot holds.` })
  }
  return out
}

const NOTE = { margin: 0, fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text-2)' } as const
const EYEBROW = { fontSize: 'var(--nds-font-size-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--nds-text-3)' } as const

function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div
      id={id}
      style={{
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--nds-space-12)',
        padding: 'var(--nds-space-16)',
        background: 'var(--nds-surface)',
        border: '1px solid var(--nds-border-subtle)',
        borderRadius: 'var(--nds-radius-2xl)',
      }}
    >
      <div style={EYEBROW}>{title}</div>
      {children}
    </div>
  )
}

function ProfilePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Measurement profile">
      <Select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">Choose a profile</option>
        <option value="a">Profile A · chest 102, waist 88</option>
        <option value="b">Profile B · chest 96, waist 82</option>
      </Select>
    </Field>
  )
}

export function SizeGridExample() {
  const [value, setValue] = useState<SizeGridValue>(START)
  const [mtm, setMtm] = useState(false)
  const [profile, setProfile] = useState('')
  const [portal, setPortal] = useState<SizeGridValue>({ black: { '48': 2, '50': 4, '52': 4, '54': 2 } })
  const issues = useMemo(() => issuesOf(value, COLOURS, LETTERS), [value])

  return (
    <section id="size-grid-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-16)', marginBottom: 'var(--nds-space-24)' }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 'var(--nds-font-size-md)', fontWeight: 700 }}>Size grid</h3>
        <p style={NOTE}>
          <code>SizeGridEditor</code> and <code>SizeGridView</code>: quantities by colour and size, row, column and grand totals, curve fill
          (largest remainder, exact total), paste from a spreadsheet, the made-to-measure switch. Sizes read the page density.
        </p>
      </div>

      <Panel id="size-grid-office" title="Editor · standard (office: a quote line)">
        <SizeGridEditor
          colours={COLOURS}
          sizes={LETTERS}
          value={value}
          onChange={setValue}
          curves={CURVES}
          issues={issues}
          mtm={mtm}
          onMtmChange={setMtm}
          mtmSlot={<ProfilePicker value={profile} onChange={setProfile} />}
        />
      </Panel>

      <Panel id="size-grid-read" title="Read view · standard (the same line on the order record)">
        <SizeGridView colours={COLOURS} sizes={LETTERS} value={value} mtm={mtm} mtmSlot={<p style={NOTE}>{profile ? `Profile ${profile.toUpperCase()}` : 'No profile chosen yet'}</p>} />
      </Panel>

      <DensityProvider value="comfortable">
        <Panel id="size-grid-portal" title="Editor · comfortable (portal: a buyer's order, EU sizes)">
          <SizeGridEditor colours={PORTAL_COLOURS} sizes={EU} value={portal} onChange={setPortal} caption="Your quantities by colour and size" showCaption />
        </Panel>
        <Panel id="size-grid-portal-read" title="Read view · comfortable">
          <SizeGridView colours={PORTAL_COLOURS} sizes={EU} value={portal} />
        </Panel>
      </DensityProvider>
    </section>
  )
}
