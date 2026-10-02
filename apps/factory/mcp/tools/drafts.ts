/**
 * P12 — the factory drafts (plan section 09 §5 outline 4), with a `read,draft` token only and at most 100 a day
 * (mcp/door.ts). Each goes through the same code the factory app runs, and nothing leaves the factory:
 *
 *   factory-draft-quote            a DRAFT quote for a customer, with unpriced lines — never sent (quotes.send stays
 *                                  the Owner's click); the Owner prices and sends it in the quote rail
 *   factory-draft-purchase-order   a DRAFT purchase order for a supplier — never sent to the supplier from here
 *   factory-add-comment            an internal comment on an order, quote, work order or purchase order; @mentions
 *                                  notify inside the factory only
 *   factory-advance-work-order     start, pause, resume or finish the CURRENT stage of a work order, as the floor
 *                                  does: forward only (the factory floor has no step back), the QC certificate gate,
 *                                  the work order and order states that follow
 *
 * Every draft says, in its answer, that it came from Claude; the door's audit row names the connection.
 */
import { z } from "zod/v4";
import { prisma } from "../../src/lib/db";
import { createComment } from "../../src/lib/comments";
import { addDraftQuoteLine, createDraftQuote } from "../../src/lib/quotes/create-draft";
import { createDraftPurchaseOrder } from "../../src/lib/materials/purchase-order-draft";
import { runStageAction } from "../../src/lib/production/stage-action";
import { currentStage, type StageRow } from "../../src/lib/production/stage-timer";
import { ToolRefusal, type FactoryTool } from "./types";

/** A party by its id, or by its exact name (any case) among the kinds given; refused when none or several match. */
async function partyOf(ref: string, kinds: Array<"CUSTOMER" | "BRAND" | "SUPPLIER">, what: string) {
  const byId = await prisma.party.findFirst({ where: { id: ref, kind: { in: kinds }, archivedAt: null }, select: { id: true, name: true } });
  if (byId) return byId;
  const byName = await prisma.party.findMany({ where: { kind: { in: kinds }, archivedAt: null, name: ref }, select: { id: true, name: true }, take: 2 });
  const fuzzy = byName.length
    ? byName
    : (await prisma.party.findMany({ where: { kind: { in: kinds }, archivedAt: null }, select: { id: true, name: true }, take: 2000 }))
        .filter((p) => p.name.toLowerCase() === ref.trim().toLowerCase());
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) throw new ToolRefusal(`Several ${what}s are called "${ref}": name one by its id.`);
  throw new ToolRefusal(`${what[0].toUpperCase()}${what.slice(1)} not found: "${ref}".`);
}

const FROM_CLAUDE = "(from Claude) ";

const draftQuote: FactoryTool = {
  name: "factory-draft-quote",
  title: "Draft a factory quote",
  description:
    "Create a DRAFT quote for a customer (by name or id), optionally linked to a mail thread, with up to 20 unpriced "
    + "lines (a description, and a product template id when known). It is never sent: the Owner prices it in the quote "
    + "rail and sends it from the factory app. Counts toward the connection's 100 drafts a day.",
  readOnly: false,
  input: z.object({
    customer: z.string().trim().min(1).max(120).describe("the customer: its exact name or its id"),
    conversationId: z.string().trim().min(1).max(64).optional().describe("the mail thread the quote answers (from factory-inbox)"),
    lines: z.array(z.object({
      description: z.string().trim().min(1).max(300).describe("what the line is, e.g. 'Race suit, kangaroo, size 52'"),
      templateId: z.string().trim().min(1).max(64).optional().describe("the product template id, when known"),
    })).max(20).optional().describe("the lines, unpriced (at most 20)"),
  }),
  async run(args, { user }) {
    const customer = await partyOf(String(args.customer), ["CUSTOMER", "BRAND"], "customer");
    const conversationId = (args.conversationId as string | undefined) ?? null;
    if (conversationId && !(await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } }))) {
      throw new ToolRefusal("Mail thread not found.");
    }
    const created = await createDraftQuote({ partyId: customer.id, conversationId, actorId: user.id });
    if (!created.ok) throw new ToolRefusal(created.error);
    const lines = (args.lines as Array<{ description: string; templateId?: string }> | undefined) ?? [];
    for (const line of lines) {
      const added = await addDraftQuoteLine({ quoteId: created.quote.id, templateId: line.templateId ?? null, description: `${FROM_CLAUDE}${line.description}`.slice(0, 300), actorId: user.id });
      if (!added.ok) throw new ToolRefusal(added.error);
    }
    return {
      quote: { id: created.quote.id, number: created.quote.number, state: created.quote.state, customer: customer.name },
      lines: lines.length,
      next: "A DRAFT in the factory app: price its lines in the quote rail and send it from there. Nothing was sent.",
    };
  },
};

