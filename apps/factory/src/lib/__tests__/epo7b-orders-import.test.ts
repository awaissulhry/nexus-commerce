/** EPO.7b — historical-order CSV parse (pure phase of the dry-run idiom). */
import { describe, expect, it } from "vitest";
import { parseOrdersCsv, ordersTemplateCsv } from "@/lib/imports/orders";

const HEAD = "party,description,qty,unit_net_eur,unit_cost_eur,state,confirmed_date,promise_date,number,client_ref";

describe("parseOrdersCsv", () => {
  it("parses the template", () => {
    const { ops, errors } = parseOrdersCsv(ordersTemplateCsv());
    expect(errors).toHaveLength(0);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ partyName: "Aireon", qty: 10, netPriceCents: 45000, costCents: 26000, state: "CLOSED", clientRef: "PO-2025-114", number: null });
    expect(ops[0].promiseAt).toBeInstanceOf(Date);
  });
  it("defaults: state CLOSED, qty 1, blank money = 0; comma decimals accepted", () => {
    const { ops, errors } = parseOrdersCsv(`${HEAD}\nAcme,Belt,,"12,50",,,,,,`);
    expect(errors).toHaveLength(0);
    expect(ops[0]).toMatchObject({ qty: 1, netPriceCents: 1250, costCents: 0, state: "CLOSED" });
  });
  it("collects per-row errors with 1-based data rows", () => {
    const { ops, errors } = parseOrdersCsv(`${HEAD}\n,Belt,1,10,5,CLOSED,,,,\nAcme,,1,10,5,CLOSED,,,,\nAcme,Belt,0,10,5,CLOSED,,,,\nAcme,Belt,1,abc,5,CLOSED,,,,\nAcme,Belt,1,10,5,WRONG,,,,\nAcme,Belt,1,10,5,CLOSED,not-a-date,,,`);
    expect(ops).toHaveLength(0);
    expect(errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(errors[0].error).toMatch(/party/);
    expect(errors[4].error).toMatch(/state/);
  });
});
