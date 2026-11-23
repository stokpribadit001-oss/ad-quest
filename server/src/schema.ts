import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  role: text("role", { enum: ["admin", "guru", "siswa", "pengawas"] }).notNull(),
  accessKey: text("access_key").notNull().unique(),
  locked: integer("locked").notNull().default(0),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const exams = pgTable("exams", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  subject: text("subject").notNull().default(""),
  kelas: text("kelas").notNull().default(""),
  teacherId: integer("teacher_id").notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  shuffleQuestions: integer("shuffle_questions").notNull().default(0),
  shuffleOptions: integer("shuffle_options").notNull().default(0),
  requireExamKey: integer("require_exam_key").notNull().default(0),
  isPublished: integer("is_published").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const questions = pgTable("questions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  examId: integer("exam_id").notNull(),
  type: text("type", {
    enum: ["pilihan_ganda", "isian", "essay", "angka"],
  }).notNull(),
  prompt: text("prompt").notNull(),
  options: text("options"),
  correctAnswer: text("correct_answer").notNull().default(""),
  points: integer("points").notNull().default(10),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const examKeys = pgTable("exam_keys", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: text("code").notNull().unique(),
  examId: integer("exam_id").notNull(),
  createdBy: integer("created_by").notNull(),
  usedBy: integer("used_by"),
  usedAt: timestamp("used_at", { mode: "date" }),
  isUsed: integer("is_used").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const attempts = pgTable("attempts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  examId: integer("exam_id").notNull(),
  studentId: integer("student_id").notNull(),
  startedAt: timestamp("started_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  submittedAt: timestamp("submitted_at", { mode: "date" }),
  status: text("status", {
    enum: ["in_progress", "submitted", "graded"],
  })
    .notNull()
    .default("in_progress"),
  answers: text("answers").notNull().default("{}"),
  questionOrder: text("question_order").notNull().default("[]"),
  autoScore: integer("auto_score"),
  essayScores: text("essay_scores"),
  totalScore: integer("total_score"),
  maxScore: integer("max_score").notNull().default(0),
  locked: integer("locked").notNull().default(0),
  lockReason: text("lock_reason").notNull().default(""),
  violations: integer("violations").notNull().default(0),
  lockedAt: timestamp("locked_at", { mode: "date" }),
});

export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey(),
  appName: text("app_name").notNull().default("AD QUEST"),
  schoolName: text("school_name").notNull().default(""),
  announcement: text("announcement").notNull().default(""),
});
