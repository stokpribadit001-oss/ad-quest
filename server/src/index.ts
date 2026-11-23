import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ZodError } from "zod";
import { Actions, makeCtx, type ActionDef } from "./actions";
import { createDb, createPool, runMigrations } from "./db";
import { seedInitialAdmin, seedSettings } from "./seed";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (!DATABASE_URL) {
  console.error(
    [
      "",
      "==============================================================",
      "  AD QUEST cannot start: DATABASE_URL is not set.",
      "",
      "  Set DATABASE_URL to your Postgres connection string, e.g.",
      "  the Neon connection string (Dashboard → your project →",
      "  Connect → Connection string), then start again.",
      "",
      "  Local example:  cp .env.example .env  and fill DATABASE_URL.",
      "==============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const pool = createPool(DATABASE_URL);
const db = createDb(pool);
const ctx = makeCtx(db);

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, app: "ad-quest" });
});

// Typed-action RPC, wire-compatible with the original artifact client:
// POST /actions  { action: "loginWithKey", args: { key: "..." } }
//   -> 200 JSON result, or 400 { error: "<Indonesian message>" }.
app.post("/actions", async (req, res) => {
  const body = (req.body ?? {}) as { action?: string; args?: unknown };
  const name = body.action ?? "";
  const def = (Actions as unknown as Record<string, ActionDef>)[name];
  if (!def) {
    res.status(404).json({ error: `Aksi tidak dikenal: ${name}` });
    return;
  }
  try {
    const args = def.request.parse(body.args ?? {});
    const result = await def.handler(ctx, args);
    try {
      res.json(def.response.parse(result));
    } catch {
      // Response-shape drift should never break the client; return raw.
      res.json(result);
    }
  } catch (e) {
    if (e instanceof ZodError) {
      const first = e.issues[0];
      res.status(400).json({
        error: first ? `${first.path.join(".")}: ${first.message}` : "Permintaan tidak valid.",
      });
      return;
    }
    res.status(400).json({ error: e instanceof Error ? e.message : "Terjadi kesalahan." });
  }
});

// Serve the built client (vite build -> client/dist) with SPA fallback.
const here = dirname(fileURLToPath(import.meta.url));
const clientDist = [
  join(here, "../client/dist"),
  join(here, "../../client/dist"),
  join(process.cwd(), "client/dist"),
].find((p) => existsSync(join(p, "index.html")));

if (clientDist) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/actions")) return next();
    res.sendFile(join(clientDist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res
      .status(200)
      .send("AD QUEST server is running, but client/dist was not found. Run: npm run build");
  });
}

const port = Number(process.env.PORT ?? 3000);

async function main() {
  await runMigrations(pool);
  await seedSettings(db);
  await seedInitialAdmin(db);
  app.listen(port, () => {
    console.log(`[ad-quest] Listening on :${port}`);
  });
}

main().catch((e) => {
  console.error("[ad-quest] Failed to start:", e);
  process.exit(1);
});
