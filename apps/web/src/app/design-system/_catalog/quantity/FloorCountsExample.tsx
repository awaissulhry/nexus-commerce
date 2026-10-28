'use client'

import { useRef, useState } from 'react'

import { AqlCounter, FloorFrame, QuantityPad, SizeButtons, useConfirmFeedback, type AqlClass, type SizeButton } from '@/design-system/floor'
import { SegmentedControl } from '@/design-system/primitives'

import { COUNT_COPY, type CountCopy, type CountLang } from './quantityCopy'
import s from './quantityCatalog.module.css'

/*
 * 2026-10-28 — counts on the floor (gap G6, `packages/ui/src/floor/QuantityPad`, `SizeButtons`): the parts SCR-090
 * (finish a bundle), SCR-094 (cut log per size), SCR-092 (a hide's area) and SCR-097 (AQL sample) are built from, on the
 * floor density tier, with fake Italian and English words passed in by this page. Verify: the default is replaced by the
 * first digit; a digit past the maximum is refused with an amber flash and the range in words; − / + stop at the
 * bounds; arrows move between sizes; the AQL verdict changes as you count. Type with a pause between keys: a fast burst
 * reads as a barcode scanner on a floor screen.
 */

const BUNDLE = 24

/** SCR-090: finish a bundle with its good count — the bundle quantity is the one-tap default. */
function FinishExample({ copy }: { copy: CountCopy }) {
  const [good, setGood] = useState<number | null>(BUNDLE)
  const [said, setSaid] = useState('')
  const feedback = useConfirmFeedback()
  const target = useRef<HTMLDivElement>(null)
  return (
    <div className={s.example} id="floor-qty-finish-example">
      <h3 className={s.title}>QuantityPad — finish a bundle (SCR-090)</h3>
      <p className={s.note}>Bundle of {BUNDLE}: the default is selected; type 2, 2 to make 22. Over {BUNDLE} is refused.</p>
      <div className={s.screen}>
        <FloorFrame fill={false} landmarks={false} label={copy.good}>
          <div ref={target}>
            <QuantityPad
              label={copy.good}
              unit={copy.pieces}
              value={good}
              onChange={setGood}
              min={0}
              max={BUNDLE}
              expected={BUNDLE}
              expectedLabel={copy.expected}
              quickValues={[{ value: BUNDLE, label: `${copy.all} ${BUNDLE}` }, 0]}
              decrementLabel={copy.less}
              incrementLabel={copy.more}
              clearLabel={copy.clear}
              backLabel={copy.back}
              emptyLabel={copy.empty}
              rangeLabel={copy.range}
              confirmLabel={copy.confirm}
              onConfirm={(n) => {
                feedback('success', target.current)
                setSaid(copy.saved(String(n)))
                setGood(BUNDLE)
              }}
            />
          </div>
        </FloorFrame>
      </div>
      <p className={s.status} aria-live="polite">
        {said}
      </p>
    </div>
  )
}

const START_SIZES: SizeButton[] = [
  { id: '46', label: '46', remaining: 4 },
  { id: '48', label: '48', remaining: 6 },
  { id: '50', label: '50', remaining: 0 },
  { id: '52', label: '52', remaining: 8 },
  { id: '54', label: '54', remaining: 2 },
  { id: '56', label: '56', remaining: 3 },
]

/** SCR-094: pick the size, count what was cut in it; the size's remaining count is the maximum and the default. */
function CutLogExample({ copy }: { copy: CountCopy }) {
  const [sizes, setSizes] = useState(START_SIZES)
  const [picked, setPicked] = useState<string | null>('48')
  const size = sizes.find((x) => x.id === picked) ?? null
  const [count, setCount] = useState<number | null>(size?.remaining ?? null)
  const feedback = useConfirmFeedback()
  const target = useRef<HTMLDivElement>(null)
  const shown = sizes.map((x) => (x.id === '54' ? { ...x, heldReason: copy.notInOrder } : x))
  return (
    <div className={s.example} id="floor-qty-cut-example">
      <h3 className={s.title}>SizeButtons + QuantityPad — cut log per size (SCR-094)</h3>
      <p className={s.note}>Size 54 is held (not in this order); 50 is done and can still be picked.</p>
      <div className={s.screen}>
        <FloorFrame fill={false} landmarks={false} label={copy.size}>
          <div className={s.stack} ref={target}>
            <SizeButtons
              label={copy.size}
              sizes={shown}
              value={picked}
              onChange={(id) => {
                setPicked(id)
                setCount(sizes.find((x) => x.id === id)?.remaining ?? null)
              }}
              remainingLabel={copy.toCut}
              doneLabel={copy.done}
            />
            <QuantityPad
              label={`${copy.cut} · ${copy.size} ${size?.label ?? '–'}`}
              unit={copy.pieces}
              value={count}
              onChange={setCount}
              min={1}
              max={size?.remaining ?? 0}
              decrementLabel={copy.less}
              incrementLabel={copy.more}
              clearLabel={copy.clear}
              backLabel={copy.back}
              emptyLabel={copy.empty}
              rangeLabel={copy.range}
              confirmLabel={copy.confirm}
              onConfirm={(n) => {
                if (!size) return
                const left = (size.remaining ?? 0) - n
                setSizes((all) => all.map((x) => (x.id === size.id ? { ...x, remaining: left } : x)))
                setCount(left > 0 ? left : null)
                feedback('success', target.current)
              }}
            />
          </div>
        </FloorFrame>
      </div>
    </div>
  )
}

