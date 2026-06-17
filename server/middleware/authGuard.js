const jwt = require('jsonwebtoken')
const pool = require('../db')

async function authGuard(req, res, next) {
  try {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' })
    }

    const token = header.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    // Fetch fresh user from DB
    const result = await pool.query(
      'SELECT id, name, email, role, plan, trial_ends_at, is_suspended, referral_code, referral_count, premium_until FROM users WHERE id = $1',
      [decoded.userId]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' })
    }

    const user = result.rows[0]

    if (user.is_suspended) {
      return res.status(403).json({ error: 'Account suspended. Contact support.' })
    }

    req.user = user

    // Update last_active
    await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [user.id])

    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' })
    }
    return res.status(401).json({ error: 'Invalid token' })
  }
}

module.exports = authGuard
