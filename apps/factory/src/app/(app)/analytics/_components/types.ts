/** FP10 — analytics workspace shapes (cents optional: grain-stripped for a margin-blind caller). */
export type Counters = { unansweredThreads: number; quotesAwaiting: number; overduePromises: number };

export type ThroughputPoint = { weekKey: string; count: number };
export type StageLead = { stage: string; medianMs: number; count: number };
export type OnTime = { onTime: number; late: number; unknown: number; rate: number };
export type PartyAgg = { partyId: string; partyName: string; orders: number; netCents?: number; paidCents?: number; outstandingCents?: number; actualMarginCents?: number };
export type PeriodAgg = { monthKey: string; orders: number; netCents?: number; invoicedCents?: number; paidCents?: number; outstandingCents?: number; actualMarginCents?: number };
export type ProductMargin = { product: string; orders: number; netCents?: number; estMarginCents?: number; estMarginPct?: number };
export type WinLoss = { won: number; lost: number; open: number; rate: number; byReason: { reason: string; count: number }[] };

export type SavedViewRow = { id: string; name: string; config: { from?: string; to?: string } };

export type AnalyticsResponse = {
  throughput: ThroughputPoint[];
  leadTimes: StageLead[];
  bottleneckStage: string | null;
  onTime: OnTime;
  marginByParty: PartyAgg[];
  marginByMonth: PeriodAgg[];
  marginByProduct: ProductMargin[];
  winLoss: WinLoss;
};
