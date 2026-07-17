/** FS4 — handle derivation (S-10): parity with the FS3 client's handleFor + collision suffixing. */
import { describe, expect, it } from "vitest";
import { deriveHandle, uniqueHandle } from "@/lib/auth/handle";
import { handleFor } from "@/lib/virtual/mention";

describe("deriveHandle", () => {
  it("derives first.last: trim · lowercase · whitespace→dots", () => {
    expect(deriveHandle("Ada Lovelace")).toBe("ada.lovelace");
    expect(deriveHandle("  Marco Rossi  ")).toBe("marco.rossi");
    expect(deriveHandle("solo")).toBe("solo");
  });

  it("collapses whitespace runs (tabs included) to ONE dot", () => {
    expect(deriveHandle("John   Smith")).toBe("john.smith");
    expect(deriveHandle("John\t Smith")).toBe("john.smith");
  });

  it("derives nothing from an empty name", () => {
    expect(deriveHandle("")).toBeNull();
    expect(deriveHandle("   ")).toBeNull();
  });

  it("matches the FS3 client's handleFor exactly — an inserted mention must resolve", () => {
    for (const name of ["Ada Lovelace", "  Marco  Rossi ", "solo", "Anna Maria Bianchi"]) {
      expect(deriveHandle(name)).toBe(handleFor(name));
    }
  });
});

describe("uniqueHandle", () => {
  it("keeps the bare handle when free", () => {
    expect(uniqueHandle("ada.lovelace", new Set())).toBe("ada.lovelace");
  });

  it("suffixes -2, -3… in order until free", () => {
    expect(uniqueHandle("john.smith", new Set(["john.smith"]))).toBe("john.smith-2");
    expect(uniqueHandle("john.smith", new Set(["john.smith", "john.smith-2"]))).toBe("john.smith-3");
    expect(uniqueHandle("john.smith", new Set(["john.smith", "john.smith-2", "john.smith-3"]))).toBe("john.smith-4");
  });

  it("ignores unrelated near-matches in the taken set", () => {
    expect(uniqueHandle("ann", new Set(["anna", "ann-x"]))).toBe("ann");
  });
});
