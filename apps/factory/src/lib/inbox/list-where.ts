/**
 * EPI1.2 — ONE builder for the inbox list filters, shared by the row query
 * and the tab counts so the counts can never disagree with what the tabs
 * show (EPI-UI-INVENTORY G8: counts used to ignore Mine/Unmatched/search).
 * `base` carries every filter EXCEPT state — the counts groupBy uses it so
 * each state tab shows how many of the CURRENTLY FILTERED threads it holds.
 */

export type ListFilterParams = {
  state: string; // "OPEN" | "SNOOZED" | "CLOSED" | "ALL"
  mine: boolean;
  unmatched: boolean;
  q: string;
  actorId: string;
};

export function buildListWhere(p: ListFilterParams): {
  base: Record<string, unknown>;
  where: Record<string, unknown>;
} {
  const base: Record<string, unknown> = {
    ...(p.mine ? { assigneeId: p.actorId } : {}),
    ...(p.unmatched ? { partyId: null } : {}),
    ...(p.q
      ? {
          OR: [
            { subject: { contains: p.q } },
            { party: { name: { contains: p.q } } },
            { messages: { some: { fromAddress: { contains: p.q.toLowerCase() } } } },
          ],
        }
      : {}),
  };
  const where = { ...base, ...(p.state !== "ALL" ? { state: p.state } : {}) };
  return { base, where };
}
