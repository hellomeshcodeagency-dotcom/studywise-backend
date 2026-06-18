const router    = require('express').Router()
const multer    = require('multer')
const pool      = require('../db')
const authGuard = require('../middleware/authGuard')
const { premiumOnly, getPlanLimits } = require('../middleware/roleCheck')
const grok      = require('../services/grok')
const { extractText } = require('../services/fileParser')

const ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
]

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [...ALLOWED_TYPES, 'application/octet-stream']
    // Also allow by extension for cases where mimetype is wrong
    const ext = file.originalname.split('.').pop().toLowerCase()
    if (ALLOWED_TYPES.includes(file.mimetype) || ['pdf','docx','pptx','txt'].includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('Unsupported file type. Please upload PDF, DOCX, PPTX, or TXT.'))
    }
  }
})

router.use(authGuard)

// Helper: log tool usage
async function logUsage(userId, sessionId, tool) {
  await pool.query(
    'INSERT INTO tool_usage (user_id, session_id, tool) VALUES ($1, $2, $3)',
    [userId, sessionId, tool]
  )
}

// Helper: update progress streak
async function updateStreak(userId) {
  const prog = await pool.query('SELECT * FROM progress WHERE user_id = $1', [userId])
  if (prog.rows.length === 0) return

  const p = prog.rows[0]
  const today = new Date().toISOString().split('T')[0]
  const last  = p.last_study_date ? new Date(p.last_study_date).toISOString().split('T')[0] : null

  let streak = p.streak
  if (last === today) return // already updated today
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  streak = last === yesterday ? streak + 1 : 1

  await pool.query(`
    UPDATE progress SET
      streak = $1,
      longest_streak = GREATEST(longest_streak, $1),
      total_sessions = total_sessions + 1,
      last_study_date = $2,
      updated_at = NOW()
    WHERE user_id = $3
  `, [streak, today, userId])
}

