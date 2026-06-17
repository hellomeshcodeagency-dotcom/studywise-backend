-- ═══════════════════════════════════════════════════
-- StudyWise Database Schema
-- Run this in your Render PostgreSQL console
-- ═══════════════════════════════════════════════════

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100)  NOT NULL,
  email           VARCHAR(255)  UNIQUE NOT NULL,
  password_hash   VARCHAR(255)  NOT NULL,
  role            VARCHAR(20)   NOT NULL DEFAULT 'student', -- student | admin
  plan            VARCHAR(20)   NOT NULL DEFAULT 'free',    -- free | premium
  trial_ends_at   TIMESTAMPTZ   NOT NULL DEFAULT (NOW() + INTERVAL '3 days'),
  trial_used      BOOLEAN       NOT NULL DEFAULT false,
  referral_code   VARCHAR(20)   UNIQUE NOT NULL,
  referred_by     UUID          REFERENCES users(id),
  referral_count  INTEGER       NOT NULL DEFAULT 0,
  premium_until   TIMESTAMPTZ,
  is_suspended    BOOLEAN       NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_active     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Sessions (content a student loaded)
CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(255),
  source_type  VARCHAR(20) NOT NULL, -- paste | pdf | url
  content_text TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tool usage (every time a tool is used)
CREATE TABLE IF NOT EXISTS tool_usage (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,
  tool        VARCHAR(30) NOT NULL, -- explain|quiz|flashcards|summary|mindmap|chat|practice|pomodoro
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quiz results
CREATE TABLE IF NOT EXISTS quiz_results (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,
  score       INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  level       VARCHAR(20),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Progress / streaks
CREATE TABLE IF NOT EXISTS progress (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  streak          INTEGER NOT NULL DEFAULT 0,
  longest_streak  INTEGER NOT NULL DEFAULT 0,
  total_sessions  INTEGER NOT NULL DEFAULT 0,
  total_quizzes   INTEGER NOT NULL DEFAULT 0,
  avg_quiz_score  NUMERIC(5,2) NOT NULL DEFAULT 0,
  last_study_date DATE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Referrals tracking
CREATE TABLE IF NOT EXISTS referrals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rewarded      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══ INDEXES ═══════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_tool_usage_user  ON tool_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_results_user ON quiz_results(user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

-- ═══ SEED ADMIN ════════════════════════════════════
-- The admin account is created automatically on server start
-- via the /api/admin/seed endpoint (one-time only)
