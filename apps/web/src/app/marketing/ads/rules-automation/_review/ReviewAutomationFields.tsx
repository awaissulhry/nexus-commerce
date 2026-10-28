'use client'

/**
 * The rules builder's sections for a review automation (ReviewAutomationBuilder draws the builder around them): its
 * name, its trigger — the spike check's alert and its settings (themes, how fast complaints must rise, products,
 * market) —, its action, and how many times a day it may run. Design-system controls only; the builder shell's
 * `h10-rb-*` classes give the sections their look. A part the builder cannot draw is held: shown, not editable, kept.
 */
import { Banner, Field, Listbox, MultiSelect } from '@/design-system/components'
import { Input, RadioCard, Textarea, Toggle } from '@/design-system/primitives'
import {
  EVERY_MARKET, MESSAGE_MAX, productLabel, spikeCheckWords,
  type FormField, type ReviewAutomationForm, type ReviewAutomationRead,
} from './reviewAutomationForm'
import s from './reviewAutomationBuilder.module.css'

export interface ReviewAutomationFieldsProps {
  read: Pick<ReviewAutomationRead, 'kept' | 'whenHeld' | 'thenHeld' | 'spikeCheck' | 'options'>
  form: ReviewAutomationForm
  /** Shown once a save was tried (or a value was left), per field. */
  problems: Partial<Record<FormField, string>>
  onChange: (patch: Partial<ReviewAutomationForm>) => void
}

const heldProps = (held: string | null) => (held ? { inert: true, 'aria-disabled': true as const } : {})

/** A picker's label for what is picked: the one picked by name, else how many ("2 themes"), else what none means. */
const pickedLabel = (options: ReadonlyArray<{ value: string; label: string }>, none: string, noun: string) => (picked: string[]) => {
  if (picked.length === 0) return none
  if (picked.length === 1) return options.find((o) => o.value === picked[0])?.label ?? `1 ${noun}`
  return `${picked.length} ${noun}s`
}

