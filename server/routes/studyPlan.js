const router    = require('express').Router()
const pool      = require('../db')
const authGuard = require('../middleware/authGuard')
const { hasPremium } = require('../middleware/roleCheck')
const { callGroq } = require('../services/grok')

router.use(authGuard)

// Premium check middleware
function premiumCheck(req, res, next) {
  if (!hasPremium(req.user)) {
    return res.status(403).json({
      error: 'Premium feature',
      code: 'UPGRADE_REQUIRED',
      message: 'Study Plans require Premium. Upgrade for ₦700/month.',
    })
  }
  next()
}

// Generate schedule using Groq AI
async function generateSchedule(examName, examDate, subjects, weakAreas) {
  const today    = new Date()
  const examDay  = new Date(examDate)
  const daysLeft = Math.ceil((examDay - today) / (1000 * 60 * 60 * 24))

  if (daysLeft < 1) throw new Error('Exam date must be in the future')

  const system = `You are an expert study planner. Return ONLY valid JSON, no markdown fences.
Schema: {"days":[{"date":"YYYY-MM-DD","topics":[{"title":"Topic title","description":"Brief 1 sentence description","duration_mins":30,"is_weak_area":false}]}]}
Rules:
- Generate exactly ${Math.min(daysLeft, 60)} days of study schedule from ${today.toISOString().split('T')[0]} to ${new Date(examDay.getTime() - 86400000).toISOString().split('T')[0]}
- Prioritise weak areas in the first half of the schedule and revisit them near the exam
- Each day should have 2-4 topics
- Duration per topic: 20-60 minutes
- Mix subjects throughout the week, don't do the same subject all day
- Mark weak area topics with is_weak_area: true
- Last 2-3 days before exam: revision and past questions only
- Keep topic titles concise (max 8 words)`

  const prompt = `Create a study plan for: ${examName}
Exam date: ${examDate}
Subjects: ${subjects.join(', ')}
Weak areas: ${weakAreas || 'None specified'}
Days available: ${daysLeft}`

  const raw  = await callGroq([{ role:'user', content:prompt }], system, 1500)
  const data = JSON.parse(raw.replace(/```json|```/g, '').trim())
  return data.days
}

// ── GET /api/plan ─────────────────────────────────────
router.get('/', premiumCheck, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM study_plans WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    )
    res.json({ plans: result.rows })
  } catch (err) {
    console.error('Get plans error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/plan/create ─────────────────────────────
router.post('/create', premiumCheck, async (req, res) => {
  try {
    const { exam_name, exam_date, subjects, weak_areas } = req.body

    if (!exam_name || !exam_date || !subjects?.length) {
      return res.status(400).json({ error: 'Exam name, date and subjects are required' })
    }

    const schedule = await generateSchedule(exam_name, exam_date, subjects, weak_areas)

    const result = await pool.query(`
      INSERT INTO study_plans (user_id, exam_name, exam_date, subjects, weak_areas, schedule)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [req.user.id, exam_name, exam_date, JSON.stringify(subjects), weak_areas || '', JSON.stringify(schedule)])

    res.status(201).json({ plan: result.rows[0] })
  } catch (err) {
    console.error('Create plan error:', err)
    res.status(500).json({ error: err.message || 'Failed to create plan' })
  }
})

// ── PATCH /api/plan/:id/topic ─────────────────────────
// Toggle a topic as done/undone and auto-adjust remaining schedule
router.patch('/:id/topic', premiumCheck, async (req, res) => {
  try {
    const { dayIdx, topicIdx } = req.body

    const result = await pool.query(
      'SELECT * FROM study_plans WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Plan not found' })

    const plan     = result.rows[0]
    const schedule = plan.schedule

    // Toggle the topic
    if (schedule[dayIdx] && schedule[dayIdx].topics[topicIdx] !== undefined) {
      schedule[dayIdx].topics[topicIdx].done = !schedule[dayIdx].topics[topicIdx].done
    }

    const updated = await pool.query(
      'UPDATE study_plans SET schedule = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [JSON.stringify(schedule), plan.id]
    )

    res.json({ plan: updated.rows[0] })
  } catch (err) {
    console.error('Toggle topic error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/plan/:id/regenerate ────────────────────
router.post('/:id/regenerate', premiumCheck, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM study_plans WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Plan not found' })

    const plan     = result.rows[0]
    const subjects = typeof plan.subjects === 'string' ? JSON.parse(plan.subjects) : plan.subjects
    const schedule = await generateSchedule(plan.exam_name, plan.exam_date, subjects, plan.weak_areas)

    const updated = await pool.query(
      'UPDATE study_plans SET schedule = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [JSON.stringify(schedule), plan.id]
    )

    res.json({ plan: updated.rows[0] })
  } catch (err) {
    console.error('Regenerate error:', err)
    res.status(500).json({ error: 'Failed to regenerate plan' })
  }
})

// ── DELETE /api/plan/:id ──────────────────────────────
router.delete('/:id', premiumCheck, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM study_plans WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    res.json({ message: 'Plan deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
