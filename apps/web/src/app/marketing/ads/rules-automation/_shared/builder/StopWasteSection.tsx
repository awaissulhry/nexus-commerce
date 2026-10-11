'use client'

/**
 * The Negative Targeting builder's ONE extra section, "Stop waste — may run alone" (Owner 2026-10-11, wave 4): the old
 * builder exactly as it was, plus this. Off by default. On: the action ("Negative exact" for shoppers' search terms, or
 * "Pause keyword, keep it paused" for our keywords), the safe test (0 orders; the window; clicks at least; spend at least
 * N × the product's target cost per order, or a fixed bar without a target; late orders count; days out of stock left
 * out), and whether Automate may act alone — inside the caps — or why it stays held. Drawn in the builder's own look
 * (`h10-rb-*`, the Advanced settings card); every control is the design system's. The words and rules:
 * `stopWasteSectionModel.ts`; `RuleBuilder` mounts it for the negative-targeting slug only.
 */
import { Banner, Field } from '@/design-system/components'
import { InfoTip, Input, RadioCard, Toggle } from '@/design-system/primitives'
import { CAPS_WORDS, KIND_WORD, sectionProblems, type StopWasteForm, type StopWasteKind } from './stopWasteSectionModel'
import styles from './stopWasteSection.module.css'

export function StopWasteSection({ form, onChange, onKind, heldBy, readOnly }: {
  form: StopWasteForm
  onChange(next: StopWasteForm): void
  /** Another action picked: the form takes that kind's own starter numbers. */
  onKind(kind: StopWasteKind): void
  /** Why Automate stays held with the section on; null when the rule may run alone. */
  heldBy: string | null
  /** A rule made by the rule engine: its section is shown as it is kept, never edited (its save sends no actions). */
  readOnly?: string | null
}) {
  const problems = sectionProblems(form)
  const set = (patch: Partial<StopWasteForm>) => onChange({ ...form, ...patch })
  // Read only for real (audit M5): `inert` takes no focus, click or typing (React 19 reads a boolean), and says so.
  const lock = readOnly ? { inert: true, 'aria-disabled': true } : {}
  return (
    <section id="rb-stop-waste" className="h10-rb-sec">
      <h2>Stop waste — may run alone</h2>
      <p className="h10-rb-desc">
        Off by default. On, this rule uses the safe test below, and only then may Automate act on its own — inside its caps.
        {readOnly ? ` ${readOnly}` : ''}
      </p>
      <div className={`h10-rb-card adv${readOnly ? ' held' : ''}`} {...lock}>
        <div className={`h10-rb-dedupe${form.on ? '' : ` ${styles.alone}`}`}>
          <Toggle checked={form.on} aria-label="Stop waste — may run alone" onChange={(on) => set({ on })} />
          <span>Use the safe test and one action, so this rule may run alone.</span>
        </div>
        {form.on && (
          <>
            <div className="advblock">
              <b>Action</b>
              {(['NEGATE_TERM', 'PAUSE_KEYWORD'] as const).map((k) => (
                <RadioCard
                  key={k}
                  variant="row"
                  className="h10-rb-ctrl"
                  name="rb-stop-waste-kind"
                  checked={form.kind === k}
                  selected={form.kind === k}
                  onChange={() => { if (form.kind !== k) onKind(k) }}
                  title={KIND_WORD[k].title}
                  description={KIND_WORD[k].description}
                />
              ))}
              {form.kind === 'PAUSE_KEYWORD' && <p>A keyword pause reads only the criteria and the ad groups it looks in (Ad Group Mapping), where a keyword may be paused. The target types, Search Terms, Negation Level and the two Control switches are held.</p>}
            </div>
            <div className="advblock">
              <b>The safe test</b>
              <p>0 orders. Late orders count: clicks and spend up to 3 days ago, orders up to today. Days out of stock are left out.</p>
              <div className="freqrow fields">
                <Field label="Window" info={<InfoTip tip="Click-days it looks back, 14 to 87: clicks and spend to 3 days ago, orders to today." />} error={problems.windowDays}>
                  <Input fieldClassName="h10-rb-val bidv" inputMode="numeric" suffix="days" value={form.windowDays} onChange={(e) => set({ windowDays: e.target.value })} aria-label="Window in days" />
                </Field>
                <Field label="Clicks at least" info={<InfoTip tip="Raised to 3 ÷ the product's conversion rate when that is higher." />} error={problems.minClicks}>
                  <Input fieldClassName="h10-rb-val bidv" inputMode="numeric" value={form.minClicks} onChange={(e) => set({ minClicks: e.target.value })} aria-label="Clicks at least" />
                </Field>
                <Field label="Spend at least" info={<InfoTip tip="Times the product's target cost per order." />} error={problems.cpaMultiple}>
                  <Input fieldClassName="h10-rb-val bidv" inputMode="decimal" suffix="×" value={form.cpaMultiple} onChange={(e) => set({ cpaMultiple: e.target.value })} aria-label="Spend at least, times the target cost per order" />
                </Field>
                <Field label="Without a target" info={<InfoTip tip={form.spendFloor == null ? 'The spend bar for a product with no target cost per order: its default (the amount needs the ad spend permission).' : 'The spend bar for a product with no target cost per order.'} />} error={problems.spendFloor}>
                  {form.spendFloor == null
                    ? <Input fieldClassName="h10-rb-val bidv" value="Default" readOnly aria-label="Spend bar without a target: its default" />
                    : <Input fieldClassName="h10-rb-val bidv" prefix="€" inputMode="decimal" value={form.spendFloor} onChange={(e) => set({ spendFloor: e.target.value })} aria-label="Spend bar without a target" />}
                </Field>
              </div>
            </div>
            <div className="advblock">
              <b>Automate</b>
              {heldBy
                ? <Banner tone="warning" title="Automate stays held">{heldBy}</Banner>
                : <p>{CAPS_WORDS}</p>}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
