const pool = require('./index')

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name            VARCHAR(100)  NOT NULL,
        email           VARCHAR(255)  UNIQUE NOT NULL,
        password_hash   VARCHAR(255)  NOT NULL,
        role            VARCHAR(20)   NOT NULL DEFAULT 'student',
        plan            VARCHAR(20)   NOT NULL DEFAULT 'free',
        trial_ends_at   TIMESTAMPTZ   NOT NULL DEFAULT (NOW() + INTERVAL '3 days'),
        trial_used      BOOLEAN       NOT NULL DEFAULT false,
        referral_code   VARCHAR(20)   UNIQUE NOT NULL,
        referred_by     UUID          REFERENCES users(id),
        referral_count  INTEGER       NOT NULL DEFAULT 0,
        premium_until   TIMESTAMPTZ,
        is_suspended    BOOLEAN       NOT NULL DEFAULT false,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        last_active     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title        VARCHAR(255),
        source_type  VARCHAR(20) NOT NULL,
        content_text TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tool_usage (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,
        tool        VARCHAR(30) NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_results (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,
        score       INTEGER NOT NULL,
        total       INTEGER NOT NULL,
        level       VARCHAR(20),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await pool.query(`
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
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referred_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rewarded      BOOLEAN NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // Indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tool_usage_user ON tool_usage(user_id)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_quiz_results_user ON quiz_results(user_id)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)`)

    console.log('✅ Database tables ready')

    // Seed admin if not exists
    await seedAdmin()

  } catch (err) {
    console.error('❌ DB init error:', err.message)
    throw err
  }
}

async function seedAdmin() {
  const bcrypt = require('bcryptjs')
  const { v4: uuidv4 } = require('uuid')

  const adminEmail = process.env.ADMIN_EMAIL
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminEmail || !adminPassword) {
    console.log('⚠️  No ADMIN_EMAIL/ADMIN_PASSWORD set — skipping admin seed')
    return
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail])
  if (existing.rows.length > 0) return

  const hash = await bcrypt.hash(adminPassword, 12)
  const code = 'ADMIN' + Math.random().toString(36).substring(2, 8).toUpperCase()

  await pool.query(`
    INSERT INTO users (name, email, password_hash, role, plan, referral_code, trial_ends_at)
    VALUES ($1, $2, $3, 'admin', 'premium', $4, NOW() + INTERVAL '100 years')
  `, ['Admin', adminEmail, hash, code])

  console.log('✅ Admin account seeded')
}

module.exports = initDB
