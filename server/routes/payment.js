const router    = require('express').Router()
const axios     = require('axios')
const crypto    = require('crypto')
const pool      = require('../db')
const authGuard = require('../middleware/authGuard')

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY
const PLAN_AMOUNT     = 70000 // ₦700 in kobo

// ── POST /api/payment/initialize ─────────────────────
// Start a payment — returns authorization_url to redirect user
router.post('/initialize', authGuard, async (req, res) => {
  try {
    const user = req.user

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email:        user.email,
        amount:       PLAN_AMOUNT,
        currency:     'NGN',
        callback_url: `${process.env.CLIENT_URL}/payment/verify`,
        metadata: {
          user_id:    user.id,
          user_name:  user.name,
          plan:       'premium',
        },
        channels: ['card', 'bank', 'ussd', 'bank_transfer', 'mobile_money'],
      },
      {
        headers: {
          Authorization:  `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json',
        },
      }
    )

    const { authorization_url, reference, access_code } = response.data.data

    // Save pending transaction
    await pool.query(`
      INSERT INTO transactions (user_id, reference, amount, status)
      VALUES ($1, $2, $3, 'pending')
      ON CONFLICT (reference) DO NOTHING
    `, [user.id, reference, PLAN_AMOUNT])

    res.json({ authorization_url, reference })

  } catch (err) {
    console.error('Payment init error:', err.response?.data || err.message)
    res.status(500).json({ error: 'Could not initialize payment. Try again.' })
  }
})

// ── GET /api/payment/verify/:reference ───────────────
// Verify payment after redirect back from Paystack
router.get('/verify/:reference', authGuard, async (req, res) => {
  try {
    const { reference } = req.params

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      }
    )

    const data   = response.data.data
    const status = data.status

    if (status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful', status })
    }

    // Upgrade user to premium for 30 days
    const premiumUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    await pool.query(`
      UPDATE users
      SET plan = 'premium', premium_until = $1
      WHERE id = $2
    `, [premiumUntil, req.user.id])

    // Update transaction status
    await pool.query(`
      UPDATE transactions
      SET status = 'success', paid_at = NOW()
      WHERE reference = $1
    `, [reference])

    res.json({
      message:       'Payment successful! Premium activated.',
      premium_until: premiumUntil,
    })

  } catch (err) {
    console.error('Payment verify error:', err.response?.data || err.message)
    res.status(500).json({ error: 'Could not verify payment. Contact support.' })
  }
})

// ── POST /api/payment/webhook ─────────────────────────
// Paystack webhook — auto-upgrade on successful charge
router.post('/webhook', async (req, res) => {
  try {
    // Verify webhook signature
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex')

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).send('Invalid signature')
    }

    const { event, data } = req.body

    if (event === 'charge.success') {
      const userId = data.metadata?.user_id

      if (userId) {
        const premiumUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

        await pool.query(`
          UPDATE users
          SET plan = 'premium', premium_until = $1
          WHERE id = $2
        `, [premiumUntil, userId])

        await pool.query(`
          UPDATE transactions
          SET status = 'success', paid_at = NOW()
          WHERE reference = $1
        `, [data.reference])

        console.log(`✅ Premium activated for user ${userId}`)
      }
    }

    res.sendStatus(200)

  } catch (err) {
    console.error('Webhook error:', err)
    res.sendStatus(500)
  }
})

// ── GET /api/payment/history ──────────────────────────
router.get('/history', authGuard, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT reference, amount, status, paid_at, created_at
      FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [req.user.id])

    res.json({ transactions: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
