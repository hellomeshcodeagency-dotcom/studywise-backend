const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const pool    = require('../db')
const authGuard = require('../middleware/authGuard')

function makeToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' })
}

function makeReferralCode() {
  return Math.random().toString(36).substring(2, 9).toUpperCase()
}

function sanitizeUser(u) {
  return {
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
  }
}

// ── POST /api/auth/register ──────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, referral_code } = req.body

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' })
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }

    // Check duplicate email
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' })
    }

    const hash = await bcrypt.hash(password, 12)
    const code = makeReferralCode()

    // If referred, give +3 extra days (6 total instead of 3)
    const trialDays    = referral_code ? 6 : 3
    const trialEndsAt  = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000)

    // Find referrer
    let referrerId = null
    if (referral_code) {
      const ref = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referral_code.toUpperCase()])
      if (ref.rows.length > 0) referrerId = ref.rows[0].id
    }

    const result = await pool.query(`
      INSERT INTO users (name, email, password_hash, referral_code, referred_by, trial_ends_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [name.trim(), email.toLowerCase(), hash, code, referrerId, trialEndsAt])

    const user = result.rows[0]

    // Create progress row
    await pool.query('INSERT INTO progress (user_id) VALUES ($1)', [user.id])

    // Handle referral tracking
    if (referrerId) {
      await pool.query(
        'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)',
        [referrerId, user.id]
      )

      // Increment referrer's count
      await pool.query(
        'UPDATE users SET referral_count = referral_count + 1 WHERE id = $1',
        [referrerId]
      )

      // Check if referrer hit 5 — give 1 month free premium
      const referrer = await pool.query('SELECT referral_count, premium_until FROM users WHERE id = $1', [referrerId])
      const rRow = referrer.rows[0]

      if (rRow.referral_count % 5 === 0) {
        const newPremiumUntil = rRow.premium_until && new Date(rRow.premium_until) > new Date()
          ? new Date(new Date(rRow.premium_until).getTime() + 30 * 24 * 60 * 60 * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

        await pool.query(
          'UPDATE users SET plan = $1, premium_until = $2 WHERE id = $3',
          ['premium', newPremiumUntil, referrerId]
        )

        // Mark referral as rewarded
        await pool.query(
          'UPDATE referrals SET rewarded = true WHERE referrer_id = $1 AND rewarded = false',
          [referrerId]
        )
      }
    }

    const token = makeToken(user.id)
    res.status(201).json({ token, user: sanitizeUser(user) })

  } catch (err) {
    console.error('Register error:', err)
    res.status(500).json({ error: 'Server error. Please try again.' })
  }
})

// ── POST /api/auth/login ─────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()])
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const user = result.rows[0]

    if (user.is_suspended) {
      return res.status(403).json({ error: 'Account suspended. Contact support.' })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [user.id])

    const token = makeToken(user.id)
    res.json({ token, user: sanitizeUser(user) })

  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: 'Server error. Please try again.' })
  }
})

// ── GET /api/auth/me ─────────────────────────────────
router.get('/me', authGuard, async (req, res) => {
  res.json({ user: sanitizeUser(req.user) })
})

// ── POST /api/auth/change-password ───────────────────
router.post('/change-password', authGuard, async (req, res) => {
  try {
    const { current_password, new_password } = req.body
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Both fields are required' })
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' })
    }

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])
    const valid = await bcrypt.compare(current_password, result.rows[0].password_hash)
    if (!valid) return res.status(401).json({ error: 'Current password is wrong' })

    const hash = await bcrypt.hash(new_password, 12)
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id])

    res.json({ message: 'Password updated' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
