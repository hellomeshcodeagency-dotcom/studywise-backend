require('dotenv').config()
const express     = require('express')
const cors        = require('cors')
const rateLimit   = require('express-rate-limit')
const initDB      = require('./db/init')

const app = express()

// ── MIDDLEWARE ───────────────────────────────────────
app.use(cors({
  origin: [
    process.env.CLIENT_URL,
    'http://localhost:3000',
    'http://localhost:5173',
  ],
  credentials: true,
}))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests. Please wait a moment.' },
})
app.use('/api/', limiter)

// Stricter limit for AI endpoints
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many AI requests. Please slow down.' },
})
app.use('/api/study/explain',    aiLimiter)
app.use('/api/study/quiz',       aiLimiter)
app.use('/api/study/flashcards', aiLimiter)
app.use('/api/study/summary',    aiLimiter)
app.use('/api/study/mindmap',    aiLimiter)
app.use('/api/study/practice',   aiLimiter)
app.use('/api/study/chat',       aiLimiter)

// ── ROUTES ───────────────────────────────────────────
app.use('/api/auth',  require('./routes/auth'))
app.use('/api/study/plan', require('./routes/studyPlan'))
app.use('/api/study', require('./routes/study'))
app.use('/api/user',  require('./routes/user'))
app.use('/api/admin', require('./routes/admin'))

// ── HEALTH CHECK ─────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'StudyWise API',
    timestamp: new Date().toISOString(),
  })
})

// ── 404 ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// ── ERROR HANDLER ────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000

async function start() {
  try {
    await initDB()
    app.listen(PORT, () => {
      console.log(`🚀 StudyWise API running on port ${PORT}`)
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`)
      console.log(`   Client URL:  ${process.env.CLIENT_URL}`)
    })
  } catch (err) {
    console.error('Failed to start server:', err)
    process.exit(1)
  }
}

start()