export function ReviewAutomationFields({ read, form, problems, onChange }: ReviewAutomationFieldsProps) {
  const productOptions = read.options.products.map((p) => ({ value: p.value, label: productLabel(p), searchText: `${p.label} ${p.sku ?? ''}` }))
  const marketOptions = [{ value: EVERY_MARKET, label: 'Every market' }, ...read.options.markets]
  const tells = form.does === 'notify' || form.tellTeam
  return (
    <>
      {/* ── Rule Name ── */}
      <section id="rvb-name" className="h10-rb-sec">
        <h2>Rule Name</h2>
        <Field label="Name" error={problems.name}>
          <Input fieldClassName="h10-rb-input rn" value={form.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Enter a rule name" />
        </Field>
      </section>

      {/* ── Trigger ── */}
      <section id="rvb-trigger" className="h10-rb-sec">
        <h2>Trigger</h2>
        <p className="h10-rb-desc">
          When the hourly spike check raises an alert: complaints about one theme rising fast for a product in one market.
          The settings below narrow which alerts this automation acts on.
        </p>
        {read.whenHeld && <Banner tone="warning" title="The trigger is kept as it is">{read.whenHeld}</Banner>}
        <div className={`h10-rb-card adv ${s.card}`} {...heldProps(read.whenHeld)}>
          <div className="advblock">
            <Field label="Themes" hint="Empty: complaints about any theme.">
              <MultiSelect options={read.options.themes} value={form.themes} onChange={(themes) => onChange({ themes })} placeholder="Every theme" width={300} formatLabel={pickedLabel(read.options.themes, 'Every theme', 'theme')} />
            </Field>
          </div>
          <div className="advblock">
            <b id="rvb-speed">How fast complaints must rise</b>
            <div className={s.choices} role="radiogroup" aria-labelledby="rvb-speed">
              <RadioCard
                variant="row" className="h10-rb-ctrl" name="rvb-speed" checked={form.speed === 'any'} selected={form.speed === 'any'}
                onChange={() => onChange({ speed: 'any' })}
                title="Every alert the check raises" description={spikeCheckWords(read.spikeCheck)}
              />
              <RadioCard
                variant="row" className="h10-rb-ctrl" name="rvb-speed" checked={form.speed === 'atLeast'} selected={form.speed === 'atLeast'}
                onChange={() => onChange({ speed: 'atLeast', multiplier: form.multiplier || String(read.spikeCheck.multiplier) })}
                title="Only when complaints rise faster still" description="At least this many times as often as usual."
              />
            </div>
            {form.speed === 'atLeast' && (
              <div className={s.nested}>
                <Field label="Times as often as usual, at least" error={problems.multiplier}>
                  <Input fieldClassName="h10-rb-val bidv hassf" suffix="×" inputMode="decimal" value={form.multiplier} onChange={(e) => onChange({ multiplier: e.target.value })} placeholder={String(read.spikeCheck.multiplier)} />
                </Field>
              </div>
            )}
          </div>
          <div className="advblock">
            <b id="rvb-products">Products</b>
            <div className={s.choices} role="radiogroup" aria-labelledby="rvb-products">
              <RadioCard
                variant="row" className="h10-rb-ctrl" name="rvb-products" checked={form.products === 'every'} selected={form.products === 'every'}
                onChange={() => onChange({ products: 'every' })} title="Every product"
              />
              <RadioCard
                variant="row" className="h10-rb-ctrl" name="rvb-products" checked={form.products === 'only'} selected={form.products === 'only'}
                onChange={() => onChange({ products: 'only' })} title="Only these products" description="A product counts with all its sizes and colours."
              />
            </div>
            {form.products === 'only' && (
              <div className={s.nested}>
                <Field label="Which products" error={problems.families} hint={productOptions.length ? 'The products with reviews in Nexus.' : 'No product has a review in Nexus yet.'}>
                  <MultiSelect options={productOptions} value={form.families} onChange={(families) => onChange({ families })} placeholder="Pick products" searchable searchPlaceholder="Search name or SKU" width={360} formatLabel={pickedLabel(productOptions, 'Pick products', 'product')} />
                </Field>
              </div>
            )}
          </div>
          <div className="advblock">
            <Field label="Market" hint={read.options.markets.length ? 'The markets with reviews in Nexus.' : 'No market has a review in Nexus yet.'}>
              <Listbox options={marketOptions} value={form.market} onChange={(market) => onChange({ market })} width={260} />
            </Field>
          </div>
          {read.kept.length > 0 && (
            <div className="advblock">
              <Banner tone="info" title="Also kept as it is">
                The builder has no control for {read.kept.length === 1 ? 'this condition' : 'these conditions'}; a save keeps {read.kept.length === 1 ? 'it' : 'them'}:
                <ul className={s.kept}>{read.kept.map((k) => <li key={k}>{k}</li>)}</ul>
              </Banner>
            </div>
          )}
        </div>
      </section>

      {/* ── Action ── */}
      <section id="rvb-action" className="h10-rb-sec">
        <h2>Action</h2>
        <p className="h10-rb-desc">What it does for each alert it acts on.</p>
        {read.thenHeld && <Banner tone="warning" title="The action is kept as it is">{read.thenHeld}</Banner>}
        <div className={`h10-rb-card control ${s.card}`} {...heldProps(read.thenHeld)}>
          <div className={s.choices} role="radiogroup" aria-label="What it does">
            <RadioCard
              variant="row" className="h10-rb-ctrl" name="rvb-does" checked={form.does === 'notify'} selected={form.does === 'notify'}
              onChange={() => onChange({ does: 'notify' })}
              title="Tell the team" description="A notice with the words below."
            />
            <RadioCard
              variant="row" className="h10-rb-ctrl" name="rvb-does" checked={form.does === 'bullets'} selected={form.does === 'bullets'}
              onChange={() => onChange({ does: 'bullets' })}
              title="Draft new bullet points"
              description="The AI drafts five bullet points that answer the complaints. A person reads them and applies them; nothing changes on a channel by itself. Out of trial run, it also saves them as an A+ draft in Nexus."
            />
            <RadioCard
              variant="row" className="h10-rb-ctrl" name="rvb-does" checked={form.does === 'aplus'} selected={form.does === 'aplus'}
              onChange={() => onChange({ does: 'aplus' })}
              title="Draft an A+ module"
              description="The AI drafts an A+ module that answers the complaints and saves it as an A+ draft in Nexus. A person approves it before anything is published."
            />
          </div>
          {form.does !== 'notify' && (
            <label className={s.toggleRow}>
              <Toggle checked={form.tellTeam} onChange={(tellTeam) => onChange({ tellTeam })} aria-label="Also tell the team" />
              <span>Also tell the team</span>
            </label>
          )}
          {tells && (
            <div className={s.nested}>
              <Field label="What the team is told" error={problems.message}>
                <Textarea value={form.message} onChange={(e) => onChange({ message: e.target.value })} limit={MESSAGE_MAX} rows={3} />
              </Field>
            </div>
          )}
        </div>
      </section>

      {/* ── Limit ── */}
      <section id="rvb-limit" className="h10-rb-sec">
        <h2>Limit</h2>
        <div className={`h10-rb-card adv ${s.card}`}>
          <div className="advblock">
            <Field label="At most, times a day" error={problems.maxPerDay} hint="Past this number, further matches that day are refused.">
              <Input fieldClassName="h10-rb-val bidv" inputMode="numeric" value={form.maxPerDay} onChange={(e) => onChange({ maxPerDay: e.target.value })} />
            </Field>
          </div>
        </div>
      </section>
    </>
  )
}