/** SCR-092: a hide's area, two decimals, the person's own decimal separator. */
function HideAreaExample({ copy, lang }: { copy: CountCopy; lang: CountLang }) {
  const [area, setArea] = useState<number | null>(null)
  const [said, setSaid] = useState('')
  return (
    <div className={s.example} id="floor-qty-area-example">
      <h3 className={s.title}>QuantityPad with decimals — a hide's area (SCR-092)</h3>
      <p className={s.note}>From 0.5 to 8 m², two decimals; the separator key takes Clear's place and Clear moves beside the number.</p>
      <div className={s.screen}>
        <FloorFrame fill={false} landmarks={false} label={copy.area}>
          <QuantityPad
            label={copy.area}
            unit="m²"
            value={area}
            onChange={setArea}
            min={0.5}
            max={8}
            step={0.25}
            decimals={2}
            decimalSeparator={lang === 'it' ? ',' : '.'}
            separatorLabel={copy.comma}
            decrementLabel={copy.less}
            incrementLabel={copy.more}
            clearLabel={copy.clear}
            backLabel={copy.back}
            emptyLabel={copy.empty}
            rangeLabel={copy.range}
            confirmLabel={copy.confirm}
            onConfirm={(n) => setSaid(copy.saved(`${n} m²`))}
          />
        </FloorFrame>
      </div>
      <p className={s.status} aria-live="polite">
        {said}
      </p>
    </div>
  )
}

/** SCR-097: a made-up single-sampling plan — n 50; critical Ac 0, major Ac 3, minor Ac 5. */
function AqlExample({ copy }: { copy: CountCopy }) {
  const [inspected, setInspected] = useState(0)
  const [defects, setDefects] = useState<Record<string, number>>({ critical: 0, major: 0, minor: 0 })
  const classes: AqlClass[] = [
    { id: 'critical', label: copy.classes.critical, accept: 0, defects: defects.critical },
    { id: 'major', label: copy.classes.major, accept: 3, defects: defects.major },
    { id: 'minor', label: copy.classes.minor, accept: 5, defects: defects.minor },
  ]
  return (
    <div className={s.example} id="floor-qty-aql-example">
      <h3 className={s.title}>AqlCounter — final inspection sample (SCR-097)</h3>
      <p className={s.note}>One critical defect, or a fourth major, rejects at once; accepted only after all 50 pieces.</p>
      <div className={s.screen}>
        <FloorFrame fill={false} landmarks={false} label={copy.aqlPlan}>
          <AqlCounter
            label={copy.aqlPlan}
            sampleSize={50}
            inspected={inspected}
            onInspectedChange={setInspected}
            classes={classes}
            onDefectsChange={(id, n) => setDefects((d) => ({ ...d, [id]: n }))}
            inspectedLabel={copy.inspected}
            sampleLabel={copy.sample}
            thresholdLabel={copy.threshold}
            verdictLabels={copy.verdict}
            classStateLabels={copy.classState}
            addInspectedLabel={copy.onePiece}
            removeInspectedLabel={copy.removePiece}
            addDefectLabel={copy.addDefect}
            removeDefectLabel={copy.removeDefect}
            sampleDoneLabel={copy.sampleDone}
            nothingToRemoveLabel={copy.atZero}
          />
        </FloorFrame>
      </div>
    </div>
  )
}

export function FloorCountsExample() {
  const [lang, setLang] = useState<CountLang>('it')
  const copy = COUNT_COPY[lang]
  return (
    <section id="floor-counts-example" className={s.kit} lang={lang}>
      <div className={s.controls}>
        <SegmentedControl
          size="sm"
          ariaLabel="Language of the count examples"
          value={lang}
          onChange={(v) => setLang(v === 'en' ? 'en' : 'it')}
          options={[
            { value: 'it', label: 'Italiano' },
            { value: 'en', label: 'English' },
          ]}
        />
        <p className={s.note}>Every word below comes from the page; the floor parts hold none. All names, codes and numbers are made up.</p>
      </div>
      <FinishExample copy={copy} />
      <CutLogExample copy={copy} />
      <HideAreaExample copy={copy} lang={lang} />
      <AqlExample copy={copy} />
    </section>
  )
}