// ── POST /api/study/session ──────────────────────────
// Create a session (save the content)
router.post('/session', async (req, res) => {
  try {
    const { title, source_type, content_text } = req.body
    const limits = getPlanLimits(req.user)

    // Check session limit for free users
    if (!limits.isPremium) {
      const count = await pool.query(
        'SELECT COUNT(*) FROM sessions WHERE user_id = $1',
        [req.user.id]
      )
      if (parseInt(count.rows[0].count) >= limits.maxSessions) {
        return res.status(403).json({
          error: 'Session limit reached',
          code: 'UPGRADE_REQUIRED',
          message: `Free plan allows ${limits.maxSessions} saved sessions. Upgrade to save unlimited sessions.`,
        })
      }
    }

    const result = await pool.query(`
      INSERT INTO sessions (user_id, title, source_type, content_text)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [req.user.id, title || 'Untitled Session', source_type, content_text])

    await updateStreak(req.user.id)
    res.status(201).json({ session: result.rows[0] })

  } catch (err) {
    console.error('Session error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/study/upload-file ──────────────────────
// Supports PDF, DOCX, PPTX, TXT
router.post('/upload-file', premiumOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const result = await extractText(req.file.buffer, req.file.originalname)

    res.json({
      text:     result.text,
      pages:    result.pages,
      type:     result.type,
      filename: req.file.originalname,
      chars:    result.text.length,
    })

  } catch (err) {
    console.error('File parse error:', err)
    res.status(400).json({ error: err.message || 'Failed to read file. Try pasting the text instead.' })
  }
})

// Keep old route as alias for backwards compatibility
router.post('/upload-pdf', premiumOnly, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const result = await extractText(req.file.buffer, req.file.originalname)
    res.json({ text: result.text, pages: result.pages, filename: req.file.originalname })
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to read file.' })
  }
})

// ── POST /api/study/explain ──────────────────────────
router.post('/explain', async (req, res) => {
  try {
    const { session_id, content, level = 'simple' } = req.body
    const limits = getPlanLimits(req.user)

    if (!limits.explainLevels.includes(level)) {
      return res.status(403).json({
        error: 'Level locked',
        code: 'UPGRADE_REQUIRED',
        message: 'Medium and Advanced explanations are Premium features. Upgrade for ₦500/month.',
      })
    }

    if (!content) return res.status(400).json({ error: 'No content provided' })

    const explanation = await grok.explainContent(content, level)
    await logUsage(req.user.id, session_id, 'explain')

    res.json({ explanation, level })

  } catch (err) {
    console.error('Explain error:', err)
    res.status(500).json({ error: 'AI error. Please try again.' })
  }
})

// ── POST /api/study/summary ──────────────────────────
router.post('/summary', premiumOnly, async (req, res) => {
  try {
    const { session_id, content, level = 'medium' } = req.body
    if (!content) return res.status(400).json({ error: 'No content provided' })

    const summary = await grok.summariseContent(content, level)
    await logUsage(req.user.id, session_id, 'summary')

    res.json({ summary })

  } catch (err) {
    console.error('Summary error:', err)
    res.status(500).json({ error: 'AI error. Please try again.' })
  }
})

// ── POST /api/study/quiz ─────────────────────────────
router.post('/quiz', async (req, res) => {
  try {
    const { session_id, content, level = 'medium', count = 10 } = req.body
    const limits = getPlanLimits(req.user)

    if (!content) return res.status(400).json({ error: 'No content provided' })

    const safeCount = Math.min(parseInt(count) || 10, limits.maxQuizQ)
    const questions = await grok.generateQuiz(content, level, safeCount)
    await logUsage(req.user.id, session_id, 'quiz')

    res.json({ questions, count: questions.length })

  } catch (err) {
    console.error('Quiz error:', err)
    res.status(500).json({ error: 'AI error. Please try again.' })
  }
})

// ── POST /api/study/quiz-result ──────────────────────
router.post('/quiz-result', async (req, res) => {
  try {
    const { session_id, score, total, level } = req.body

    await pool.query(
      'INSERT INTO quiz_results (user_id, session_id, score, total, level) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, session_id, score, total, level]
    )

    // Update avg quiz score in progress
    await pool.query(`
      UPDATE progress SET
        total_quizzes = total_quizzes + 1,
        avg_quiz_score = (
          SELECT COALESCE(AVG(score::numeric / NULLIF(total,0) * 100), 0)
          FROM quiz_results WHERE user_id = $1
        ),
        updated_at = NOW()
      WHERE user_id = $1
    `, [req.user.id])

    res.json({ message: 'Result saved' })
  } catch (err) {
    console.error('Quiz result error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/study/flashcards ───────────────────────
router.post('/flashcards', async (req, res) => {
  try {
    const { session_id, content, count = 12 } = req.body
    const limits = getPlanLimits(req.user)

    if (!content) return res.status(400).json({ error: 'No content provided' })

    const safeCount = Math.min(parseInt(count) || 12, limits.maxFlashcards)
    const cards = await grok.generateFlashcards(content, safeCount)
    await logUsage(req.user.id, session_id, 'flashcards')

    res.json({ cards, count: cards.length })

  } catch (err) {
    console.error('Flashcard error:', err)
    res.status(500).json({ error: 'AI error. Please try again.' })
  }
})

// ── POST /api/study/mindmap ──────────────────────────
router.post('/mindmap', premiumOnly, async (req, res) => {
  try {
    const { session_id, content } = req.body
    if (!content) return res.status(400).json({ error: 'No content provided' })

    const mindmap = await grok.generateMindmap(content)
    await logUsage(req.user.id, session_id, 'mindmap')

    res.json({ mindmap })

  } catch (err) {
    console.error('Mindmap error:', err)
    res.status(500).json({ error: 'AI error. Please try again.' })
  }
})

// ── POST /api/study/practice ─────────────────────────
router.post('/practice', premiumOnly, async (req, res) => {
  try {
    const { session_id, content, level = 'medium' } = req.body
    if (!content) return res.status(400).json({ error: 'No content provided' })

    const problems = await grok.generatePractice(content, level)
    await logUsage(req.user.id, session_id, 'practice')

    res.json({ problems })

  } catch (err) {
    console.error('Practice error:', err)
    res.status(500).json({ error: 'AI error. Please try again.' })
  }
})

// ── POST /api/study/chat ─────────────────────────────
router.post('/chat', premiumOnly, async (req, res) => {
  try {
    const { session_id, content, history = [], message } = req.body
    if (!message) return res.status(400).json({ error: 'No message provided' })
    if (!content) return res.status(400).json({ error: 'No content provided' })

    const reply = await grok.chatWithTutor(content, history, message)
    await logUsage(req.user.id, session_id, 'chat')

    res.json({ reply })

  } catch (err) {
    console.error('Chat error:', err)
    res.status(500).json({ error: 'AI error. Please try again.' })
  }
})

// ── GET /api/study/sessions ──────────────────────────
router.get('/sessions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, source_type, created_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    )
    res.json({ sessions: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/study/sessions/:id ──────────────────────
router.get('/sessions/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' })
    res.json({ session: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/study/sessions/:id ───────────────────
router.delete('/sessions/:id', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM sessions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    res.json({ message: 'Session deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})


// ── POST /api/study/voice ─────────────────────────────
router.post('/voice', authGuard, async (req, res) => {
  try {
    const { question, history = [] } = req.body

    // Check premium
    const { hasPremium } = require('../middleware/roleCheck')
    if (!hasPremium(req.user)) {
      return res.status(403).json({
        error: 'Premium feature',
        code: 'UPGRADE_REQUIRED',
        message: 'Voice Tutor requires Premium. Upgrade for ₦700/month.',
      })
    }

    if (!question?.trim()) return res.status(400).json({ error: 'No question provided' })

    const system = `You are a friendly and knowledgeable tutor. Answer student questions clearly and concisely. Keep answers under 100 words so they are easy to listen to. Use simple language. Do not use markdown, bullet points, or symbols — just plain conversational sentences.`

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: question },
    ]

    const answer = await grok.callGroq(messages, system, 200)
    await logUsage(req.user.id, null, 'voice')

    res.json({ answer })
  } catch (err) {
    console.error('Voice error:', err)
    res.status(500).json({ error: 'AI error. Please try again.' })
  }
})

module.exports = router