const draftPurchaseOrder: FactoryTool = {
  name: "factory-draft-purchase-order",
  title: "Draft a purchase order",
  description:
    "Create a DRAFT purchase order for a supplier (by name or id) with up to 50 lines: a material (by name or id), "
    + "the quantity in the material's unit and the unit cost in cents. It is never sent to the supplier: a person "
    + "checks and sends it from the factory app. Counts toward the connection's 100 drafts a day.",
  readOnly: false,
  input: z.object({
    supplier: z.string().trim().min(1).max(120).describe("the supplier: its exact name or its id"),
    expectedAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("when it should arrive, YYYY-MM-DD"),
    lines: z.array(z.object({
      material: z.string().trim().min(1).max(120).describe("the material: its exact name or its id"),
      qty: z.number().positive().max(1_000_000).describe("how much, in the material's own unit"),
      unitCostCents: z.number().int().min(0).max(100_000_000).describe("the agreed price per unit, in cents"),
    })).min(1).max(50).describe("the lines (1 to 50)"),
  }),
  async run(args, { user }) {
    const supplier = await partyOf(String(args.supplier), ["SUPPLIER"], "supplier");
    const wanted = args.lines as Array<{ material: string; qty: number; unitCostCents: number }>;
    const lines = [];
    for (const line of wanted) {
      const byId = await prisma.material.findFirst({ where: { id: line.material, archivedAt: null }, select: { id: true, unit: true, name: true } });
      const candidates = byId
        ? [byId]
        : (await prisma.material.findMany({ where: { archivedAt: null }, select: { id: true, unit: true, name: true }, take: 2000 }))
            .filter((m) => m.name.toLowerCase() === line.material.trim().toLowerCase());
      if (candidates.length !== 1) throw new ToolRefusal(candidates.length ? `Several materials are called "${line.material}": name one by its id.` : `Material not found: "${line.material}".`);
      lines.push({ materialId: candidates[0].id, qty: line.qty, unit: candidates[0].unit, unitCostCents: line.unitCostCents });
    }
    const created = await createDraftPurchaseOrder({ supplierId: supplier.id, expectedAt: (args.expectedAt as string | undefined) ?? null, lines, actorId: user.id });
    if (!created.ok) throw new ToolRefusal(created.error);
    return {
      purchaseOrder: { id: created.purchaseOrder.id, number: created.purchaseOrder.number, state: "DRAFT", supplier: supplier.name },
      lines: lines.length,
      next: "A DRAFT in the factory app: check it and send it to the supplier from there. Nothing was sent.",
    };
  },
};

const ENTITIES = ["order", "quote", "workorder", "purchaseorder"] as const;

