/**
 * FP10 — margin by product: order lines grouped by product (their description),
 * with revenue and ESTIMATED margin (net − line cost). Actual margin lives at the
 * order/customer/month level (FP9) because consumed-hide cost is captured per work
 * order, not per product line — so product margin is the estimate, labelled. Pure.
 */
export type ProductLine = { product: string; netPriceCents: number; costCents: number; qty: number };
export type ProductMargin = { product: string; orders: number; netCents: number; estMarginCents: number; estMarginPct: number };

export function marginByProduct(lines: ProductLine[]): ProductMargin[] {
  const by = new Map<string, { net: number; cost: number; n: number }>();
  for (const l of lines) {
    const key = (l.product ?? "").trim() || "(unnamed)";
    const q = l.qty ?? 1;
    const r = by.get(key) ?? { net: 0, cost: 0, n: 0 };
    r.net += (l.netPriceCents ?? 0) * q;
    r.cost += (l.costCents ?? 0) * q;
    r.n += 1;
    by.set(key, r);
  }
  return [...by.entries()]
    .map(([product, r]) => ({ product, orders: r.n, netCents: r.net, estMarginCents: r.net - r.cost, estMarginPct: r.net > 0 ? ((r.net - r.cost) / r.net) * 100 : 0 }))
    .sort((a, b) => b.netCents - a.netCents);
}
