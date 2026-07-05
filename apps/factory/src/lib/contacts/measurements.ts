/**
 * FP5.2 — organize a flat list of measurement-profile versions into, per garment
 * type, the CURRENT head (the version nothing supersedes) and its immutable
 * history chain (newest→oldest). Pure — the source of truth for the editor.
 */
export type ProfileLike = { id: string; garmentType: string; version: number; supersedesId: string | null };

export type GarmentGroup<P extends ProfileLike> = { garmentType: string; current: P; history: P[] };

export function organizeProfiles<P extends ProfileLike>(profiles: P[]): GarmentGroup<P>[] {
  const superseded = new Set(profiles.map((p) => p.supersedesId).filter(Boolean) as string[]);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const heads = profiles.filter((p) => !superseded.has(p.id));

  const chainOf = (head: P): P[] => {
    const out: P[] = [];
    let cur = head.supersedesId;
    const guard = new Set<string>();
    while (cur && byId.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      const p = byId.get(cur)!;
      out.push(p);
      cur = p.supersedesId;
    }
    return out;
  };

  return heads
    .map((h) => ({ garmentType: h.garmentType, current: h, history: chainOf(h) }))
    .sort((a, b) => (a.garmentType < b.garmentType ? -1 : a.garmentType > b.garmentType ? 1 : b.current.version - a.current.version));
}