/** The record a comment goes on, by its number or id; refused when it does not exist. */
async function entityOf(on: (typeof ENTITIES)[number], ref: string): Promise<{ id: string; label: string; href: string }> {
  const where = { OR: [{ id: ref }, { number: ref }] };
  const row =
    on === "order" ? await prisma.order.findFirst({ where, select: { id: true, number: true } })
    : on === "quote" ? await prisma.quote.findFirst({ where, select: { id: true, number: true } })
    : on === "workorder" ? await prisma.workOrder.findFirst({ where, select: { id: true, number: true } })
    : await prisma.purchaseOrder.findFirst({ where, select: { id: true, number: true } });
  if (!row) throw new ToolRefusal(`${on === "workorder" ? "Work order" : on === "purchaseorder" ? "Purchase order" : on[0].toUpperCase() + on.slice(1)} not found: "${ref}".`);
  const href = on === "order" ? `/orders?o=${row.id}` : on === "quote" ? `/quotes?q=${row.id}` : on === "workorder" ? `/production?wo=${row.id}` : `/materials?po=${row.id}`;
  return { id: row.id, label: row.number, href };
}

const addComment: FactoryTool = {
  name: "factory-add-comment",
  title: "Add a factory comment",
  description:
    "Add an internal comment to an order, quote, work order or purchase order (by its number or id). @first.last "
    + "mentions notify those people inside the factory app; nothing is sent to a customer or supplier. The comment "
    + "starts with \"(from Claude)\". Counts toward the connection's 100 drafts a day.",
  readOnly: false,
  input: z.object({
    on: z.enum(ENTITIES).describe("what the comment is on"),
    ref: z.string().trim().min(1).max(64).describe("its number (e.g. ORD-214, WO-88) or id"),
    body: z.string().trim().min(1).max(2000).describe("the comment; @first.last mentions a colleague"),
  }),
  async run(args, { user }) {
    const on = args.on as (typeof ENTITIES)[number];
    const entity = await entityOf(on, String(args.ref));
    const comment = await createComment({
      entityType: on,
      entityId: entity.id,
      body: `${FROM_CLAUDE}${String(args.body)}`,
      authorId: user.id,
      authorName: `${user.displayName} (via Claude)`,
      href: entity.href,
    });
    return { comment: { id: comment.id, on, ref: entity.label }, mentioned: Array.isArray(comment.mentions) ? comment.mentions.length : 0 };
  },
};

const advanceWorkOrder: FactoryTool = {
  name: "factory-advance-work-order",
  title: "Move a work order stage",
  description:
    "Start, pause, resume or finish the CURRENT stage of a work order (by its number or id), exactly as the floor does: "
    + "a stage starts only after the earlier ones are finished, QC finishes only with a valid certificate, finishing the "
    + "last stage completes the work order (and the order is ready when all its work orders are). Forward only: the "
    + "factory floor has no step back. Counts toward the connection's 100 drafts a day.",
  readOnly: false,
  input: z.object({
    workOrder: z.string().trim().min(1).max(64).describe("the work order number (e.g. WO-88) or id"),
    action: z.enum(["start", "pause", "resume", "finish"]).describe("what to do with its current stage"),
  }),
  async run(args, { user }) {
    const ref = String(args.workOrder);
    const workOrder = await prisma.workOrder.findFirst({
      where: { OR: [{ id: ref }, { number: ref }] },
      select: { id: true, number: true, state: true, stages: { select: { id: true, stage: true, sort: true, startedAt: true, pausedMs: true, pausedAt: true, finishedAt: true } } },
    });
    if (!workOrder) throw new ToolRefusal(`Work order not found: "${ref}".`);
    if (workOrder.state === "CANCELLED") throw new ToolRefusal(`${workOrder.number} is cancelled.`);
    const current = currentStage(workOrder.stages as unknown as StageRow[]);
    if (!current) throw new ToolRefusal(`${workOrder.number} has finished every stage.`);
    const result = await runStageAction({ stageId: current.id, action: args.action as "start" | "pause" | "resume" | "finish", actorId: user.id });
    if (!result.ok) throw new ToolRefusal(`${workOrder.number}, stage ${current.stage}: ${result.body.error}`);
    return { workOrder: workOrder.number, stage: current.stage, action: args.action, workOrderDone: result.woDone, orderReady: result.orderReady };
  },
};

export const DRAFT_TOOLS: FactoryTool[] = [draftQuote, draftPurchaseOrder, addComment, advanceWorkOrder];
