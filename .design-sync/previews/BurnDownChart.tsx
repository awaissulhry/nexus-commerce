// BurnDownChart — cumulative spend against the plan's pace, ONE axis.
// Composition ported from the budget-schedules plan editor
// (apps/web/src/app/marketing/ads/rules-automation/budget-schedules/PlanEditor.tsx),
// which is the only surface that renders this component.
//
// Two rules the data has to obey or the chart lies:
//   • `actual` is null AFTER today  — what has not happened has no value.
//   • `forecast` is null BEFORE today — a projection cannot describe the past.
// The two series share day = today so the solid line and the dashed projection
// meet instead of leaving a gap (`connectNulls` is false by design).
//
// ResponsiveContainer needs a definite parent width and an explicit height, so
// every story sits in a Card body and passes `height`.
import { BurnDownChart, Card, type BurnDownPoint } from '@nexus/design-system'

/** Deterministic — no Math.random, so two captures of the same story are byte-identical. */
const burn = (days: number, today: number, planTotal: number, spendOnDay: (d: number) => number): BurnDownPoint[] => {
  const cumulative: number[] = []
  let run = 0
  for (let d = 1; d <= today; d++) {
    run += spendOnDay(d)
    cumulative[d] = run
  }
  // The straight-line projection the server computes: today's average rate,
  // extended flat to the end of the plan.
  const rate = run / today
  return Array.from({ length: days }, (_, i) => {
    const d = i + 1
    return {
      day: d,
      expected: Math.round((planTotal / days) * d),
      actual: d <= today ? Math.round(cumulative[d]!) : null,
      forecast: d >= today ? Math.round(run + rate * (d - today)) : null,
    }
  })
}

/** Weekends run lighter than weekdays — the shape every real ads plan has. */
const weekly = (weekday: number, weekend: number) => (d: number) => (d % 7 === 6 || d % 7 === 0 ? weekend : weekday)

const eur0 = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`

/** Mid-month, tracking a little under the planned pace: the projection lands short of the cap. */
export const OnTrack = () => (
  <Card header="August plan · Helmets · Auto">
    <BurnDownChart
      data={burn(30, 18, 4000, weekly(138, 84))}
      capValue={4000}
      capLabel="cap €4,000"
      todayDay={18}
      format={eur0}
      height={168}
    />
  </Card>
)

/** Over pace — the projection crosses the cap rule before month end, which is the whole point of drawing the cap. */
export const OverPace = () => (
  <Card header="August plan · Brand Defense">
    <BurnDownChart
      data={burn(30, 22, 4000, weekly(168, 112))}
      capValue={4000}
      capLabel="cap €4,000"
      todayDay={22}
      format={eur0}
      height={168}
    />
  </Card>
)

/** Day 4 of 31: four days of spend multiplied by 7.75. The projection is honest and useless, and the chart shows exactly why. */
export const ThinSample = () => (
  <Card header="September plan · Gloves · Manual">
    <BurnDownChart
      data={burn(31, 4, 6000, () => 265)}
      capValue={6000}
      capLabel="cap €6,000"
      todayDay={4}
      format={eur0}
      height={168}
    />
  </Card>
)

/** No cap on the plan: omit `capValue` and the threshold rule and its legend entry both disappear. */
export const Uncapped = () => (
  <Card header="Always-on portfolio · no monthly cap">
    <BurnDownChart data={burn(30, 21, 5200, weekly(174, 96))} todayDay={21} format={eur0} height={168} />
  </Card>
)
