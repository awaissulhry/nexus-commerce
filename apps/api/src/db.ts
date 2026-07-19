// './env.js' MUST stay the first import: @nexus/database constructs its
// pg Pool at import time, so DATABASE_URL has to be in process.env before
// that module evaluates. A dotenv call in THIS module's body would run too
// late (ESM evaluates imports before the body) — that was exactly the bug
// that sent tsx scripts to localhost instead of the configured database.
import "./env.js";
import prisma from "@nexus/database";

export default prisma;
