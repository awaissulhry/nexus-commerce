/**
 * FP10 — on-time vs promise: for orders that shipped, was the ship date on or
 * before the promised date? A row missing either date is "unknown" and left out
 * of the rate (honest — don't inflate the denominator). Pure; compares by
 * calendar day (a promise is a day, not a minute).
 */
const day = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

export type OnTimeInput = { promiseISO: string | null; shippedISO: string | null };
export type OnTime = { onTime: number; late: number; unknown: number; rate: number };

export function onTimeRate(rows: OnTimeInput[]): OnTime {
  let onTime = 0;
  let late = 0;
  let unknown = 0;
  for (const r of rows) {
    if (!r.promiseISO || !r.shippedISO) { unknown++; continue; }
    if (day(r.shippedISO) <= day(r.promiseISO)) onTime++;
    else late++;
  }
  const settled = onTime + late;
  return { onTime, late, unknown, rate: settled > 0 ? (onTime / settled) * 100 : 0 };
}
