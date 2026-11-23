// Manual migration + seed runner:  npm run migrate
// (The server also runs both automatically on every boot.)
import { createDb, createPool, runMigrations } from "./db";
import { seedInitialAdmin, seedSettings } from "./seed";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in first.");
  process.exit(1);
}

const pool = createPool(url);
try {
  await runMigrations(pool);
  const db = createDb(pool);
  await seedSettings(db);
  await seedInitialAdmin(db);
  console.log("Migrations applied; settings + first-Admin seed checked.");
} finally {
  await pool.end();
}
