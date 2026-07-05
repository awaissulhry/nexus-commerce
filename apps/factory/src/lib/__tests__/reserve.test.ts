/** FP6 — priority material allocation: scarce stock goes to the top of the queue. */
import { describe, expect, it } from "vitest";
import { allocateByPriority, toDemand } from "../production/reserve";

describe("allocateByPriority", () => {
  it("covers everyone when stock is ample", () => {
    const cov = allocateByPriority({ hide: 100 }, [{ id: "a", demand: { hide: 10 } }, { id: "b", demand: { hide: 10 } }]);
    expect(cov.a.status).toBe("OK");
    expect(cov.b.status).toBe("OK");
  });

  it("gives scarce hide to the higher-priority WO first", () => {
    // 15 hide, two WOs need 10 each; the first in the list (higher priority) wins
    const cov = allocateByPriority({ hide: 15 }, [{ id: "rush", demand: { hide: 10 } }, { id: "later", demand: { hide: 10 } }]);
    expect(cov.rush.status).toBe("OK");
    expect(cov.later.status).toBe("SHORT");
    expect(cov.later.short).toEqual(["hide"]);
  });

  it("flags PARTIAL when one of several materials is short", () => {
    const cov = allocateByPriority({ hide: 10, thread: 0 }, [{ id: "a", demand: { hide: 5, thread: 2 } }]);
    expect(cov.a.status).toBe("PARTIAL");
    expect(cov.a.short).toEqual(["thread"]);
  });

  it("SHORT when nothing is available", () => {
    const cov = allocateByPriority({}, [{ id: "a", demand: { hide: 5 } }]);
    expect(cov.a.status).toBe("SHORT");
  });

  it("a WO with no material demand is trivially OK", () => {
    const cov = allocateByPriority({ hide: 0 }, [{ id: "a", demand: {} }]);
    expect(cov.a.status).toBe("OK");
  });

  it("reordering priority flips who is short (same stock)", () => {
    const wos = [{ id: "x", demand: { hide: 10 } }, { id: "y", demand: { hide: 10 } }];
    const forward = allocateByPriority({ hide: 12 }, wos);
    expect(forward.x.status).toBe("OK");
    expect(forward.y.status).toBe("SHORT");
    const reversed = allocateByPriority({ hide: 12 }, [wos[1], wos[0]]);
    expect(reversed.y.status).toBe("OK");
    expect(reversed.x.status).toBe("SHORT");
  });
});

describe("toDemand", () => {
  it("sums draws by material", () => {
    expect(toDemand([{ materialId: "hide", qty: 2 }, { materialId: "hide", qty: 3 }, { materialId: "thread", qty: 1 }])).toEqual({ hide: 5, thread: 1 });
  });
});
