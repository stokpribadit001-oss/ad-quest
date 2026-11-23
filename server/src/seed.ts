import { eq } from "drizzle-orm";
import type { Db } from "./db";
import * as schema from "./schema";

// First-Admin seeding — deploy-time only.
//
// Rules (carried over from the artifact, per the owner's request):
//  - There is NO self-registration and NO setup form in the app.
//  - The first Admin is created only when the users table is empty AND the
//    ADMIN_KEY environment variable is set (by the owner, in the host's
//    env settings — never in code, never in git).
//  - ADMIN_KEY becomes that Admin's login Key. ADMIN_NAME optionally sets
//    the display name (default "Admin").
//  - Once any user exists, this function is a no-op, so changing ADMIN_KEY
//    later does NOT rotate the live Admin key (use the in-app
//    "regenerate key" admin feature for that).
export async function seedInitialAdmin(db: Db): Promise<void> {
  const existing = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (existing[0]) return;

  const adminKey = process.env.ADMIN_KEY?.trim();
  if (!adminKey) {
    console.warn(
      "[ad-quest] No users exist yet and ADMIN_KEY is not set — skipping " +
        "first-Admin seed. Set ADMIN_KEY in the environment and restart to " +
        "create the first Admin account.",
    );
    return;
  }
  const adminName = process.env.ADMIN_NAME?.trim() || "Admin";
  await db.insert(schema.users).values({
    name: adminName,
    role: "admin",
    accessKey: adminKey,
    locked: 0,
    createdBy: null,
  });
  console.log(`[ad-quest] First Admin created ("${adminName}") from ADMIN_KEY env var.`);
}

export async function seedSettings(db: Db): Promise<void> {
  const rows = await db
    .select({ id: schema.appSettings.id })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.id, 1))
    .limit(1);
  if (!rows[0]) {
    await db.insert(schema.appSettings).values({
      id: 1,
      appName: "AD QUEST",
      schoolName: "",
      announcement: "",
    });
  }
}
