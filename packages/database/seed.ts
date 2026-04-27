import { config } from "dotenv";
import { resolve } from "path";
// Load root .env (holds both DATABASE_URL and ENCRYPTION_KEY)
config({ path: resolve(__dirname, "../../.env") });
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { Vault } from "@nexus/shared";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("ENCRYPTION_KEY is not set in .env");

  const vault = new Vault(encryptionKey);

  // Encrypt the marketplace API key before storing it
  const encryptedToken = vault.encrypt("secret_amazon_token");
  console.log("Encrypted token:", encryptedToken);

  // Upsert so re-running the seed is safe
  const product = await prisma.product.upsert({
    where: { sku: "NXS-001" },
    update: {},
    create: {
      sku: "NXS-001",
      name: "Test Product",
      basePrice: 29.99,
      totalStock: 100,
    },
  });
  console.log("Upserted product:", product.name, `(${product.sku})`);

  const channel = await prisma.channel.upsert({
    where: { id: "mock-amazon-channel" },
    update: {},
    create: {
      id: "mock-amazon-channel",
      type: "AMAZON",
      name: "Mock Amazon",
      credentials: encryptedToken,
    },
  });
  console.log("Upserted channel:", channel.name, `(type: ${channel.type})`);

  const listing = await prisma.listing.upsert({
    where: { productId_channelId: { productId: product.id, channelId: channel.id } },
    update: {},
    create: {
      productId: product.id,
      channelId: channel.id,
      channelPrice: 34.99,
    },
  });
  console.log("Upserted listing with channel price:", listing.channelPrice.toString());

  // Verify round-trip decryption
  const decrypted = vault.decrypt(channel.credentials);
  console.log("Decrypted credentials (verification):", decrypted);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
