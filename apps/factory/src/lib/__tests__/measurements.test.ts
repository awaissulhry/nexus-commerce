/** FP5.2 — the head-version + history-chain organization behind the editor. */
import { describe, expect, it } from "vitest";
import { organizeProfiles } from "../contacts/measurements";

const p = (id: string, garmentType: string, version: number, supersedesId: string | null = null) => ({ id, garmentType, version, supersedesId });

describe("organizeProfiles", () => {
  it("picks the head (nothing supersedes it) as current, older as history", () => {
    const v1 = p("a", "Jacket", 1);
    const v2 = p("b", "Jacket", 2, "a");
    const v3 = p("c", "Jacket", 3, "b");
    const [group] = organizeProfiles([v1, v3, v2]);
    expect(group.current.id).toBe("c");
    expect(group.history.map((h) => h.id)).toEqual(["b", "a"]); // newest→oldest
  });

  it("groups by garment type, sorted", () => {
    const groups = organizeProfiles([p("j", "Jacket", 1), p("t", "Trousers", 1)]);
    expect(groups.map((g) => g.garmentType)).toEqual(["Jacket", "Trousers"]);
    expect(groups.every((g) => g.history.length === 0)).toBe(true);
  });

  it("keeps two independent chains for the same garment as separate heads", () => {
    const groups = organizeProfiles([p("a", "Jacket", 1), p("b", "Jacket", 2, "a"), p("x", "Jacket", 1)]);
    const jackets = groups.filter((g) => g.garmentType === "Jacket");
    expect(jackets.length).toBe(2);
  });

  it("survives a broken supersedes pointer without looping", () => {
    const groups = organizeProfiles([p("a", "Jacket", 2, "missing")]);
    expect(groups[0].current.id).toBe("a");
    expect(groups[0].history).toEqual([]);
  });
});
