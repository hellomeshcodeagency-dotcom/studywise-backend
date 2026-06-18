// Only admin can access
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access only' })
  }
  next()
}

// Check if user has premium access (trial OR paid)
function hasPremium(user) {
  const now = new Date()

  // On active trial
  if (user.trial_ends_at && new Date(user.trial_ends_at) > now) return true

  // Paid premium still active
  if (user.plan === 'premium' && user.premium_until && new Date(user.premium_until) > now) return true

  return false
}

// Middleware: require premium
function premiumOnly(req, res, next) {
  if (!hasPremium(req.user)) {
    return res.status(403).json({
      error: 'Premium feature',
      code: 'UPGRADE_REQUIRED',
      message: 'Upgrade to premium for ₦700/month to access this feature.',
    })
  }
  next()
}

// Get plan limits for a user
function getPlanLimits(user) {
  const premium = hasPremium(user)
  return {
    isPremium:       premium,
    maxQuizQ:        premium ? 999 : 3,
    maxFlashcards:   premium ? 999 : 3,
    maxSessions:     premium ? 999 : 3,
    canUploadPDF:    premium,
    canUseURL:       premium,
    canUseSummary:   premium,
    canUseMindmap:   premium,
    canUseChat:      premium,
    canUsePractice:  premium,
    explainLevels:   premium ? ['simple','medium','advanced'] : ['simple'],
  }
}

module.exports = { adminOnly, premiumOnly, hasPremium, getPlanLimits }
