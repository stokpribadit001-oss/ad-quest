-- AD QUEST — initial Postgres schema (Neon).
-- Mirrors the Muse artifact's SQLite schema (users, exams, questions,
-- exam_keys, attempts incl. Pengawas lock columns, app_settings incl.
-- exams.kelas). Idempotent: applied automatically by the server on boot
-- (see server/src/db.ts) and can also be run manually in the Neon SQL editor.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  access_key TEXT NOT NULL UNIQUE,
  locked INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  kelas TEXT NOT NULL DEFAULT '',
  teacher_id INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  shuffle_questions INTEGER NOT NULL DEFAULT 0,
  shuffle_options INTEGER NOT NULL DEFAULT 0,
  require_exam_key INTEGER NOT NULL DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT,
  correct_answer TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 10,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exam_keys (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  exam_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  used_by INTEGER,
  used_at TIMESTAMP,
  is_used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT now(),
  submitted_at TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'in_progress',
  answers TEXT NOT NULL DEFAULT '{}',
  question_order TEXT NOT NULL DEFAULT '[]',
  auto_score INTEGER,
  essay_scores TEXT,
  total_score INTEGER,
  max_score INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  lock_reason TEXT NOT NULL DEFAULT '',
  violations INTEGER NOT NULL DEFAULT 0,
  locked_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY,
  app_name TEXT NOT NULL DEFAULT 'AD QUEST',
  school_name TEXT NOT NULL DEFAULT '',
  announcement TEXT NOT NULL DEFAULT ''
);
