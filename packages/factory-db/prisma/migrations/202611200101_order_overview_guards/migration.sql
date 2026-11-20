-- Written by hand (Prisma does not model functions), after 202611191202_order_page_paper_ddt_policies. When the migrations
-- are renumbered, keep this file as it is under its new timestamp. No table, column or policy change; the policy folder
-- after it is the generator's output again (scripts/factory/check-policy-parity.mjs: the policy migration comes last).
--
-- The order overview (order overview plan N12, D7; B-OO-015; schema wave 'order overview 1/1'): the cell floor counted every
-- cut-order line of a cell, whatever its material. One garment takes every material it is made of (its lining AND its
-- leather), so a cell cut in two materials held twice its garments: SEED-SO-0002's BLK cells, on the lining's SEED-CO-0001
-- and the leather's SEED-CO-0002 / SEED-CO-0003, floored at 2 / 4 / 2 for 1 / 2 / 1 wanted — a false "4 pieces made extra"
-- on the order page, and BLK 52 could not be lowered at all (its floor 4 above its 2).
--
-- Redefined: …_order_apply_guards' `factory_work_order_cell_floor` (its only body, 202611180101, word for word), with one
-- change in its third term, marked B-OO-015: the garments on cut orders are counted per material cut (the cut order's kind,
-- item and colour) and the floor takes the LARGEST material, not the sum of all. Within one material the lines still add up:
-- two cut orders (or two lines) of one material cut different garments of the cell — the planner lets live cut orders of
-- one material and colour hold at most the cell's quantity together (apps/factory-api production/cutorders: garmentsElsewhere,
-- factory-domain cellLeft). A recut of spoilt panels is a RECUT ticket, never a cut-order line, so it is never counted here.
-- Hides and bundles unchanged. Its readers keep reading it as they are: production's `factory_work_order_size_guard` and
-- `factory_work_order_material_guard` (…_order_apply_guards), the API's "Lower to the order", the change plan, "made extra",
-- the cancel check and the floor notes. The guard loosens, correctly: a cell goes down to the largest material on its cut
-- orders, never below it.

-- =====================================================================================================================
-- factory_work_order_cell_floor, the whole body of 202611180101_order_apply_guards, word for word, but for B-OO-015.

-- The least a cell of a RELEASED or IN_PROGRESS work order may go down to (R1: "never below what is already cut"; 0: it may
-- go), the largest of:
--   garments cut from hides  the fewest pieces of any planned hide part of the cell (a HIDE-tracked material of its planned
--                            materials, its part the BOM line's placement or the item's code: factory-domain production/cutting
--                            rules partOf and setsCut, "one piece per part per garment"), in cut log entries that are neither a
--                            reversal nor reversed (the API's cutCountsOf);
--   garments bundled         per part (null: whole garments), the garments of its bundles that are not VOID and not split off a
--                            bundle that is not VOID (a split leaves the parent's quantity as it was cut); the largest part;
--   garments on cut orders   per material (B-OO-015: the cut order's kind, item and colour), over its lines of cut orders not
--                            CANCELLED: what the reconciliation says was cut, else the line's garments (a planned, released,
--                            started or cut line holds them: re-plan or lower the line first); the largest material (a garment
--                            takes every material: two materials hold the same garments, never twice as many).
CREATE OR REPLACE FUNCTION "factory_work_order_cell_floor"(p_tenant uuid, p_cell uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(
    coalesce((SELECT min(coalesce(cut.pieces, 0))
                FROM (SELECT DISTINCT coalesce(NULLIF(btrim(b."placement"), ''), i."code") AS part
                        FROM "WorkOrderMaterial" m
                        JOIN "Item" i ON i."tenantId" = m."tenantId" AND i."id" = m."itemId" AND i."tracking" = 'HIDE'
                        LEFT JOIN "BomLine" b ON b."tenantId" = m."tenantId" AND b."id" = m."bomLineId"
                       WHERE m."tenantId" = p_tenant AND m."workOrderSizeId" = p_cell) planned
                LEFT JOIN (SELECT p."part", sum(p."pieces") AS pieces
                             FROM "CutLogPiece" p
                             JOIN "CutLog" g ON g."tenantId" = p."tenantId" AND g."id" = p."cutLogId"
                            WHERE p."tenantId" = p_tenant AND p."workOrderSizeId" = p_cell AND g."reversalOfId" IS NULL
                              AND NOT EXISTS (SELECT 1 FROM "CutLog" r WHERE r."tenantId" = g."tenantId" AND r."reversalOfId" = g."id")
                            GROUP BY p."part") cut ON cut."part" = planned.part), 0),
    coalesce((SELECT max(bundled.garments)
                FROM (SELECT sum(b."quantity") AS garments
                        FROM "Bundle" b
                       WHERE b."tenantId" = p_tenant AND b."workOrderSizeId" = p_cell AND b."status" <> 'VOID'
                         AND NOT EXISTS (SELECT 1 FROM "Bundle" parent
                                          WHERE parent."tenantId" = b."tenantId" AND parent."id" = b."parentBundleId" AND parent."status" <> 'VOID')
                       GROUP BY b."part") bundled), 0),
    -- B-OO-015: per material (kind, item, colour; a material with no colour is one group), the largest material.
    coalesce((SELECT max(material.garments)
                FROM (SELECT sum(coalesce(r."cutQuantity", l."quantity")) AS garments
                        FROM "CutOrderLine" l
                        JOIN "CutOrder" o ON o."tenantId" = l."tenantId" AND o."id" = l."cutOrderId" AND o."status" <> 'CANCELLED'
                        LEFT JOIN "CutReconciliation" r ON r."tenantId" = l."tenantId" AND r."cutOrderLineId" = l."id"
                       WHERE l."tenantId" = p_tenant AND l."workOrderSizeId" = p_cell
                       GROUP BY o."kind", o."itemId", o."itemColourId") material), 0)
  )::integer
$$;
