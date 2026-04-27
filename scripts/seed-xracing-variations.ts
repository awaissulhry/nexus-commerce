#!/usr/bin/env node

import { PrismaClient } from "@nexus/database";

const prisma = new PrismaClient();

async function seedXracingVariations() {
  try {
    console.log("🌱 Starting xracing variation seed...\n");

    // Step 1: Find or create the xracing master product
    console.log("📦 Step 1: Finding/creating xracing master product...");
    let xracingProduct = await prisma.product.findUnique({
      where: { sku: "xracing" },
    });

    if (!xracingProduct) {
      console.log("   Creating new xracing product...");
      xracingProduct = await prisma.product.create({
        data: {
          sku: "xracing",
          name: "XRacing Pro Helmet",
          basePrice: 199.99,
          totalStock: 150,
          isParent: true,
          status: "ACTIVE",
          brand: "XRacing",
          bulletPoints: [
            "Professional racing helmet",
            "DOT certified",
            "Multiple color options",
            "Lightweight design",
          ],
          keywords: ["racing", "helmet", "motorsport", "safety"],
        },
      });
      console.log(`   ✅ Created xracing product (ID: ${xracingProduct.id})\n`);
    } else {
      console.log(`   ✅ Found existing xracing product (ID: ${xracingProduct.id})`);
      // Ensure it's marked as parent
      if (!xracingProduct.isParent) {
        xracingProduct = await prisma.product.update({
          where: { id: xracingProduct.id },
          data: { isParent: true },
        });
        console.log(`   ✅ Updated to isParent = true\n`);
      } else {
        console.log(`   ✅ Already marked as parent\n`);
      }
    }

    // Step 2: Create child products (color variations)
    console.log("🎨 Step 2: Creating color variation children...");
    const colorVariations = [
      { sku: "xracing-red", color: "Red", stock: 45 },
      { sku: "xracing-blue", color: "Blue", stock: 52 },
      { sku: "xracing-black", color: "Black", stock: 53 },
    ];

    const childProducts = [];
    for (const variant of colorVariations) {
      let childProduct = await prisma.product.findUnique({
        where: { sku: variant.sku },
      });

      if (!childProduct) {
        childProduct = await prisma.product.create({
          data: {
            sku: variant.sku,
            name: `XRacing Pro Helmet - ${variant.color}`,
            basePrice: 199.99,
            totalStock: variant.stock,
            isParent: false,
            masterProductId: xracingProduct.id,
            status: "ACTIVE",
            brand: "XRacing",
            categoryAttributes: {
              color: variant.color,
            },
          },
        });
        console.log(`   ✅ Created ${variant.sku} (ID: ${childProduct.id})`);
      } else {
        // Update to link to parent if not already linked
        if ((childProduct as any).masterProductId !== xracingProduct.id) {
          childProduct = await prisma.product.update({
            where: { id: childProduct.id },
            data: {
              masterProductId: xracingProduct.id,
              isParent: false,
            },
          });
          console.log(`   ✅ Updated ${variant.sku} to link to parent`);
        } else {
          console.log(`   ✅ ${variant.sku} already linked to parent`);
        }
      }
      childProducts.push(childProduct);
    }
    console.log("");

    // Step 3: Create Amazon ChannelListing with variation theme
    console.log("🛒 Step 3: Creating Amazon ChannelListing with variation theme...");
    let amazonListing = await (prisma as any).channelListing.findUnique({
      where: {
        productId_channelMarket: {
          productId: xracingProduct.id,
          channelMarket: "AMAZON_US",
        },
      },
    });

    if (!amazonListing) {
      amazonListing = await (prisma as any).channelListing.create({
        data: {
          productId: xracingProduct.id,
          channelMarket: "AMAZON_US",
          channel: "AMAZON",
          region: "US",
          title: "XRacing Pro Helmet - Multiple Colors",
          description:
            "Professional racing helmet available in Red, Blue, and Black. DOT certified with lightweight design.",
          price: 199.99,
          quantity: 150,
          listingStatus: "ACTIVE",
          variationTheme: "Color",
          variationMapping: {
            Color: {
              masterAttribute: "color",
              platformAttribute: "Color",
              values: {
                Red: "Red",
                Blue: "Blue",
                Black: "Black",
              },
            },
          },
          platformAttributes: {
            browseNodeId: "3398051",
            bulletPoints: [
              "Professional racing helmet",
              "DOT certified",
              "Multiple color options",
              "Lightweight design",
            ],
            searchTerms: ["racing helmet", "motorsport", "safety gear"],
          },
        },
      });
      console.log(`   ✅ Created Amazon listing (ID: ${amazonListing.id})\n`);
    } else {
      // Update existing listing with variation theme
      amazonListing = await (prisma as any).channelListing.update({
        where: { id: amazonListing.id },
        data: {
          variationTheme: "Color",
          variationMapping: {
            Color: {
              masterAttribute: "color",
              platformAttribute: "Color",
              values: {
                Red: "Red",
                Blue: "Blue",
                Black: "Black",
              },
            },
          },
        },
      });
      console.log(`   ✅ Updated Amazon listing with variation theme\n`);
    }

    // Step 4: Create Offers for each fulfillment method
    console.log("📦 Step 4: Creating Offers (FBA & FBM)...");
    const fulfillmentMethods = ["FBA", "FBM"];

    for (const method of fulfillmentMethods) {
      let offer = await (prisma as any).offer.findUnique({
        where: {
          channelListingId_fulfillmentMethod: {
            channelListingId: amazonListing.id,
            fulfillmentMethod: method as any,
          },
        },
      });

      if (!offer) {
        offer = await (prisma as any).offer.create({
          data: {
            channelListingId: amazonListing.id,
            fulfillmentMethod: method as any,
            sku: `xracing-${method.toLowerCase()}`,
            price: 199.99,
            quantity: 150,
            isActive: true,
            offerMetadata:
              method === "FBA"
                ? {
                    fcCode: "PHX3",
                    prepRequired: false,
                  }
                : {
                    shippingTemplate: "Standard Shipping",
                    handlingTime: 1,
                    shippingCost: 0,
                  },
          },
        });
        console.log(`   ✅ Created ${method} offer (ID: ${offer.id})`);
      } else {
        console.log(`   ✅ ${method} offer already exists`);
      }
    }
    console.log("");

    // Summary
    console.log("✨ Seed completed successfully!\n");
    console.log("📊 Summary:");
    console.log(`   Master Product: ${xracingProduct.sku} (ID: ${xracingProduct.id})`);
    console.log(`   Child Products: ${childProducts.length}`);
    childProducts.forEach((child) => {
      console.log(`     - ${child.sku} (ID: ${child.id})`);
    });
    console.log(`   Amazon Listing: ${amazonListing.channelMarket} (ID: ${amazonListing.id})`);
    console.log(`   Variation Theme: ${amazonListing.variationTheme}`);
    console.log("");
    console.log("🔗 View the product at:");
    console.log(`   http://localhost:3000/catalog/${xracingProduct.id}/edit`);
    console.log("");
  } catch (error) {
    console.error("❌ Error seeding xracing variations:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

seedXracingVariations();
