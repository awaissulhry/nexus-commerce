#!/usr/bin/env node

/**
 * Sample Product Family Export Script
 * 
 * Exports a sample product family (VENTRA) to show the exact data structure
 */

import { PrismaClient } from "@nexus/database";

const prisma = new PrismaClient();

async function getSample() {
  try {
    console.log("📦 Fetching VENTRA product family...\n");

    // Get parent and children
    const sample = await prisma.$queryRaw<any[]>`
      SELECT 
        id,
        sku,
        name,
        "basePrice",
        "totalStock",
        "isParent",
        "parentId",
        "parentAsin",
        "fulfillmentMethod",
        "status",
        "createdAt",
        "updatedAt"
      FROM "Product"
      WHERE sku ILIKE '%VENTRA%'
      ORDER BY sku
      LIMIT 10
    `;

    console.log("Raw Product Data (JSON):\n");
    console.log(JSON.stringify(sample, null, 2));

    console.log("\n\n📊 Summary:");
    console.log(`Total VENTRA products: ${sample.length}`);
    
    const parents = sample.filter(p => p.isParent);
    const children = sample.filter(p => p.parentId !== null);
    const standalones = sample.filter(p => !p.isParent && p.parentId === null);
    
    console.log(`Parents: ${parents.length}`);
    console.log(`Children: ${children.length}`);
    console.log(`Standalones: ${standalones.length}`);

    if (parents.length > 0) {
      console.log("\nParent Details:");
      parents.forEach(p => {
        console.log(`  - ${p.sku} (ID: ${p.id})`);
      });
    }

    if (children.length > 0) {
      console.log("\nChild Details:");
      children.forEach(c => {
        console.log(`  - ${c.sku} (Parent ID: ${c.parentId})`);
      });
    }

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

getSample();
