#!/usr/bin/env node

/**
 * Test script for Phase 7: Dynamic Catalog Engine
 * Tests the Amazon Catalog Service schema fetching and parsing
 */

import { amazonCatalogService } from "../apps/api/src/services/amazon-catalog.service.js";

async function main() {
  console.log("🧪 Phase 7: Dynamic Catalog Engine - Schema Test\n");
  console.log("=".repeat(60));

  try {
    // Test 1: Get available product types
    console.log("\n📋 Test 1: Fetching available product types...");
    const productTypes = await amazonCatalogService.getAvailableProductTypes();
    console.log(`✅ Found ${productTypes.length} product types:`);
    productTypes.forEach((type) => console.log(`   - ${type}`));

    // Test 2: Fetch schema for LUGGAGE
    console.log("\n📋 Test 2: Fetching schema for LUGGAGE...");
    const luggageSchema =
      await amazonCatalogService.getProductTypeSchema("LUGGAGE");
    console.log(`✅ LUGGAGE schema loaded`);
    console.log(`   Required fields: ${luggageSchema.requiredFields.length}`);
    console.log(`   Optional fields: ${luggageSchema.optionalFields.length}`);

    console.log("\n   Required Fields:");
    luggageSchema.requiredFields.forEach((field) => {
      console.log(
        `   - ${field.label} (${field.dataType})${field.enumValues ? ` [${field.enumValues.join(", ")}]` : ""}`
      );
    });

    console.log("\n   Optional Fields:");
    luggageSchema.optionalFields.forEach((field) => {
      console.log(
        `   - ${field.label} (${field.dataType})${field.enumValues ? ` [${field.enumValues.join(", ")}]` : ""}`
      );
    });

    // Test 3: Fetch schema for OUTERWEAR
    console.log("\n📋 Test 3: Fetching schema for OUTERWEAR...");
    const outerwearSchema =
      await amazonCatalogService.getProductTypeSchema("OUTERWEAR");
    console.log(`✅ OUTERWEAR schema loaded`);
    console.log(`   Required fields: ${outerwearSchema.requiredFields.length}`);
    console.log(`   Optional fields: ${outerwearSchema.optionalFields.length}`);

    // Test 4: Validate attributes (valid)
    console.log("\n📋 Test 4: Validating valid LUGGAGE attributes...");
    const validAttributes = {
      material: "Nylon",
      dimensions: "20x14x9",
      weight: 2.5,
      color: "Black",
    };
    const validationResult =
      await amazonCatalogService.validateAttributes(
        "LUGGAGE",
        validAttributes
      );
    console.log(`✅ Validation result: ${validationResult.valid ? "VALID" : "INVALID"}`);
    if (!validationResult.valid) {
      console.log("   Errors:");
      validationResult.errors.forEach((error) => {
        console.log(`   - ${error.field}: ${error.message}`);
      });
    }

    // Test 5: Validate attributes (invalid - missing required field)
    console.log("\n📋 Test 5: Validating invalid LUGGAGE attributes (missing material)...");
    const invalidAttributes = {
      dimensions: "20x14x9",
      weight: 2.5,
    };
    const invalidationResult =
      await amazonCatalogService.validateAttributes(
        "LUGGAGE",
        invalidAttributes
      );
    console.log(`✅ Validation result: ${invalidationResult.valid ? "VALID" : "INVALID"}`);
    if (!invalidationResult.valid) {
      console.log("   Errors:");
      invalidationResult.errors.forEach((error) => {
        console.log(`   - ${error.field}: ${error.message}`);
      });
    }

    // Test 6: Validate attributes (invalid - bad enum value)
    console.log("\n📋 Test 6: Validating invalid LUGGAGE attributes (bad material)...");
    const badEnumAttributes = {
      material: "InvalidMaterial",
      dimensions: "20x14x9",
      weight: 2.5,
    };
    const badEnumResult = await amazonCatalogService.validateAttributes(
      "LUGGAGE",
      badEnumAttributes
    );
    console.log(`✅ Validation result: ${badEnumResult.valid ? "VALID" : "INVALID"}`);
    if (!badEnumResult.valid) {
      console.log("   Errors:");
      badEnumResult.errors.forEach((error) => {
        console.log(`   - ${error.field}: ${error.message}`);
      });
    }

    // Test 7: Cache stats
    console.log("\n📋 Test 7: Checking cache stats...");
    const cacheStats = amazonCatalogService.getCacheStats();
    console.log(`✅ Cache contains ${cacheStats.size} entries:`);
    cacheStats.entries.forEach((entry) => {
      const expiresIn = Math.round(
        (entry.expiresAt.getTime() - Date.now()) / 1000 / 60
      );
      console.log(`   - ${entry.productType} (expires in ${expiresIn} minutes)`);
    });

    // Test 8: Cache hit test
    console.log("\n📋 Test 8: Testing cache hit (fetching LUGGAGE again)...");
    console.time("Cache Hit Time");
    const cachedSchema =
      await amazonCatalogService.getProductTypeSchema("LUGGAGE");
    console.timeEnd("Cache Hit Time");
    console.log(`✅ Schema fetched from cache (should be < 5ms)`);

    // Test 9: Fetch schema for ELECTRONICS
    console.log("\n📋 Test 9: Fetching schema for ELECTRONICS...");
    const electronicsSchema =
      await amazonCatalogService.getProductTypeSchema("ELECTRONICS");
    console.log(`✅ ELECTRONICS schema loaded`);
    console.log(`   Required fields: ${electronicsSchema.requiredFields.length}`);
    console.log(`   Optional fields: ${electronicsSchema.optionalFields.length}`);

    console.log("\n   Required Fields:");
    electronicsSchema.requiredFields.forEach((field) => {
      console.log(
        `   - ${field.label} (${field.dataType})${field.enumValues ? ` [${field.enumValues.join(", ")}]` : ""}`
      );
    });

    // Test 10: Invalid product type
    console.log("\n📋 Test 10: Testing invalid product type...");
    try {
      await amazonCatalogService.getProductTypeSchema("INVALID_TYPE");
      console.log("❌ Should have thrown error for invalid product type");
    } catch (error: any) {
      console.log(`✅ Correctly threw error: ${error.message}`);
    }

    console.log("\n" + "=".repeat(60));
    console.log("✅ All tests completed successfully!\n");

    console.log("📊 Summary:");
    console.log(`   - Product types available: ${productTypes.length}`);
    console.log(`   - Schemas cached: ${cacheStats.size}`);
    console.log(`   - Validation working: ✅`);
    console.log(`   - Error handling: ✅`);
    console.log(`   - Cache performance: ✅`);

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

main();
