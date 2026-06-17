const router    = require('express').Router()
const pool      = require('../db')
const authGuard = require('../middleware/authGuard')
const { getPlanLimits } = require('../middleware/roleCheck')

router.use(authGuard)

// ── GET /api/user/profile ────────────────────────────
router.get('/profile', async (req, res) => {
  try {
    const u = req.user
    const limits = getPlanLimits(u)

    // Get progress
    const prog = await pool.query('SELECT * FROM progress WHERE user_id = $1', [u.id])
    const progress = prog.rows[0] || {}

    // Trial days left
    const now = new Date()
    const trialEnd = new Date(u.trial_ends_at)
    const trialDaysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)))
    const isOnTrial = trialEnd > now

    res.json({
      user: {
        id:             u.id,
        name:           u.name,
        email:          u.email,
        role:           u.role,
        plan:           u.plan,
        trial_ends_at:  u.trial_ends_at,
        premium_until:  u.premium_until,
        referral_code:  u.referral_code,
        referral_count: u.referral_count,
        created_at:     u.created_at,
      },
      limits,
      trial: { isOnTrial, daysLeft: trialDaysLeft },
      progress: {
        streak:         progress.streak         || 0,
        longestStreak:  progress.longest_streak || 0,
        totalSessions:  progress.total_sessions  || 0,
        totalQuizzes:   progress.total_quizzes   || 0,
        avgQuizScore:   parseFloat(progress.avg_quiz_score) || 0,
        lastStudyDate:  progress.last_study_date || null,
      },
    })
  } catch (err) {
    console.error('Profile error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/user/profile ──────────────────────────
router.patch('/profile', async (req, res) => {
  try {
    const { name } = req.body
    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' })
    }
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), req.user.id])
    res.json({ message: 'Profile updated', name: name.trim() })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/user/referrals ──────────────────────────
router.get('/referrals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.created_at, u.name, u.email, r.rewarded
      FROM referrals r
      JOIN users u ON u.id = r.referred_id
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC
    `, [req.user.id])

    const count = result.rows.length
    const nextRewardAt = Math.ceil(count / 5) * 5
    const progressToNext = count % 5

    res.json({
      referrals:      result.rows,
      count,
      referral_code:  req.user.referral_code,
      referral_link:  `${process.env.CLIENT_URL}/register?ref=${req.user.referral_code}`,
      nextRewardAt,
      progressToNext,
      rewardsEarned:  Math.floor(count / 5),
    })
  } catch (err) {
    console.error('Referral error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/user/quiz-history ───────────────────────
router.get('/quiz-history', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT qr.*, s.title as session_title
      FROM quiz_results qr
      LEFT JOIN sessions s ON s.id = qr.session_id
      WHERE qr.user_id = $1
      ORDER BY qr.created_at DESC
      LIMIT 20
    `, [req.user.id])

    res.json({ results: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/user/stats ──────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [prog, toolUsage, recentSessions] = await Promise.all([
      pool.query('SELECT * FROM progress WHERE user_id = $1', [req.user.id]),
      pool.query(`
        SELECT tool, COUNT(*) as count
        FROM tool_usage WHERE user_id = $1
        GROUP BY tool ORDER BY count DESC
      `, [req.user.id]),
      pool.query(`
        SELECT id, title, source_type, created_at
        FROM sessions WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 5
      `, [req.user.id]),
    ])

    res.json({
      progress:       prog.rows[0] || {},
      toolUsage:      toolUsage.rows,
      recentSessions: recentSessions.rows,
    })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
