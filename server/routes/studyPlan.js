const router    = require('express').Router()
const multer    = require('multer')
const pool      = require('../db')
const authGuard = require('../middleware/authGuard')
const { hasPremium } = require('../middleware/roleCheck')
const { callGroq } = require('../services/grok')
const { extractText } = require('../services/fileParser')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase()
    if (['pdf','docx','pptx','txt'].includes(ext)) cb(null, true)
    else cb(new Error('Unsupported file type'))
  }
})

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
async function generateSchedule(examName, examDate, subjects, weakAreas, documentText = '') {
  const today    = new Date()
  const examDay  = new Date(examDate)
  const daysLeft = Math.ceil((examDay - today) / (1000 * 60 * 60 * 24))

  if (daysLeft < 1) throw new Error('Exam date must be in the future')

  const system = `You are an expert study planner. Return ONLY valid JSON, no markdown fences.
Schema: {"days":[{"date":"YYYY-MM-DD","topics":[{"title":"Topic title","description":"Brief 1 sentence what to study","duration_mins":30,"is_weak_area":false}]}]}
Rules:
- Generate exactly ${Math.min(daysLeft, 60)} days from ${today.toISOString().split('T')[0]} to ${new Date(examDay.getTime() - 86400000).toISOString().split('T')[0]}
- ${documentText ? 'Extract specific topics, chapters and concepts from the provided document content' : 'Generate topics based on the subjects provided'}
- Prioritise weak areas in the first half and revisit near exam
- Each day should have 2-4 topics
- Duration per topic: 20-60 minutes
- Mix subjects throughout the week
- Mark weak area topics with is_weak_area: true
- Last 2-3 days before exam: revision and past questions only
- Keep topic titles concise (max 8 words)`

  const prompt = documentText
    ? `Create a study plan for: ${examName}
Exam date: ${examDate}
Subjects: ${subjects.join(', ')}
Weak areas: ${weakAreas || 'None specified'}
Days available: ${daysLeft}

DOCUMENT CONTENT TO BASE TOPICS ON:
${documentText.slice(0, 6000)}`
    : `Create a study plan for: ${examName}
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
// Accepts multipart/form-data with optional file upload
router.post('/create', premiumCheck, upload.single('document'), async (req, res) => {
  try {
    // Parse subjects from JSON string (sent as form field)
    let { exam_name, exam_date, subjects, weak_areas } = req.body
    if (typeof subjects === 'string') {
      try { subjects = JSON.parse(subjects) } catch { subjects = [subjects] }
    }

    if (!exam_name || !exam_date || !subjects?.length) {
      return res.status(400).json({ error: 'Exam name, date and subjects are required' })
    }

    // Extract text from uploaded document if provided
    let documentText = ''
    let documentName = ''
    if (req.file) {
      try {
        const extracted = await extractText(req.file.buffer, req.file.originalname)
        documentText = extracted.text
        documentName = req.file.originalname
      } catch (err) {
        console.warn('Could not extract document text:', err.message)
        // Continue without document — don't fail the whole request
      }
    }

    const schedule = await generateSchedule(exam_name, exam_date, subjects, weak_areas, documentText)

    const result = await pool.query(`
      INSERT INTO study_plans (user_id, exam_name, exam_date, subjects, weak_areas, schedule, document_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [req.user.id, exam_name, exam_date, JSON.stringify(subjects), weak_areas || '', JSON.stringify(schedule), documentName || null])

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
