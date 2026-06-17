const router    = require('express').Router()
const pool      = require('../db')
const authGuard = require('../middleware/authGuard')
const { adminOnly } = require('../middleware/roleCheck')

router.use(authGuard, adminOnly)

// ── GET /api/admin/stats ─────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [
      totalUsers,
      activeTrials,
      premiumUsers,
      todaySignups,
      totalSessions,
      totalQuizzes,
      toolBreakdown,
      recentSignups,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users WHERE role != $1', ['admin']),
      pool.query('SELECT COUNT(*) FROM users WHERE trial_ends_at > NOW() AND role != $1', ['admin']),
      pool.query('SELECT COUNT(*) FROM users WHERE plan = $1 AND role != $2', ['premium','admin']),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours' AND role != $1", ['admin']),
      pool.query('SELECT COUNT(*) FROM sessions'),
      pool.query('SELECT COUNT(*) FROM quiz_results'),
      pool.query(`SELECT tool, COUNT(*) as count FROM tool_usage GROUP BY tool ORDER BY count DESC`),
      pool.query(`SELECT id, name, email, plan, trial_ends_at, created_at, is_suspended FROM users WHERE role != 'admin' ORDER BY created_at DESC LIMIT 10`),
    ])

    res.json({
      stats: {
        totalUsers:    parseInt(totalUsers.rows[0].count),
        activeTrials:  parseInt(activeTrials.rows[0].count),
        premiumUsers:  parseInt(premiumUsers.rows[0].count),
        freeUsers:     parseInt(totalUsers.rows[0].count) - parseInt(premiumUsers.rows[0].count),
        todaySignups:  parseInt(todaySignups.rows[0].count),
        totalSessions: parseInt(totalSessions.rows[0].count),
        totalQuizzes:  parseInt(totalQuizzes.rows[0].count),
      },
      toolBreakdown:  toolBreakdown.rows,
      recentSignups:  recentSignups.rows,
    })
  } catch (err) {
    console.error('Admin stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/admin/users ─────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', plan = '' } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let where = `WHERE role != 'admin'`
    const params = []

    if (search) {
      params.push(`%${search}%`)
      where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`
    }

    if (plan) {
      params.push(plan)
      where += ` AND plan = $${params.length}`
    }

    params.push(parseInt(limit), offset)

    const [users, count] = await Promise.all([
      pool.query(`
        SELECT u.id, u.name, u.email, u.plan, u.role, u.trial_ends_at,
               u.premium_until, u.referral_count, u.is_suspended,
               u.created_at, u.last_active,
               p.streak, p.total_sessions, p.total_quizzes, p.avg_quiz_score
        FROM users u
        LEFT JOIN progress p ON p.user_id = u.id
        ${where}
        ORDER BY u.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params),
      pool.query(`SELECT COUNT(*) FROM users ${where}`, params.slice(0, -2)),
    ])

    res.json({
      users:      users.rows,
      total:      parseInt(count.rows[0].count),
      page:       parseInt(page),
      totalPages: Math.ceil(parseInt(count.rows[0].count) / parseInt(limit)),
    })
  } catch (err) {
    console.error('Admin users error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/admin/users/:id ─────────────────────────
router.get('/users/:id', async (req, res) => {
  try {
    const [user, sessions, quizzes, tools] = await Promise.all([
      pool.query(`
        SELECT u.*, p.streak, p.total_sessions, p.total_quizzes, p.avg_quiz_score, p.last_study_date
        FROM users u LEFT JOIN progress p ON p.user_id = u.id
        WHERE u.id = $1
      `, [req.params.id]),
      pool.query('SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [req.params.id]),
      pool.query('SELECT * FROM quiz_results WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [req.params.id]),
      pool.query('SELECT tool, COUNT(*) as count FROM tool_usage WHERE user_id = $1 GROUP BY tool', [req.params.id]),
    ])

    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    res.json({ user: user.rows[0], sessions: sessions.rows, quizzes: quizzes.rows, tools: tools.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/admin/users/:id/plan ──────────────────
router.patch('/users/:id/plan', async (req, res) => {
  try {
    const { plan, months = 1 } = req.body

    if (!['free','premium'].includes(plan)) {
      return res.status(400).json({ error: 'Plan must be free or premium' })
    }

    let premiumUntil = null
    if (plan === 'premium') {
      premiumUntil = new Date(Date.now() + parseInt(months) * 30 * 24 * 60 * 60 * 1000)
    }

    await pool.query(
      'UPDATE users SET plan = $1, premium_until = $2 WHERE id = $3',
      [plan, premiumUntil, req.params.id]
    )

    res.json({ message: `User plan updated to ${plan}` })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/admin/users/:id/suspend ───────────────
router.patch('/users/:id/suspend', async (req, res) => {
  try {
    const { suspended } = req.body
    await pool.query('UPDATE users SET is_suspended = $1 WHERE id = $2', [suspended, req.params.id])
    res.json({ message: `User ${suspended ? 'suspended' : 'unsuspended'}` })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/admin/users/:id ──────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1 AND role != $2', [req.params.id, 'admin'])
    res.json({ message: 'User deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
