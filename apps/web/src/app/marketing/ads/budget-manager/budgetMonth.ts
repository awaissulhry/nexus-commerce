/**
 * AM-36 — the month the Budget Manager opens on is the month of today's BUDGET day, and a budget day runs
 * 00:00–24:00 UTC (the enforcement engine's boundary, stated by the API as `dayBoundary`). It was the browser's LOCAL
 * month, so from 00:00 to 02:00 Rome time on the 1st the page asked for the new month while every budget day, pace and
 * spend figure still belonged to the old one ("Day 30 of 30 · pace counts 0 complete days").
 */
export const budgetMonthOf = (now: Date = new Date()): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
