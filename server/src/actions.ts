import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./schema";
import type { Db } from "./db";
import { inferenceComplete } from "./ai";

// ---- Ported runtime shim -------------------------------------------------
// The original ran on the Muse space SDK: defineAction({request, response,
// handler(ctx, args)}) with ctx.db(), ctx.invalidateQueries() and
// ctx.inference.complete(). These local definitions keep every handler body
// below byte-for-byte identical while running on plain Express + Postgres.
export interface Ctx {
  db: <S>() => Db;
  invalidateQueries: () => void;
  inference: {
    complete: (
      prompt: string,
      opts: { schema: z.ZodTypeAny; timeout_secs?: number },
    ) => Promise<any>;
  };
}

export interface ActionDef {
  description?: string;
  request: z.ZodTypeAny;
  response: z.ZodTypeAny;
  handler: (ctx: Ctx, args: any) => Promise<any>;
}

// Generic so each action keeps its concrete request/response zod types,
// which the client consumes through `import type { Actions }`.
function defineAction<R extends z.ZodTypeAny, Res extends z.ZodTypeAny>(def: {
  description?: string;
  request: R;
  response: Res;
  handler: (ctx: Ctx, args: z.infer<R>) => Promise<z.infer<Res>>;
}): { description?: string; request: R; response: Res; handler: typeof def.handler } {
  return def;
}

export type ActionsModule = Record<string, ActionDef>;

export function makeCtx(db: Db): Ctx {
  return {
    db: <S>() => db as unknown as Db,
    invalidateQueries: () => {},
    inference: { complete: (prompt, opts) => inferenceComplete(prompt, opts) },
  };
}
// -------------------------------------------------------------------------

// ---------- helpers ----------

const KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode(prefix: string): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
  }
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4)}`;
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pesan galat dari layanan inference saat server model sedang penuh/sibuk,
// mis. "The app is busy right now. Please try again in a moment."
const BUSY_RE = /busy|overload|rate.?limit|too many|capacity|try again|temporar|503|429/i;

async function requireActor(
  ctx: Ctx,
  actorId: number,
  roles: Array<"admin" | "guru" | "siswa" | "pengawas">,
) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, actorId))
    .limit(1);
  const user = rows[0];
  if (!user) throw new Error("Sesi tidak ditemukan. Silakan login ulang.");
  if (user.locked === 1)
    throw new Error("Akun Anda dikunci. Minta bantuan pengawas atau guru untuk membuka kunci.");
  if (!roles.includes(user.role)) {
    throw new Error("Anda tidak memiliki akses ke fitur ini.");
  }
  return { db, user };
}

function parseOptions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseAnswers(raw: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = typeof val === "string" ? val : String(val ?? "");
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function parseIdList(raw: string): number[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function parseEssayScores(
  raw: string | null,
): Array<{ questionId: number; score: number }> {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) {
      return v
        .filter(
          (x): x is { questionId: number; score: number } =>
            !!x &&
            typeof x === "object" &&
            typeof (x as { questionId?: unknown }).questionId === "number" &&
            typeof (x as { score?: unknown }).score === "number",
        )
        .map((x) => ({ questionId: x.questionId, score: x.score }));
    }
  } catch {
    /* ignore */
  }
  return [];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j] as T;
    a[j] = tmp as T;
  }
  return a;
}

function normText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// Bagi total poin ke n soal seadil mungkin: sisa pembagian diberikan
// satu-satu ke soal terdepan, jadi jumlah poin selalu tepat `total`.
// Dipakai agar soal buatan AI selalu bernilai total 100.
function splitPoints(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

function gradeAuto(
  q: { type: string; correctAnswer: string; points: number },
  answer: string | undefined,
): number {
  if (answer == null || answer.trim() === "") return 0;
  if (q.type === "pilihan_ganda" || q.type === "isian") {
    return normText(answer) === normText(q.correctAnswer) ? q.points : 0;
  }
  if (q.type === "angka") {
    const a = Number(answer.replace(",", "."));
    const c = Number(q.correctAnswer.replace(",", "."));
    if (Number.isFinite(a) && Number.isFinite(c)) {
      return Math.abs(a - c) < 1e-9 ? q.points : 0;
    }
    return normText(answer) === normText(q.correctAnswer) ? q.points : 0;
  }
  return 0; // essay dinilai guru
}

async function uniqueAccessKey(
  db: Db,
  prefix: string,
): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = genCode(prefix);
    const ex = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.accessKey, code))
      .limit(1);
    if (!ex[0]) return code;
  }
  return genCode(prefix) + "X";
}

async function ensureSettings(db: Db) {
  const rows = await db
    .select()
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
    return { appName: "AD QUEST", schoolName: "", announcement: "" };
  }
  const r = rows[0];
  return { appName: r.appName, schoolName: r.schoolName, announcement: r.announcement };
}

// ---------- shared zod shapes ----------

const userOut = z.object({
  id: z.number(),
  name: z.string(),
  role: z.enum(["admin", "guru", "siswa", "pengawas"]),
  accessKey: z.string(),
  locked: z.boolean(),
  createdAt: z.string(),
});

const examOut = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  subject: z.string(),
  kelas: z.string(),
  teacherId: z.number(),
  teacherName: z.string(),
  durationMinutes: z.number(),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  requireExamKey: z.boolean(),
  isPublished: z.boolean(),
  questionCount: z.number(),
  createdAt: z.string(),
});

const questionTeacherOut = z.object({
  id: z.number(),
  examId: z.number(),
  type: z.enum(["pilihan_ganda", "isian", "essay", "angka"]),
  prompt: z.string(),
  options: z.array(z.string()),
  correctAnswer: z.string(),
  points: z.number(),
  sortOrder: z.number(),
});

const questionStudentOut = z.object({
  id: z.number(),
  type: z.enum(["pilihan_ganda", "isian", "essay", "angka"]),
  prompt: z.string(),
  options: z.array(z.string()),
  points: z.number(),
});

const attemptSummaryOut = z.object({
  id: z.number(),
  examId: z.number(),
  examTitle: z.string(),
  studentId: z.number(),
  studentName: z.string(),
  status: z.enum(["in_progress", "submitted", "graded"]),
  startedAt: z.string(),
  submittedAt: z.string().nullable(),
  autoScore: z.number().nullable(),
  totalScore: z.number().nullable(),
  maxScore: z.number(),
  answeredCount: z.number(),
  attemptLocked: z.boolean(),
  lockReason: z.string(),
  violations: z.number(),
});

function toUserOut(u: typeof schema.users.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    accessKey: u.accessKey,
    locked: u.locked === 1,
    createdAt: u.createdAt.toISOString(),
  };
}

async function examToOut(
  db: Db,
  e: typeof schema.exams.$inferSelect,
) {
  const t = await db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, e.teacherId))
    .limit(1);
  const qs = await db
    .select({ id: schema.questions.id })
    .from(schema.questions)
    .where(eq(schema.questions.examId, e.id));
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    subject: e.subject,
    kelas: e.kelas,
    teacherId: e.teacherId,
    teacherName: t[0]?.name ?? "—",
    durationMinutes: e.durationMinutes,
    shuffleQuestions: e.shuffleQuestions === 1,
    shuffleOptions: e.shuffleOptions === 1,
    requireExamKey: e.requireExamKey === 1,
    isPublished: e.isPublished === 1,
    questionCount: qs.length,
    createdAt: e.createdAt.toISOString(),
  };
}

const draftQuestion = z.object({
  type: z.enum(["pilihan_ganda", "isian", "essay", "angka"]),
  prompt: z.string().min(1).max(2000),
  options: z.array(z.string().max(500)).max(8).default([]),
  correctAnswer: z.string().max(2000).default(""),
  points: z.number().int().min(1).max(100).default(10),
});

export const Actions = {
  // ---------- bootstrap & auth ----------

  getBootstrap: defineAction({
    description:
      "Status penyiapan awal: apakah AD QUEST belum memiliki akun sama sekali.",
    request: z.object({}),
    response: z.object({ needsSetup: z.boolean() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
      return { needsSetup: !existing[0] };
    },
  }),

  // Catatan: tidak ada aksi pembuatan akun Admin pertama di server ini.
  // Akun Admin pertama AD QUEST sudah dibuatkan oleh Muse saat penyiapan
  // awal; akun berikutnya hanya bisa dibuat oleh admin/guru yang sudah
  // login (createUser), sesuai permintaan pengguna agar pengunjung tidak
  // bisa membuat Key Admin sendiri.

  getSettings: defineAction({
    description: "Mengambil pengaturan aplikasi AD QUEST (nama, sekolah, pengumuman).",
    request: z.object({}),
    response: z.object({
      appName: z.string(),
      schoolName: z.string(),
      announcement: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      return ensureSettings(db);
    },
  }),

  loginWithKey: defineAction({
    description:
      "Login AD QUEST dengan Key; server mengenali role (admin/guru/siswa) dari Key.",
    request: z.object({ key: z.string().trim().min(1).max(64) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      user: z
        .object({
          id: z.number(),
          name: z.string(),
          role: z.enum(["admin", "guru", "siswa", "pengawas"]),
        })
        .nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.accessKey, args.key.trim().toUpperCase()))
        .limit(1);
      const u = rows[0];
      if (!u) {
        // coba persis seperti diketik (case-sensitive fallback)
        const rows2 = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.accessKey, args.key.trim()))
          .limit(1);
        if (!rows2[0]) {
          return { ok: false, error: "Key tidak ditemukan. Periksa kembali Key Anda.", user: null };
        }
        const u2 = rows2[0];
        if (u2.locked === 1)
          return { ok: false, error: "Akun dikunci. Minta bantuan pengawas atau guru untuk membuka kunci.", user: null };
        return { ok: true, error: null, user: { id: u2.id, name: u2.name, role: u2.role } };
      }
      if (u.locked === 1)
        return { ok: false, error: "Akun dikunci. Minta bantuan pengawas atau guru untuk membuka kunci.", user: null };
      return { ok: true, error: null, user: { id: u.id, name: u.name, role: u.role } };
    },
  }),

  // ---------- admin ----------

  adminStats: defineAction({
    description: "Statistik admin: jumlah guru, siswa, soal, ujian, dan hasil masuk.",
    request: z.object({ actorId: z.number().int().positive() }),
    response: z.object({
      teachers: z.number(),
      students: z.number(),
      supervisors: z.number(),
      questions: z.number(),
      exams: z.number(),
      attempts: z.number(),
      lockedUsers: z.number(),
    }),
    async handler(ctx, args) {
      const { db } = await requireActor(ctx, args.actorId, ["admin"]);
      const allUsers = await db.select().from(schema.users);
      const allQ = await db.select({ id: schema.questions.id }).from(schema.questions);
      const allE = await db.select({ id: schema.exams.id }).from(schema.exams);
      const allA = await db.select({ id: schema.attempts.id }).from(schema.attempts);
      return {
        teachers: allUsers.filter((u) => u.role === "guru").length,
        students: allUsers.filter((u) => u.role === "siswa").length,
        supervisors: allUsers.filter((u) => u.role === "pengawas").length,
        questions: allQ.length,
        exams: allE.length,
        attempts: allA.length,
        lockedUsers: allUsers.filter((u) => u.locked === 1).length,
      };
    },
  }),

  listUsers: defineAction({
    description: "Daftar semua pengguna AD QUEST untuk admin atau guru (peserta guru).",
    request: z.object({
      actorId: z.number().int().positive(),
      scope: z.enum(["all", "mine"]).default("all"),
    }),
    response: z.object({ users: z.array(userOut) }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["admin", "guru"]);
      let rows = await db
        .select()
        .from(schema.users)
        .orderBy(desc(schema.users.id));
      if (user.role === "guru" || args.scope === "mine") {
        if (user.role === "guru") {
          rows = rows.filter(
            (u) => u.createdBy === user.id || u.id === user.id,
          );
        }
      }
      return { users: rows.map(toUserOut) };
    },
  }),

  createUser: defineAction({
    description:
      "Membuat akun baru (admin membuat guru/siswa/pengawas; guru membuat siswa & pengawas) beserta Key login unik.",
    request: z.object({
      actorId: z.number().int().positive(),
      name: z.string().trim().min(1).max(80),
      role: z.enum(["admin", "guru", "siswa", "pengawas"]),
    }),
    response: z.object({ user: userOut }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["admin", "guru"]);
      if (user.role === "guru" && args.role !== "siswa" && args.role !== "pengawas") {
        throw new Error("Guru hanya dapat membuat akun siswa dan pengawas.");
      }
      const prefix =
        args.role === "admin" ? "ADM" : args.role === "guru" ? "GRU" : args.role === "pengawas" ? "PGW" : "SIS";
      const key = await uniqueAccessKey(db, prefix);
      const inserted = await db
        .insert(schema.users)
        .values({
          name: args.name,
          role: args.role,
          accessKey: key,
          locked: 0,
          createdBy: user.id,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Gagal membuat akun.");
      ctx.invalidateQueries();
      return { user: toUserOut(row) };
    },
  }),

  updateUserRole: defineAction({
    description: "Admin mengubah role seorang pengguna.",
    request: z.object({
      actorId: z.number().int().positive(),
      userId: z.number().int().positive(),
      role: z.enum(["admin", "guru", "siswa", "pengawas"]),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const { db, user } = await requireActor(ctx, args.actorId, ["admin"]);
      if (args.userId === user.id) throw new Error("Anda tidak dapat mengubah role sendiri.");
      await db
        .update(schema.users)
        .set({ role: args.role })
        .where(eq(schema.users.id, args.userId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setUserLocked: defineAction({
    description:
      "Mengunci atau membuka kunci akun pengguna (admin; guru untuk siswanya; pengawas untuk peserta dalam pantauannya). Membuka kunci akun juga membuka kunci layar ujian peserta.",
    request: z.object({
      actorId: z.number().int().positive(),
      userId: z.number().int().positive(),
      locked: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const { db, user } = await requireActor(ctx, args.actorId, ["admin", "guru", "pengawas"]);
      if (args.userId === user.id) throw new Error("Anda tidak dapat mengunci akun sendiri.");
      const targetRows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, args.userId))
        .limit(1);
      const target = targetRows[0];
      if (!target) throw new Error("Pengguna tidak ditemukan.");
      if (user.role === "guru") {
        if (target.createdBy !== user.id || (target.role !== "siswa" && target.role !== "pengawas")) {
          throw new Error("Guru hanya dapat mengunci akun yang ia buat.");
        }
      }
      if (user.role === "pengawas") {
        if (target.role !== "siswa") {
          throw new Error("Pengawas hanya dapat mengunci/membuka akun peserta.");
        }
        const scopeTeacherId = user.createdBy;
        if (scopeTeacherId != null && target.createdBy !== scopeTeacherId) {
          // Peserta bukan buatan guru pembuat pengawas: boleh bila ia punya
          // attempt pada ujian milik guru tersebut.
          const teacherExams = await db
            .select({ id: schema.exams.id })
            .from(schema.exams)
            .where(eq(schema.exams.teacherId, scopeTeacherId));
          const examIds = new Set(teacherExams.map((e) => e.id));
          const studentAttempts = await db
            .select({ examId: schema.attempts.examId })
            .from(schema.attempts)
            .where(eq(schema.attempts.studentId, target.id));
          if (!studentAttempts.some((a) => examIds.has(a.examId))) {
            throw new Error("Peserta ini berada di luar pantauan Anda.");
          }
        }
      }
      await db
        .update(schema.users)
        .set({ locked: args.locked ? 1 : 0 })
        .where(eq(schema.users.id, args.userId));
      if (!args.locked) {
        // Buka juga kunci layar ujian peserta agar bisa melanjutkan ujian.
        await db
          .update(schema.attempts)
          .set({ locked: 0, lockedAt: null })
          .where(eq(schema.attempts.studentId, args.userId));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  regenerateUserKey: defineAction({
    description: "Membuat ulang Key login seorang pengguna (Key lama tidak berlaku).",
    request: z.object({
      actorId: z.number().int().positive(),
      userId: z.number().int().positive(),
    }),
    response: z.object({ accessKey: z.string() }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["admin", "guru"]);
      const targetRows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, args.userId))
        .limit(1);
      const target = targetRows[0];
      if (!target) throw new Error("Pengguna tidak ditemukan.");
      if (user.role === "guru" && (target.createdBy !== user.id || target.role !== "siswa")) {
        throw new Error("Guru hanya dapat membuat ulang Key pesertanya sendiri.");
      }
      const prefix =
        target.role === "admin" ? "ADM" : target.role === "guru" ? "GRU" : target.role === "pengawas" ? "PGW" : "SIS";
      const key = await uniqueAccessKey(db, prefix);
      await db
        .update(schema.users)
        .set({ accessKey: key })
        .where(eq(schema.users.id, args.userId));
      ctx.invalidateQueries();
      return { accessKey: key };
    },
  }),

  deleteUser: defineAction({
    description: "Admin menghapus akun pengguna beserta hasil ujiannya.",
    request: z.object({
      actorId: z.number().int().positive(),
      userId: z.number().int().positive(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const { db, user } = await requireActor(ctx, args.actorId, ["admin"]);
      if (args.userId === user.id) throw new Error("Anda tidak dapat menghapus akun sendiri.");
      await db.delete(schema.attempts).where(eq(schema.attempts.studentId, args.userId));
      await db.delete(schema.users).where(eq(schema.users.id, args.userId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  updateSettings: defineAction({
    description: "Admin mengubah pengaturan aplikasi (nama sekolah & pengumuman).",
    request: z.object({
      actorId: z.number().int().positive(),
      schoolName: z.string().trim().max(120),
      announcement: z.string().trim().max(500),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const { db } = await requireActor(ctx, args.actorId, ["admin"]);
      await ensureSettings(db);
      await db
        .update(schema.appSettings)
        .set({ schoolName: args.schoolName, announcement: args.announcement })
        .where(eq(schema.appSettings.id, 1));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------- exams & questions ----------

  listExams: defineAction({
    description:
      "Daftar paket soal: semua untuk admin, milik sendiri untuk guru, yang terbit untuk siswa.",
    request: z.object({ actorId: z.number().int().positive() }),
    response: z.object({ exams: z.array(examOut) }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["admin", "guru", "siswa", "pengawas"]);
      let rows = await db
        .select()
        .from(schema.exams)
        .orderBy(desc(schema.exams.id));
      if (user.role === "guru") rows = rows.filter((e) => e.teacherId === user.id);
      if (user.role === "siswa") rows = rows.filter((e) => e.isPublished === 1);
      const out = [];
      for (const e of rows) out.push(await examToOut(db, e));
      return { exams: out };
    },
  }),

  createExam: defineAction({
    description: "Guru membuat paket soal/ujian baru.",
    request: z.object({
      actorId: z.number().int().positive(),
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().max(1000).default(""),
      subject: z.string().trim().max(80).default(""),
      kelas: z.string().trim().max(60).default(""),
      durationMinutes: z.number().int().min(1).max(600).default(60),
      shuffleQuestions: z.boolean().default(false),
      shuffleOptions: z.boolean().default(false),
      requireExamKey: z.boolean().default(false),
    }),
    response: z.object({ exam: examOut }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const inserted = await db
        .insert(schema.exams)
        .values({
          title: args.title,
          description: args.description,
          subject: args.subject,
          kelas: args.kelas,
          teacherId: user.id,
          durationMinutes: args.durationMinutes,
          shuffleQuestions: args.shuffleQuestions ? 1 : 0,
          shuffleOptions: args.shuffleOptions ? 1 : 0,
          requireExamKey: args.requireExamKey ? 1 : 0,
          isPublished: 0,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Gagal membuat paket soal.");
      ctx.invalidateQueries();
      return { exam: await examToOut(db, row) };
    },
  }),

  updateExam: defineAction({
    description: "Guru/admin mengubah pengaturan paket soal termasuk status terbit.",
    request: z.object({
      actorId: z.number().int().positive(),
      examId: z.number().int().positive(),
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().max(1000),
      subject: z.string().trim().max(80),
      kelas: z.string().trim().max(60),
      durationMinutes: z.number().int().min(1).max(600),
      shuffleQuestions: z.boolean(),
      shuffleOptions: z.boolean(),
      requireExamKey: z.boolean(),
      isPublished: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const rows = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, args.examId))
        .limit(1);
      const exam = rows[0];
      if (!exam) throw new Error("Paket soal tidak ditemukan.");
      if (user.role === "guru" && exam.teacherId !== user.id)
        throw new Error("Paket soal ini bukan milik Anda.");
      await db
        .update(schema.exams)
        .set({
          title: args.title,
          description: args.description,
          subject: args.subject,
          kelas: args.kelas,
          durationMinutes: args.durationMinutes,
          shuffleQuestions: args.shuffleQuestions ? 1 : 0,
          shuffleOptions: args.shuffleOptions ? 1 : 0,
          requireExamKey: args.requireExamKey ? 1 : 0,
          isPublished: args.isPublished ? 1 : 0,
        })
        .where(eq(schema.exams.id, args.examId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteExam: defineAction({
    description: "Guru/admin menghapus paket soal beserta soal, key ujian, dan hasilnya.",
    request: z.object({
      actorId: z.number().int().positive(),
      examId: z.number().int().positive(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const rows = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, args.examId))
        .limit(1);
      const exam = rows[0];
      if (!exam) throw new Error("Paket soal tidak ditemukan.");
      if (user.role === "guru" && exam.teacherId !== user.id)
        throw new Error("Paket soal ini bukan milik Anda.");
      await db.delete(schema.questions).where(eq(schema.questions.examId, args.examId));
      await db.delete(schema.examKeys).where(eq(schema.examKeys.examId, args.examId));
      await db.delete(schema.attempts).where(eq(schema.attempts.examId, args.examId));
      await db.delete(schema.exams).where(eq(schema.exams.id, args.examId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listQuestions: defineAction({
    description: "Daftar soal satu paket lengkap dengan kunci jawaban (guru pemilik/admin).",
    request: z.object({
      actorId: z.number().int().positive(),
      examId: z.number().int().positive(),
    }),
    response: z.object({ questions: z.array(questionTeacherOut) }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, args.examId))
        .limit(1);
      const exam = er[0];
      if (!exam) throw new Error("Paket soal tidak ditemukan.");
      if (user.role === "guru" && exam.teacherId !== user.id)
        throw new Error("Paket soal ini bukan milik Anda.");
      const rows = await db
        .select()
        .from(schema.questions)
        .where(eq(schema.questions.examId, args.examId))
        .orderBy(asc(schema.questions.sortOrder), asc(schema.questions.id));
      return {
        questions: rows.map((q) => ({
          id: q.id,
          examId: q.examId,
          type: q.type,
          prompt: q.prompt,
          options: parseOptions(q.options),
          correctAnswer: q.correctAnswer,
          points: q.points,
          sortOrder: q.sortOrder,
        })),
      };
    },
  }),

  saveQuestion: defineAction({
    description: "Menambah atau mengubah satu soal dalam paket (guru pemilik/admin).",
    request: z.object({
      actorId: z.number().int().positive(),
      examId: z.number().int().positive(),
      questionId: z.number().int().positive().nullable().default(null),
      question: draftQuestion,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, args.examId))
        .limit(1);
      const exam = er[0];
      if (!exam) throw new Error("Paket soal tidak ditemukan.");
      if (user.role === "guru" && exam.teacherId !== user.id)
        throw new Error("Paket soal ini bukan milik Anda.");
      const q = args.question;
      if (q.type === "pilihan_ganda") {
        if (q.options.length < 2) throw new Error("Pilihan ganda butuh minimal 2 pilihan jawaban.");
        if (!q.options.some((o) => normText(o) === normText(q.correctAnswer)))
          throw new Error("Kunci jawaban harus sama persis dengan salah satu pilihan.");
      }
      const values = {
        examId: args.examId,
        type: q.type,
        prompt: q.prompt,
        options: q.type === "pilihan_ganda" ? JSON.stringify(q.options) : null,
        correctAnswer: q.correctAnswer,
        points: q.points,
      };
      if (args.questionId) {
        await db
          .update(schema.questions)
          .set(values)
          .where(eq(schema.questions.id, args.questionId));
        ctx.invalidateQueries();
        return { id: args.questionId };
      }
      const existing = await db
        .select({ id: schema.questions.id })
        .from(schema.questions)
        .where(eq(schema.questions.examId, args.examId));
      const inserted = await db
        .insert(schema.questions)
        .values({ ...values, sortOrder: existing.length })
        .returning({ id: schema.questions.id });
      const row = inserted[0];
      if (!row) throw new Error("Gagal menyimpan soal.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteQuestion: defineAction({
    description: "Menghapus satu soal dari paket (guru pemilik/admin).",
    request: z.object({
      actorId: z.number().int().positive(),
      questionId: z.number().int().positive(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const qr = await db
        .select()
        .from(schema.questions)
        .where(eq(schema.questions.id, args.questionId))
        .limit(1);
      const q = qr[0];
      if (!q) throw new Error("Soal tidak ditemukan.");
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, q.examId))
        .limit(1);
      if (user.role === "guru" && er[0] && er[0].teacherId !== user.id)
        throw new Error("Paket soal ini bukan milik Anda.");
      await db.delete(schema.questions).where(eq(schema.questions.id, args.questionId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  saveQuestionsBulk: defineAction({
    description:
      "Menyimpan banyak soal draf sekaligus ke paket (hasil AI yang sudah diedit guru); poin diseimbangkan otomatis agar total batch tepat 100.",
    request: z.object({
      actorId: z.number().int().positive(),
      examId: z.number().int().positive(),
      questions: z.array(draftQuestion).min(1).max(50),
    }),
    response: z.object({ saved: z.number() }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, args.examId))
        .limit(1);
      const exam = er[0];
      if (!exam) throw new Error("Paket soal tidak ditemukan.");
      if (user.role === "guru" && exam.teacherId !== user.id)
        throw new Error("Paket soal ini bukan milik Anda.");
      const existing = await db
        .select({ id: schema.questions.id })
        .from(schema.questions)
        .where(eq(schema.questions.examId, args.examId));
      let order = existing.length;
      // Draf yang disimpan massal berasal dari AI: seimbangkan poinnya agar
      // total batch tepat 100 berapa pun jumlah draf yang akhirnya disimpan
      // guru (mis. setelah sebagian draf dibuang saat pemeriksaan).
      const bulkPoints = splitPoints(100, args.questions.length);
      let qi = 0;
      for (const q of args.questions) {
        await db.insert(schema.questions).values({
          examId: args.examId,
          type: q.type,
          prompt: q.prompt,
          options: q.type === "pilihan_ganda" ? JSON.stringify(q.options) : null,
          correctAnswer: q.correctAnswer,
          points: bulkPoints[qi++] ?? q.points,
          sortOrder: order++,
        });
      }
      ctx.invalidateQueries();
      return { saved: args.questions.length };
    },
  }),

  generateQuestionsAI: defineAction({
    description:
      "AI membuat draf soal dari materi guru (pertanyaan, pilihan, kunci) untuk diedit lalu disimpan.",
    request: z.object({
      actorId: z.number().int().positive(),
      material: z.string().trim().min(10).max(8000),
      count: z.number().int().min(1).max(20),
      type: z.enum(["pilihan_ganda", "isian", "essay", "angka"]),
      subject: z.string().trim().max(80).default(""),
    }),
    response: z.object({ questions: z.array(draftQuestion) }),
    async handler(ctx, args) {
      await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const typeLabel =
        args.type === "pilihan_ganda"
          ? "pilihan ganda dengan tepat 4 pilihan jawaban dan satu kunci jawaban yang persis sama dengan salah satu pilihan"
          : args.type === "isian"
            ? "isian singkat dengan jawaban kunci yang singkat dan pasti"
            : args.type === "angka"
              ? "soal berhitung dengan jawaban akhir berupa angka saja pada kunci jawaban"
              : "essay dengan kunci jawaban berupa pedoman/poin-poin jawaban ideal";
      const aiSchema = z.object({
        questions: z.array(
          z.object({
            prompt: z.string(),
            options: z.array(z.string()),
            correctAnswer: z.string(),
          }),
        ),
      });
      const prompt = `Anda adalah guru ${args.subject || "sekolah"} di Indonesia. Buat ${args.count} soal ${typeLabel} dalam Bahasa Indonesia berdasarkan materi berikut. Soal harus jelas, sesuai materi, dan bervariasi tingkat kesulitannya.\n\nMATERI:\n${args.material}`;
      // Layanan AI kadang menjawab "sedang sibuk" (busy/overload) sesaat.
      // Jangan langsung menyerah: coba ulang sampai 3x dengan jeda bertambah,
      // dan bila tetap gagal sampaikan pesan Bahasa Indonesia yang jelas —
      // pesan mentah berbahasa Inggris dari layanan tidak boleh bocor ke guru.
      let result: z.infer<typeof aiSchema> | null = null;
      let lastBusy = false;
      for (let attempt = 0; attempt < 3 && !result; attempt++) {
        try {
          result = await ctx.inference.complete(prompt, { schema: aiSchema, timeout_secs: 120 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lastBusy = BUSY_RE.test(msg);
          if (attempt < 2) await sleep(attempt === 0 ? 3000 : 8000);
        }
      }
      if (!result) {
        throw new Error(
          lastBusy
            ? "Layanan AI sedang sibuk saat ini. Tunggu ±30 detik, lalu tekan tombol Buat Soal dengan AI lagi — materi Anda tidak hilang."
            : "AI gagal menyusun soal. Coba lagi sebentar lagi — atau perkecil jumlah soal dan pastikan materi cukup jelas.",
        );
      }
      const questions: Array<z.infer<typeof draftQuestion>> = [];
      for (const q of result.questions.slice(0, args.count)) {
        const prompt = q.prompt.trim();
        if (!prompt) continue;
        if (args.type === "pilihan_ganda") {
          const options = q.options.map((o) => o.trim()).filter(Boolean).slice(0, 6);
          if (options.length < 2) continue;
          let correct = q.correctAnswer.trim();
          if (!options.some((o) => normText(o) === normText(correct))) {
            // Kunci dari AI tidak persis sama dengan pilihan mana pun:
            // jadikan kunci sebagai pilihan tambahan agar draf tetap valid.
            if (correct && options.length < 6) {
              options.push(correct);
            } else {
              correct = options[0] ?? correct;
            }
          } else {
            correct = options.find((o) => normText(o) === normText(correct)) ?? correct;
          }
          questions.push({ type: args.type, prompt, options, correctAnswer: correct, points: 10 });
        } else {
          questions.push({
            type: args.type,
            prompt,
            options: [],
            correctAnswer: q.correctAnswer.trim(),
            points: 10,
          });
        }
      }
      if (questions.length === 0)
        throw new Error("AI belum menghasilkan soal yang valid. Coba materi yang lebih lengkap atau jenis soal lain.");
      // Nilai otomatis skala 100: poin dibagi rata ke seluruh soal buatan AI
      // agar total nilai tepat 100, sehingga hasil siswa tampil sebagai
      // nilai yang didapat / 100 (bukan lagi mis. 30/50 untuk 5 soal).
      const aiPoints = splitPoints(100, questions.length);
      questions.forEach((q, i) => {
        q.points = aiPoints[i] ?? q.points;
      });
      return { questions };
    },
  }),

  // ---------- exam keys ----------

  createExamKeys: defineAction({
    description: "Membuat sejumlah Key ujian sekali pakai untuk satu paket soal.",
    request: z.object({
      actorId: z.number().int().positive(),
      examId: z.number().int().positive(),
      count: z.number().int().min(1).max(100),
    }),
    response: z.object({
      keys: z.array(
        z.object({ id: z.number(), code: z.string(), isUsed: z.boolean(), usedByName: z.string().nullable() }),
      ),
    }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, args.examId))
        .limit(1);
      const exam = er[0];
      if (!exam) throw new Error("Paket soal tidak ditemukan.");
      if (user.role === "guru" && exam.teacherId !== user.id)
        throw new Error("Paket soal ini bukan milik Anda.");
      const created = [];
      for (let i = 0; i < args.count; i++) {
        let code = genCode("UJIAN");
        for (let t = 0; t < 10; t++) {
          const ex = await db
            .select({ id: schema.examKeys.id })
            .from(schema.examKeys)
            .where(eq(schema.examKeys.code, code))
            .limit(1);
          if (!ex[0]) break;
          code = genCode("UJIAN");
        }
        const ins = await db
          .insert(schema.examKeys)
          .values({ code, examId: args.examId, createdBy: user.id, isUsed: 0 })
          .returning();
        const row = ins[0];
        if (row) created.push({ id: row.id, code: row.code, isUsed: false, usedByName: null });
      }
      ctx.invalidateQueries();
      return { keys: created };
    },
  }),

  listExamKeys: defineAction({
    description: "Daftar Key ujian satu paket beserta status terpakai/belum.",
    request: z.object({
      actorId: z.number().int().positive(),
      examId: z.number().int().positive(),
    }),
    response: z.object({
      keys: z.array(
        z.object({ id: z.number(), code: z.string(), isUsed: z.boolean(), usedByName: z.string().nullable() }),
      ),
    }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, args.examId))
        .limit(1);
      const exam = er[0];
      if (!exam) throw new Error("Paket soal tidak ditemukan.");
      if (user.role === "guru" && exam.teacherId !== user.id)
        throw new Error("Paket soal ini bukan milik Anda.");
      const rows = await db
        .select()
        .from(schema.examKeys)
        .where(eq(schema.examKeys.examId, args.examId))
        .orderBy(desc(schema.examKeys.id));
      const out = [];
      for (const k of rows) {
        let usedByName: string | null = null;
        if (k.usedBy) {
          const u = await db
            .select({ name: schema.users.name })
            .from(schema.users)
            .where(eq(schema.users.id, k.usedBy))
            .limit(1);
          usedByName = u[0]?.name ?? null;
        }
        out.push({ id: k.id, code: k.code, isUsed: k.isUsed === 1, usedByName });
      }
      return { keys: out };
    },
  }),

  // ---------- teacher dashboard & inbox ----------

  teacherStats: defineAction({
    description: "Statistik beranda guru: paket soal, peserta, ujian selesai, hasil terbaru.",
    request: z.object({ actorId: z.number().int().positive() }),
    response: z.object({
      examCount: z.number(),
      studentCount: z.number(),
      finishedCount: z.number(),
      recent: z.array(attemptSummaryOut),
    }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru"]);
      const myExams = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.teacherId, user.id));
      const students = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.createdBy, user.id));
      const examIds = new Set(myExams.map((e) => e.id));
      const allAttempts = await db
        .select()
        .from(schema.attempts)
        .orderBy(desc(schema.attempts.id));
      const mine = allAttempts.filter((a) => examIds.has(a.examId));
      const recent = [];
      for (const a of mine.slice(0, 5)) {
        const s = await db
          .select({ name: schema.users.name })
          .from(schema.users)
          .where(eq(schema.users.id, a.studentId))
          .limit(1);
        const e = myExams.find((x) => x.id === a.examId);
        recent.push({
          id: a.id,
          examId: a.examId,
          examTitle: e?.title ?? "—",
          studentId: a.studentId,
          studentName: s[0]?.name ?? "—",
          status: a.status,
          startedAt: a.startedAt.toISOString(),
          submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
          autoScore: a.autoScore,
          totalScore: a.totalScore,
          maxScore: a.maxScore,
          answeredCount: Object.keys(parseAnswers(a.answers)).length,
          attemptLocked: a.locked === 1,
          lockReason: a.lockReason,
          violations: a.violations,
        });
      }
      return {
        examCount: myExams.length,
        studentCount: students.length,
        finishedCount: mine.filter((a) => a.status !== "in_progress").length,
        recent,
      };
    },
  }),

  listAttempts: defineAction({
    description:
      "Kotak masuk hasil ujian: untuk guru hanya ujiannya sendiri, untuk admin semua hasil.",
    request: z.object({ actorId: z.number().int().positive() }),
    response: z.object({ attempts: z.array(attemptSummaryOut) }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const allExams = await db.select().from(schema.exams);
      const examMap = new Map(allExams.map((e) => [e.id, e]));
      let rows = await db
        .select()
        .from(schema.attempts)
        .orderBy(desc(schema.attempts.id));
      if (user.role === "guru") {
        rows = rows.filter((a) => examMap.get(a.examId)?.teacherId === user.id);
      }
      const out = [];
      for (const a of rows) {
        const s = await db
          .select({ name: schema.users.name })
          .from(schema.users)
          .where(eq(schema.users.id, a.studentId))
          .limit(1);
        out.push({
          id: a.id,
          examId: a.examId,
          examTitle: examMap.get(a.examId)?.title ?? "—",
          studentId: a.studentId,
          studentName: s[0]?.name ?? "—",
          status: a.status,
          startedAt: a.startedAt.toISOString(),
          submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
          autoScore: a.autoScore,
          totalScore: a.totalScore,
          maxScore: a.maxScore,
          answeredCount: Object.values(parseAnswers(a.answers)).filter((v) => v.trim() !== "").length,
          attemptLocked: a.locked === 1,
          lockReason: a.lockReason,
          violations: a.violations,
        });
      }
      return { attempts: out };
    },
  }),

  getAttemptDetail: defineAction({
    description: "Detail satu hasil: jawaban siswa per soal, kunci, nilai otomatis & essay (guru/admin).",
    request: z.object({
      actorId: z.number().int().positive(),
      attemptId: z.number().int().positive(),
    }),
    response: z.object({
      attempt: attemptSummaryOut,
      items: z.array(
        z.object({
          questionId: z.number(),
          type: z.enum(["pilihan_ganda", "isian", "essay", "angka"]),
          prompt: z.string(),
          options: z.array(z.string()),
          correctAnswer: z.string(),
          studentAnswer: z.string(),
          points: z.number(),
          earnedAuto: z.number(),
          essayScore: z.number().nullable(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const ar = await db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.id, args.attemptId))
        .limit(1);
      const a = ar[0];
      if (!a) throw new Error("Hasil tidak ditemukan.");
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, a.examId))
        .limit(1);
      const exam = er[0];
      if (!exam) throw new Error("Paket soal tidak ditemukan.");
      if (user.role === "guru" && exam.teacherId !== user.id)
        throw new Error("Hasil ini bukan dari ujian Anda.");
      const s = await db
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, a.studentId))
        .limit(1);
      const answers = parseAnswers(a.answers);
      const essayScores = parseEssayScores(a.essayScores);
      const qs = await db
        .select()
        .from(schema.questions)
        .where(eq(schema.questions.examId, a.examId))
        .orderBy(asc(schema.questions.sortOrder), asc(schema.questions.id));
      const items = qs.map((q) => {
        const ans = answers[String(q.id)] ?? "";
        const es = essayScores.find((x) => x.questionId === q.id);
        return {
          questionId: q.id,
          type: q.type,
          prompt: q.prompt,
          options: parseOptions(q.options),
          correctAnswer: q.correctAnswer,
          studentAnswer: ans,
          points: q.points,
          earnedAuto: q.type === "essay" ? 0 : gradeAuto(q, ans),
          essayScore: q.type === "essay" ? (es ? es.score : null) : null,
        };
      });
      return {
        attempt: {
          id: a.id,
          examId: a.examId,
          examTitle: exam.title,
          studentId: a.studentId,
          studentName: s[0]?.name ?? "—",
          status: a.status,
          startedAt: a.startedAt.toISOString(),
          submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
          autoScore: a.autoScore,
          totalScore: a.totalScore,
          maxScore: a.maxScore,
          answeredCount: Object.values(answers).filter((v) => v.trim() !== "").length,
          attemptLocked: a.locked === 1,
          lockReason: a.lockReason,
          violations: a.violations,
        },
        items,
      };
    },
  }),

  gradeEssay: defineAction({
    description: "Guru memberi nilai essay; total nilai attempt dihitung ulang.",
    request: z.object({
      actorId: z.number().int().positive(),
      attemptId: z.number().int().positive(),
      scores: z.array(
        z.object({
          questionId: z.number().int().positive(),
          score: z.number().int().min(0).max(1000),
        }),
      ),
    }),
    response: z.object({ totalScore: z.number(), maxScore: z.number() }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["guru", "admin"]);
      const ar = await db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.id, args.attemptId))
        .limit(1);
      const a = ar[0];
      if (!a) throw new Error("Hasil tidak ditemukan.");
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, a.examId))
        .limit(1);
      if (user.role === "guru" && er[0] && er[0].teacherId !== user.id)
        throw new Error("Hasil ini bukan dari ujian Anda.");
      const qs = await db
        .select()
        .from(schema.questions)
        .where(eq(schema.questions.examId, a.examId));
      const essayIds = new Map(qs.filter((q) => q.type === "essay").map((q) => [q.id, q.points]));
      const clean = args.scores
        .filter((s) => essayIds.has(s.questionId))
        .map((s) => ({
          questionId: s.questionId,
          score: Math.min(s.score, essayIds.get(s.questionId) ?? s.score),
        }));
      const essayTotal = clean.reduce((sum, s) => sum + s.score, 0);
      const total = (a.autoScore ?? 0) + essayTotal;
      const allEssayGraded = qs
        .filter((q) => q.type === "essay")
        .every((q) => clean.some((s) => s.questionId === q.id));
      await db
        .update(schema.attempts)
        .set({
          essayScores: JSON.stringify(clean),
          totalScore: total,
          status: allEssayGraded ? "graded" : a.status,
        })
        .where(eq(schema.attempts.id, args.attemptId));
      ctx.invalidateQueries();
      return { totalScore: total, maxScore: a.maxScore };
    },
  }),

  // ---------- student ----------

  studentHome: defineAction({
    description: "Beranda siswa: ujian terbit beserta status pengerjaan siswa (tanpa nilai).",
    request: z.object({ actorId: z.number().int().positive() }),
    response: z.object({
      exams: z.array(
        examOut.extend({
          myStatus: z.enum(["belum", "berlangsung", "selesai", "terkunci"]),
          myAttemptId: z.number().nullable(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["siswa"]);
      const rows = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.isPublished, 1))
        .orderBy(desc(schema.exams.id));
      const myAttempts = await db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.studentId, user.id));
      const out = [];
      for (const e of rows) {
        const base = await examToOut(db, e);
        const att = myAttempts.find((a) => a.examId === e.id);
        out.push({
          ...base,
          myStatus: !att
            ? ("belum" as const)
            : att.locked === 1
              ? ("terkunci" as const)
              : att.status === "in_progress"
                ? ("berlangsung" as const)
                : ("selesai" as const),
          myAttemptId: att ? att.id : null,
        });
      }
      return { exams: out };
    },
  }),

  checkExamKey: defineAction({
    description:
      "Siswa memeriksa Key ujian sebelum mulai: Key harus ada, untuk ujian ini, dan belum terpakai. Pemeriksaan ini TIDAK mengonsumsi Key — Key baru terpakai saat ujian benar-benar dimulai (startExam).",
    request: z.object({
      actorId: z.number().int().positive(),
      examId: z.number().int().positive(),
      examKeyCode: z.string().trim().min(1).max(64),
    }),
    response: z.object({ valid: z.literal(true), examTitle: z.string() }),
    async handler(ctx, args): Promise<{ valid: true; examTitle: string }> {
      const { db } = await requireActor(ctx, args.actorId, ["siswa"]);
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, args.examId))
        .limit(1);
      const exam = er[0];
      if (!exam || exam.isPublished !== 1) throw new Error("Ujian tidak tersedia.");
      if (exam.requireExamKey !== 1) return { valid: true, examTitle: exam.title };
      const code = args.examKeyCode.trim().toUpperCase();
      const kr = await db
        .select()
        .from(schema.examKeys)
        .where(eq(schema.examKeys.code, code))
        .limit(1);
      const k = kr[0];
      if (!k || k.examId !== args.examId)
        throw new Error("Key ujian tidak valid untuk ujian ini. Periksa lagi Key dari guru Anda.");
      if (k.isUsed === 1)
        throw new Error("Key ujian ini sudah digunakan dan tidak bisa dipakai ulang. Minta Key baru kepada guru Anda.");
      return { valid: true, examTitle: exam.title };
    },
  }),

  startExam: defineAction({
    description:
      "Siswa mulai/lanjut ujian. Key ujian sekali pakai dikonsumsi di sini bila paket mewajibkannya. Soal dikirim tanpa kunci jawaban.",
    request: z.object({
      actorId: z.number().int().positive(),
      examId: z.number().int().positive(),
      examKeyCode: z.string().trim().max(64).default(""),
    }),
    response: z.object({
      attemptId: z.number(),
      examTitle: z.string(),
      durationMinutes: z.number(),
      startedAt: z.string(),
      deadlineMs: z.number(),
      questions: z.array(questionStudentOut),
      answers: z.record(z.string(), z.string()),
    }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["siswa"]);
      const er = await db
        .select()
        .from(schema.exams)
        .where(eq(schema.exams.id, args.examId))
        .limit(1);
      const exam = er[0];
      if (!exam || exam.isPublished !== 1) throw new Error("Ujian tidak tersedia.");
      const qs = await db
        .select()
        .from(schema.questions)
        .where(eq(schema.questions.examId, args.examId))
        .orderBy(asc(schema.questions.sortOrder), asc(schema.questions.id));
      if (qs.length === 0) throw new Error("Ujian ini belum memiliki soal.");

      const existing = await db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.studentId, user.id))
        .orderBy(desc(schema.attempts.id));
      const mine = existing.find((a) => a.examId === args.examId);
      let attempt: typeof schema.attempts.$inferSelect;
      if (mine) {
        if (mine.locked === 1) {
          throw new Error(
            "Ujian Anda terkunci karena terdeteksi keluar dari aplikasi ujian. Minta pengawas membuka kunci akun Anda.",
          );
        }
        if (mine.status !== "in_progress") {
          throw new Error("Ujian ini sudah Anda kumpulkan.");
        }
        attempt = mine;
      } else {
        if (exam.requireExamKey === 1) {
          const code = args.examKeyCode.trim().toUpperCase();
          if (!code) throw new Error("Ujian ini membutuhkan Key ujian. Masukkan Key dari guru Anda.");
          const kr = await db
            .select()
            .from(schema.examKeys)
            .where(eq(schema.examKeys.code, code))
            .limit(1);
          const k = kr[0];
          if (!k || k.examId !== args.examId)
            throw new Error("Key ujian tidak valid untuk ujian ini.");
          if (k.isUsed === 1)
            throw new Error("Key ujian sudah digunakan dan tidak bisa dipakai ulang.");
          await db
            .update(schema.examKeys)
            .set({ isUsed: 1, usedBy: user.id, usedAt: new Date() })
            .where(eq(schema.examKeys.id, k.id));
        }
        let order = qs.map((q) => q.id);
        if (exam.shuffleQuestions === 1) order = shuffle(order);
        const maxScore = qs.reduce((s, q) => s + q.points, 0);
        const ins = await db
          .insert(schema.attempts)
          .values({
            examId: args.examId,
            studentId: user.id,
            status: "in_progress",
            answers: "{}",
            questionOrder: JSON.stringify(order),
            maxScore,
          })
          .returning();
        const row = ins[0];
        if (!row) throw new Error("Gagal memulai ujian.");
        attempt = row;
      }

      const order = parseIdList(attempt.questionOrder);
      const byId = new Map(qs.map((q) => [q.id, q]));
      const ordered = order
        .map((id) => byId.get(id))
        .filter((q): q is NonNullable<typeof q> => !!q);
      const finalQs = ordered.length === qs.length ? ordered : qs;
      const studentQs = finalQs.map((q) => {
        let opts = parseOptions(q.options);
        if (exam.shuffleOptions === 1 && q.type === "pilihan_ganda") opts = shuffle(opts);
        return {
          id: q.id,
          type: q.type,
          prompt: q.prompt,
          options: opts,
          points: q.points,
        };
      });
      const startedAt = attempt.startedAt;
      ctx.invalidateQueries();
      return {
        attemptId: attempt.id,
        examTitle: exam.title,
        durationMinutes: exam.durationMinutes,
        startedAt: startedAt.toISOString(),
        deadlineMs: startedAt.getTime() + exam.durationMinutes * 60_000,
        questions: studentQs,
        answers: parseAnswers(attempt.answers),
      };
    },
  }),

  saveAnswers: defineAction({
    description: "Menyimpan jawaban siswa secara otomatis selama ujian berlangsung.",
    request: z.object({
      actorId: z.number().int().positive(),
      attemptId: z.number().int().positive(),
      answers: z.record(z.string(), z.string().max(5000)),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const { db, user } = await requireActor(ctx, args.actorId, ["siswa"]);
      const ar = await db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.id, args.attemptId))
        .limit(1);
      const a = ar[0];
      if (!a || a.studentId !== user.id) throw new Error("Sesi ujian tidak ditemukan.");
      if (a.locked === 1) throw new Error("Ujian terkunci. Minta pengawas membuka kunci Anda.");
      if (a.status !== "in_progress") throw new Error("Ujian sudah dikumpulkan.");
      await db
        .update(schema.attempts)
        .set({ answers: JSON.stringify(args.answers) })
        .where(eq(schema.attempts.id, args.attemptId));
      return { ok: true };
    },
  }),

  submitExam: defineAction({
    description:
      "Siswa mengumpulkan jawaban; nilai otomatis dihitung di server dan TIDAK dikembalikan ke siswa.",
    request: z.object({
      actorId: z.number().int().positive(),
      attemptId: z.number().int().positive(),
      answers: z.record(z.string(), z.string().max(5000)),
    }),
    response: z.object({ ok: z.literal(true), message: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; message: string }> {
      const { db, user } = await requireActor(ctx, args.actorId, ["siswa"]);
      const ar = await db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.id, args.attemptId))
        .limit(1);
      const a = ar[0];
      if (!a || a.studentId !== user.id) throw new Error("Sesi ujian tidak ditemukan.");
      if (a.locked === 1) throw new Error("Ujian terkunci. Minta pengawas membuka kunci Anda.");
      if (a.status !== "in_progress") throw new Error("Ujian sudah dikumpulkan sebelumnya.");
      const qs = await db
        .select()
        .from(schema.questions)
        .where(eq(schema.questions.examId, a.examId));
      let auto = 0;
      for (const q of qs) {
        auto += gradeAuto(q, args.answers[String(q.id)]);
      }
      const hasEssay = qs.some((q) => q.type === "essay");
      await db
        .update(schema.attempts)
        .set({
          answers: JSON.stringify(args.answers),
          submittedAt: new Date(),
          status: hasEssay ? "submitted" : "graded",
          autoScore: auto,
          totalScore: auto,
        })
        .where(eq(schema.attempts.id, args.attemptId));
      ctx.invalidateQueries();
      return {
        ok: true,
        message: "Jawaban berhasil dikirim ke guru.",
      };
    },
  }),

  reportViolation: defineAction({
    description:
      "Siswa melaporkan pelanggaran terdeteksi klien (keluar aplikasi, membuka aplikasi lain/mengambang, asisten). Akun siswa dan layar ujiannya langsung dikunci; hanya pengawas/guru/admin yang bisa membuka.",
    request: z.object({
      actorId: z.number().int().positive(),
      attemptId: z.number().int().positive(),
      reason: z.string().trim().min(1).max(200),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const { db, user } = await requireActor(ctx, args.actorId, ["siswa"]);
      const ar = await db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.id, args.attemptId))
        .limit(1);
      const a = ar[0];
      if (!a || a.studentId !== user.id) throw new Error("Sesi ujian tidak ditemukan.");
      if (a.status !== "in_progress") return { ok: true };
      await db
        .update(schema.attempts)
        .set({
          locked: 1,
          lockReason: args.reason,
          violations: a.violations + 1,
          lockedAt: new Date(),
        })
        .where(eq(schema.attempts.id, args.attemptId));
      await db
        .update(schema.users)
        .set({ locked: 1 })
        .where(eq(schema.users.id, user.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------- pengawas ----------

  pengawasMonitor: defineAction({
    description:
      "Pantauan pengawas: peserta dikelompokkan per ujian (mata pelajaran & kelas) milik guru pembuat pengawas, lengkap dengan status akun, status ujian, pelanggaran, dan kunci.",
    request: z.object({ actorId: z.number().int().positive() }),
    response: z.object({
      scopeTeacherName: z.string().nullable(),
      groups: z.array(
        z.object({
          examId: z.number(),
          title: z.string(),
          subject: z.string(),
          kelas: z.string(),
          teacherName: z.string(),
          isPublished: z.boolean(),
          participants: z.array(
            z.object({
              attemptId: z.number().nullable(),
              studentId: z.number(),
              studentName: z.string(),
              status: z.enum(["belum", "berlangsung", "selesai", "terkunci"]),
              accountLocked: z.boolean(),
              lockReason: z.string(),
              violations: z.number(),
              answeredCount: z.number(),
              startedAt: z.string().nullable(),
              submittedAt: z.string().nullable(),
              lockedAt: z.string().nullable(),
            }),
          ),
        }),
      ),
    }),
    async handler(ctx, args) {
      const { db, user } = await requireActor(ctx, args.actorId, ["pengawas", "guru", "admin"]);
      // Ruang lingkup pantauan: pengawas memantau ujian guru yang membuatnya;
      // pengawas buatan admin (dan admin sendiri) memantau semua ujian.
      let scopeTeacherId: number | null = null;
      let scopeTeacherName: string | null = null;
      if (user.role === "guru") scopeTeacherId = user.id;
      if (user.role === "pengawas") scopeTeacherId = user.createdBy;
      if (scopeTeacherId != null) {
        const t = await db
          .select({ name: schema.users.name })
          .from(schema.users)
          .where(eq(schema.users.id, scopeTeacherId))
          .limit(1);
        scopeTeacherName = t[0]?.name ?? null;
      }
      let examRows = await db
        .select()
        .from(schema.exams)
        .orderBy(desc(schema.exams.id));
      if (scopeTeacherId != null) {
        examRows = examRows.filter((e) => e.teacherId === scopeTeacherId);
      }
      const allUsers = await db.select().from(schema.users);
      const userById = new Map(allUsers.map((u) => [u.id, u]));
      const allAttempts = await db
        .select()
        .from(schema.attempts)
        .orderBy(desc(schema.attempts.startedAt));
      const groups = [];
      for (const e of examRows) {
        // Peserta ujian ini: siswa buatan guru pemilik ujian + siapa pun yang
        // sudah punya attempt pada ujian ini.
        const roster = new Map<number, (typeof allUsers)[number]>();
        for (const u of allUsers) {
          if (u.role === "siswa" && u.createdBy === e.teacherId) roster.set(u.id, u);
        }
        const examAttempts = allAttempts.filter((a) => a.examId === e.id);
        for (const a of examAttempts) {
          const stu = userById.get(a.studentId);
          if (stu) roster.set(stu.id, stu);
        }
        const participants = [...roster.values()]
          .sort((x, y) => x.name.localeCompare(y.name))
          .map((stu) => {
            const att = examAttempts.find((a) => a.studentId === stu.id);
            return {
              attemptId: att ? att.id : null,
              studentId: stu.id,
              studentName: stu.name,
              status: !att
                ? ("belum" as const)
                : att.locked === 1
                  ? ("terkunci" as const)
                  : att.status === "in_progress"
                    ? ("berlangsung" as const)
                    : ("selesai" as const),
              accountLocked: stu.locked === 1,
              lockReason: att ? att.lockReason : "",
              violations: att ? att.violations : 0,
              answeredCount: att
                ? Object.values(parseAnswers(att.answers)).filter((v) => v.trim() !== "").length
                : 0,
              startedAt: att ? att.startedAt.toISOString() : null,
              submittedAt: att?.submittedAt ? att.submittedAt.toISOString() : null,
              lockedAt: att?.lockedAt ? att.lockedAt.toISOString() : null,
            };
          });
        groups.push({
          examId: e.id,
          title: e.title,
          subject: e.subject,
          kelas: e.kelas,
          teacherName: userById.get(e.teacherId)?.name ?? "—",
          isPublished: e.isPublished === 1,
          participants,
        });
      }
      return { scopeTeacherName, groups };
    },
  }),
} satisfies ActionsModule;

// Client-facing action signatures (used by client/src/api.ts type imports).
export type Actions = {
  [K in keyof typeof Actions]: (
    args: z.infer<(typeof Actions)[K]["request"]>,
  ) => Promise<z.infer<(typeof Actions)[K]["response"]>>;
};
