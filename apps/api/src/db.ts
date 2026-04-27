import "dotenv/config";
import { resolve } from "path";
import { config } from "dotenv";

// Load root .env so DATABASE_URL is available
config({ path: resolve(new URL(".", import.meta.url).pathname, "../../../.env") });

// Import prisma from the @nexus/database package
import prisma from "@nexus/database";

export default prisma;