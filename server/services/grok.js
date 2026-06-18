const axios = require('axios')

const GROQ_BASE = 'https://api.groq.com/openai/v1'
const MODEL     = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'

async function callGroq(messages, systemPrompt = '', maxTokens = 1500) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages,
  }

  const res = await axios.post(`${GROQ_BASE}/chat/completions`, body, {
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
  })

  return res.data.choices[0].message.content
}

// ── EXPLAIN ─────────────────────────────────────────
async function explainContent(content, level) {
  const levelMap = {
    simple:   'very simple — explain like to a 12-year-old, use short sentences, plain words, relatable analogies. No jargon.',
    medium:   'student-level — well-structured with examples, key terms defined, good depth without being overwhelming.',
    advanced: 'expert-level — precise technical language, academic depth, nuanced analysis.',
  }
  const system = `You are an expert tutor. Explain content clearly and engagingly. Write in plain paragraphs — no markdown symbols, no bullet points, no headers.`
  const prompt = `Explain the following study material at a ${level} level (${levelMap[level]}):\n\n${content.slice(0, 8000)}`
  return callGroq([{ role: 'user', content: prompt }], system, 1200)
}

// ── SUMMARY ─────────────────────────────────────────
async function summariseContent(content, level) {
  const system = `You are an expert academic note-taker. Return ONLY valid JSON, no markdown fences, no extra text.
Schema: {"topic":"string","overview":"string","key_points":["string"],"sections":[{"title":"string","content":"string"}],"key_terms":[{"term":"string","definition":"string"}]}
key_points: 5-7 items. sections: 2-4 items. key_terms: 6-10 items.`
  const prompt = `Create structured study notes for level: ${level}\n\n${content.slice(0, 8000)}`
  const raw = await callGroq([{ role: 'user', content: prompt }], system, 1500)
  return JSON.parse(raw.replace(/```json|```/g, '').trim())
}

// ── QUIZ ────────────────────────────────────────────
async function generateQuiz(content, level, count = 10) {
  const system = `You are a quiz generator. Return ONLY valid JSON, no markdown fences.
Schema: {"questions":[{"q":"question text","options":["A. text","B. text","C. text","D. text"],"answer":"A","explanation":"why this is correct"}]}
Generate exactly ${count} questions at ${level} level. Mix difficulty. Answer field is just the letter.`
  const prompt = `Generate ${count} multiple-choice quiz questions from:\n\n${content.slice(0, 8000)}`
  const raw = await callGroq([{ role: 'user', content: prompt }], system, 1500)
  const data = JSON.parse(raw.replace(/```json|```/g, '').trim())
  return data.questions
}

// ── FLASHCARDS ───────────────────────────────────────
async function generateFlashcards(content, count = 12) {
  const system = `You are a flashcard creator. Return ONLY valid JSON, no markdown fences.
Schema: {"cards":[{"front":"term or question (concise)","back":"definition or answer (1-3 sentences)"}]}
Generate exactly ${count} cards covering key concepts, definitions, and important facts.`
  const prompt = `Create ${count} flashcards from:\n\n${content.slice(0, 8000)}`
  const raw = await callGroq([{ role: 'user', content: prompt }], system, 1200)
  const data = JSON.parse(raw.replace(/```json|```/g, '').trim())
  return data.cards
}

// ── MIND MAP ─────────────────────────────────────────
async function generateMindmap(content) {
  const system = `You are a concept mapping assistant. Return ONLY valid JSON, no markdown fences.
Schema: {"center":"Main Topic (max 4 words)","branches":[{"label":"Branch name (2-4 words)","children":["sub-concept","sub-concept"]}]}
Max 6 branches, max 3 children each. Keep labels short (2-5 words).`
  const prompt = `Extract key concepts for a mind map from:\n\n${content.slice(0, 6000)}`
  const raw = await callGroq([{ role: 'user', content: prompt }], system, 800)
  return JSON.parse(raw.replace(/```json|```/g, '').trim())
}

// ── PRACTICE PROBLEMS ────────────────────────────────
async function generatePractice(content, level) {
  const system = `You are a tutor creating practice problems. Return ONLY valid JSON, no markdown fences.
Schema: {"problems":[{"question":"string","hint":"string","solution":"string","difficulty":"easy|medium|hard"}]}
Generate 5 problems at ${level} level — mix of difficulties.`
  const prompt = `Create 5 practice problems from:\n\n${content.slice(0, 6000)}`
  const raw = await callGroq([{ role: 'user', content: prompt }], system, 1200)
  const data = JSON.parse(raw.replace(/```json|```/g, '').trim())
  return data.problems
}

// ── AI TUTOR CHAT ────────────────────────────────────
async function chatWithTutor(content, history, newMessage) {
  const system = `You are a helpful AI tutor. The student has uploaded study material. Answer questions clearly and helpfully based on the material. If asked something outside the material, help anyway but note it.
Study material context:\n${content.slice(0, 4000)}`

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: newMessage },
  ]

  return callGroq(messages, system, 800)
}

module.exports = {
  callGroq,
  explainContent,
  summariseContent,
  generateQuiz,
  generateFlashcards,
  generateMindmap,
  generatePractice,
  chatWithTutor,
}
