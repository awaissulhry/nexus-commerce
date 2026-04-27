#!/usr/bin/env node

import { PrismaClient } from "@nexus/database";

const prisma = new PrismaClient();

async function testQuery() {
  console.log("🔍 Testing raw SQL query...\n");

  try {
    const products = (await (prisma as any).$queryRaw`
      SELECT 
        p.id, p.sku, p.name, p."amazonAsin", p."ebayItemId", 
        p."basePrice", p."totalStock", p."isParent", p."fulfillmentChannel",
        p."fulfillmentMethod", p.brand, p."createdAt", p."updatedAt",
        COALESCE(json_agg(
          json_build_object(
            'id', c.id,
            'sku', c.sku,
            'name', c.name,
            'amazonAsin', c."amazonAsin",
            'ebayVariationId', c."ebayItemId",
            'price', c."basePrice",
            'stock', c."totalStock",
            'fulfillmentMethod', c."fulfillmentMethod",
            'value', c.name
          ) ORDER BY c.sku
        ) FILTER (WHERE c.id IS NOT NULL), '[]'::json) as children
      FROM "Product" p
      LEFT JOIN "Product" c ON c."parentId" = p.id
      WHERE p."parentId" IS NULL
      GROUP BY p.id, p.sku, p.name, p."amazonAsin", p."ebayItemId", 
               p."basePrice", p."totalStock", p."isParent", p."fulfillmentChannel",
               p."fulfillmentMethod", p.brand, p."createdAt", p."updatedAt"
      ORDER BY p."updatedAt" DESC
    `) as any[];

    console.log(`✅ Query returned ${products.length} rows\n`);
    
    // Show first 5 products
    products.slice(0, 5).forEach((p: any, idx: number) => {
      console.log(`Product ${idx + 1}: ${p.sku} (isParent: ${p.isParent}, children: ${Array.isArray(p.children) ? p.children.length : 0})`);
    });

    // Count parents
    const parentCount = products.filter((p: any) => p.isParent === true).length;
    console.log(`\n📊 Parents: ${parentCount}`);
    console.log(`📊 Total rows: ${products.length}`);

  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

testQuery();
