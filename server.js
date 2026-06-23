require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const express = require('express')
const cors = require('cors')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')
const nodemailer = require('nodemailer')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname)))

const APOLLO_BASE = 'https://api.apollo.io/api/v1'
const APOLLO_API_KEY = process.env.APOLLO_API_KEY

const LITS_API_URL = 'https://lits.litsystem.org/API/getItem.php'
const LITS_PUBLIC_KEY = process.env.LITS_PUBLIC_KEY
const LITS_PRIVATE_KEY = process.env.LITS_PRIVATE_KEY

const SPECIES_NAMES = {
  'WOK': 'White Oak', 'ROK': 'Red Oak', 'COK': 'Chestnut Oak',
  'POP': 'Poplar', 'PIN': 'Pine', 'CHE': 'Cherry',
  'HIC': 'Hickory', 'ASH': 'Ash', 'WAL': 'Walnut',
  'SMP': 'Soft Maple', 'HMP': 'Hard Maple', 'SOK': 'Scarlet Oak',
  'MXH': 'Mixed Hardwood',
}

// ── Supabase Admin Client ───────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const ALL_TABS = ['dashboard','inventory','orders','customers','quotes','shipping','outreach','website','settings','team']

// ── Auth Middleware ─────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No auth token' })
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Invalid token' })
    req.user = user
    next()
  } catch (e) {
    res.status(401).json({ error: 'Auth failed' })
  }
}

async function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No auth token' })
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Invalid token' })
    req.user = user
    const { data: member } = await supabase
      .from('kfp_team_members')
      .select('*')
      .eq('user_id', user.id)
      .single()
    if (!member || member.role !== 'admin' || member.status !== 'approved') {
      return res.status(403).json({ error: 'Admin access required' })
    }
    req.teamMember = member
    next()
  } catch (e) {
    res.status(403).json({ error: 'Admin check failed' })
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TEAM API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Get current user's team record (auto-provisions if first user)
app.get('/api/team/me', requireAuth, async (req, res) => {
  try {
    // Check if user already has a record
    let { data: member } = await supabase
      .from('kfp_team_members')
      .select('*')
      .eq('user_id', req.user.id)
      .single()

    if (!member) {
      // Auto-provision: check if first user
      const { count } = await supabase
        .from('kfp_team_members')
        .select('*', { count: 'exact', head: true })

      const isFirst = count === 0
      const { data: newMember, error } = await supabase
        .from('kfp_team_members')
        .insert({
          user_id: req.user.id,
          email: req.user.email,
          display_name: req.user.email.split('@')[0],
          role: isFirst ? 'admin' : 'member',
          status: isFirst ? 'approved' : 'pending',
          allowed_tabs: isFirst ? ALL_TABS : [],
          approved_at: isFirst ? new Date().toISOString() : null,
        })
        .select()
        .single()

      if (error) return res.status(500).json({ error: error.message })
      member = newMember
    }

    res.json({ member })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// List all team members (admin only)
app.get('/api/team', requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('kfp_team_members').select('*').order('created_at', { ascending: false })
    if (req.query.status) query = query.eq('status', req.query.status)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    res.json({ members: data })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Update a team member (admin only)
app.patch('/api/team/:id', requireAdmin, async (req, res) => {
  try {
    const updates = {}
    if (req.body.role !== undefined) updates.role = req.body.role
    if (req.body.status !== undefined) {
      updates.status = req.body.status
      if (req.body.status === 'approved') {
        updates.approved_by = req.user.id
        updates.approved_at = new Date().toISOString()
      }
    }
    if (req.body.allowed_tabs !== undefined) updates.allowed_tabs = req.body.allowed_tabs
    if (req.body.display_name !== undefined) updates.display_name = req.body.display_name

    const { data, error } = await supabase
      .from('kfp_team_members')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    res.json({ member: data })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Delete a team member (admin only)
app.delete('/api/team/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('kfp_team_members')
      .delete()
      .eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Apollo People Search ────────────────────────────────────────────────────
app.post('/api/apollo/search', async (req, res) => {
  if (!APOLLO_API_KEY) return res.status(500).json({ error: 'APOLLO_API_KEY not configured' })

  const body = { per_page: req.body.per_page || 25, page: req.body.page || 1 }

  if (req.body.person_titles?.length) body.person_titles = req.body.person_titles
  if (req.body.person_locations?.length) body.person_locations = req.body.person_locations
  if (req.body.person_seniorities?.length) body.person_seniorities = req.body.person_seniorities
  if (req.body.person_genders?.length) body.person_genders = req.body.person_genders
  if (req.body.person_departments?.length) body.person_departments = req.body.person_departments
  if (req.body.q_organization_domains?.length) body.q_organization_domains = req.body.q_organization_domains
  if (req.body.organization_locations?.length) body.organization_locations = req.body.organization_locations
  if (req.body.q_organization_keyword_tags?.length) body.q_organization_keyword_tags = req.body.q_organization_keyword_tags
  if (req.body.organization_num_employees_ranges?.length) body.organization_num_employees_ranges = req.body.organization_num_employees_ranges

  try {
    const r = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_API_KEY },
      body: JSON.stringify(body),
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Apollo API error' })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Apollo Bulk Enrich ──────────────────────────────────────────────────────
app.post('/api/apollo/enrich', async (req, res) => {
  if (!APOLLO_API_KEY) return res.status(500).json({ error: 'APOLLO_API_KEY not configured' })

  try {
    const r = await fetch(`${APOLLO_BASE}/people/bulk_match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_API_KEY },
      body: JSON.stringify({ details: req.body.ids.map(id => ({ id })), reveal_personal_emails: false }),
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Apollo enrich error' })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Apollo Single Enrich ────────────────────────────────────────────────────
app.post('/api/apollo/enrich-person', async (req, res) => {
  if (!APOLLO_API_KEY) return res.status(500).json({ error: 'APOLLO_API_KEY not configured' })

  try {
    const r = await fetch(`${APOLLO_BASE}/people/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_API_KEY },
      body: JSON.stringify(req.body),
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Apollo enrich error' })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── AI Email Composer ────────────────────────────────────────────────────────
app.post('/api/outreach/ai-compose', requireAuth, async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  const { prompt, stepCount = 1 } = req.body
  if (!prompt) return res.status(400).json({ error: 'prompt required' })

  const count = Math.min(Math.max(parseInt(stepCount) || 1, 1), 3)
  const system = `You are a B2B cold email copywriter for Kentucky Forest Products (KFP) — a family-owned sawmill, pole, and lumber company established in 1981 in Kentucky. Write professional, concise cold outreach emails for potential customers and partners. Keep emails under 150 words per step, conversational, and direct. You may use these variables: $first_name, $last_name, $company, $title, $city, $state. Return ONLY a JSON array of ${count} email step(s) in this exact format: [{"subject":"...","body":"..."}]. No markdown, no explanation — just the JSON array.`

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'AI generation failed' })

    let text = (data.content?.[0]?.text || '').trim().replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '')
    let steps
    try { steps = JSON.parse(text) } catch { return res.status(500).json({ error: 'Could not parse AI response as JSON' }) }
    res.json({ steps })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Leads Storage (in-memory for now, can be backed by SQLite/JSON file) ────
let leadsDB = []
let campaignsDB = []
let templatesDB = []
let nextLeadId = 1
let nextCampaignId = 1
let nextTemplateId = 1

// CRUD: Leads
app.get('/api/leads', (req, res) => {
  let filtered = [...leadsDB]
  if (req.query.status && req.query.status !== 'all') filtered = filtered.filter(l => l.status === req.query.status)
  if (req.query.campaign_id && req.query.campaign_id !== 'all') filtered = filtered.filter(l => l.campaign_id == req.query.campaign_id)
  if (req.query.q) {
    const q = req.query.q.toLowerCase()
    filtered = filtered.filter(l =>
      (l.email && l.email.toLowerCase().includes(q)) ||
      (l.first_name && l.first_name.toLowerCase().includes(q)) ||
      (l.last_name && l.last_name.toLowerCase().includes(q)) ||
      (l.company && l.company.toLowerCase().includes(q)) ||
      (l.title && l.title.toLowerCase().includes(q))
    )
  }
  res.json({ leads: filtered, total: filtered.length })
})

app.post('/api/leads', (req, res) => {
  const leads = Array.isArray(req.body) ? req.body : [req.body]
  const added = []
  for (const lead of leads) {
    const existing = leadsDB.find(l => l.email && l.email.toLowerCase() === (lead.email || '').toLowerCase())
    if (existing) continue
    const newLead = {
      id: nextLeadId++,
      email: lead.email || '',
      first_name: lead.first_name || '',
      last_name: lead.last_name || '',
      company: lead.company || '',
      title: lead.title || '',
      phone: lead.phone || '',
      city: lead.city || '',
      state: lead.state || '',
      linkedin_url: lead.linkedin_url || '',
      source: lead.source || 'manual',
      status: 'new',
      campaign_id: lead.campaign_id || null,
      sequence_step: null,
      created_at: new Date().toISOString(),
    }
    leadsDB.push(newLead)
    added.push(newLead)
  }
  res.json({ added: added.length, leads: added })
})

app.delete('/api/leads/:id', (req, res) => {
  const id = parseInt(req.params.id)
  leadsDB = leadsDB.filter(l => l.id !== id)
  res.json({ ok: true })
})

app.patch('/api/leads/:id', (req, res) => {
  const id = parseInt(req.params.id)
  const lead = leadsDB.find(l => l.id === id)
  if (!lead) return res.status(404).json({ error: 'Lead not found' })
  Object.assign(lead, req.body)
  res.json(lead)
})

app.post('/api/leads/bulk-delete', (req, res) => {
  const ids = new Set(req.body.ids.map(Number))
  leadsDB = leadsDB.filter(l => !ids.has(l.id))
  res.json({ ok: true, deleted: ids.size })
})

// CRUD: Campaigns
app.get('/api/campaigns', (req, res) => {
  const enriched = campaignsDB.map(c => ({
    ...c,
    lead_count: leadsDB.filter(l => l.campaign_id === c.id).length,
    leads_by_status: {
      new: leadsDB.filter(l => l.campaign_id === c.id && l.status === 'new').length,
      active: leadsDB.filter(l => l.campaign_id === c.id && l.status === 'active').length,
      replied: leadsDB.filter(l => l.campaign_id === c.id && l.status === 'replied').length,
      bounced: leadsDB.filter(l => l.campaign_id === c.id && l.status === 'bounced').length,
    },
  }))
  res.json({ campaigns: enriched })
})

app.post('/api/campaigns', (req, res) => {
  const campaign = {
    id: nextCampaignId++,
    name: req.body.name || 'Untitled Campaign',
    steps: req.body.steps || [],
    sender_email: req.body.sender_email || '',
    created_at: new Date().toISOString(),
  }
  campaignsDB.push(campaign)
  res.json(campaign)
})

app.delete('/api/campaigns/:id', (req, res) => {
  const id = parseInt(req.params.id)
  campaignsDB = campaignsDB.filter(c => c.id !== id)
  leadsDB = leadsDB.map(l => l.campaign_id === id ? { ...l, campaign_id: null } : l)
  res.json({ ok: true })
})

// CRUD: Templates
app.get('/api/templates', (req, res) => res.json({ templates: templatesDB }))

app.post('/api/templates', (req, res) => {
  const template = {
    id: nextTemplateId++,
    name: req.body.name || 'Untitled Template',
    steps: req.body.steps || [{ subject: '', body: '', delay: 0 }],
    created_at: new Date().toISOString(),
  }
  templatesDB.push(template)
  res.json(template)
})

app.put('/api/templates/:id', (req, res) => {
  const id = parseInt(req.params.id)
  const idx = templatesDB.findIndex(t => t.id === id)
  if (idx === -1) return res.status(404).json({ error: 'Template not found' })
  templatesDB[idx] = { ...templatesDB[idx], ...req.body }
  res.json(templatesDB[idx])
})

app.delete('/api/templates/:id', (req, res) => {
  const id = parseInt(req.params.id)
  templatesDB = templatesDB.filter(t => t.id !== id)
  res.json({ ok: true })
})

// ── Lits Inventory ──────────────────────────────────────────────────────────
app.get('/api/inventory', requireAuth, async (req, res) => {
  if (!LITS_PUBLIC_KEY || !LITS_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Lits API keys not configured' })
  }
  try {
    const r = await fetch(LITS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': LITS_PRIVATE_KEY,
        'X-API-PUBLIC-KEY': LITS_PUBLIC_KEY,
      },
      body: JSON.stringify({ module: 'logging', table: 'Logs - Active' }),
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.error || 'Lits API error' })

    // Aggregate by species
    const speciesMap = {}
    for (const log of (data.results || [])) {
      const code = log.Species || 'UNK'
      if (!speciesMap[code]) speciesMap[code] = { logs: 0, bf: 0, totalCost: 0 }
      speciesMap[code].logs += 1
      speciesMap[code].bf += (log['Board Feet'] || 0)
      speciesMap[code].totalCost += parseFloat(log['Log Cost'] || 0)
    }

    const categories = Object.entries(speciesMap)
      .sort((a, b) => b[1].bf - a[1].bf)
      .map(([code, stats], idx) => {
        const name = SPECIES_NAMES[code] || code
        const status = stats.bf < 1000 ? 'Out of Stock' : stats.bf < 20000 ? 'Low Stock' : 'In Stock'
        const statusColor = stats.bf < 1000 ? 'error' : stats.bf < 20000 ? 'tertiary' : 'primary'
        const costStr = stats.totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        return {
          id: idx + 1,
          name,
          code,
          status,
          statusColor,
          items: [
            { name: 'Log Count', qty: `${stats.logs.toLocaleString()} logs` },
            { name: 'Board Feet', qty: `${stats.bf.toLocaleString()} BF` },
            { name: 'Inventory Value', qty: `$${costStr}` },
          ],
        }
      })

    const totalBF = Object.values(speciesMap).reduce((s, v) => s + v.bf, 0)
    res.json({ categories, totalBF, logCount: data.count })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Stats
app.get('/api/stats', (req, res) => {
  res.json({
    total_leads: leadsDB.length,
    emails_sent: leadsDB.filter(l => l.status === 'active' || l.status === 'replied' || l.status === 'completed').length,
    reply_rate: leadsDB.length > 0 ? Math.round((leadsDB.filter(l => l.status === 'replied').length / Math.max(1, leadsDB.filter(l => l.status !== 'new').length)) * 100) : 0,
    bounce_rate: leadsDB.length > 0 ? Math.round((leadsDB.filter(l => l.status === 'bounced').length / Math.max(1, leadsDB.filter(l => l.status !== 'new').length)) * 100) : 0,
    campaigns: campaignsDB.length,
  })
})

// ── Invoice Email ────────────────────────────────────────────────────────────
app.post('/api/send-invoice', requireAuth, async (req, res) => {
  const { to, subject, invoiceHtml, invoiceNumber, senderName } = req.body
  if (!to || !invoiceHtml) return res.status(400).json({ error: 'Missing required fields' })

  const smtpUser = process.env.SMTP_USER
  const smtpPass = process.env.SMTP_PASS
  if (!smtpUser || !smtpPass) return res.status(500).json({ error: 'Email not configured. Add SMTP_USER and SMTP_PASS to environment variables.' })

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      auth: { user: smtpUser, pass: smtpPass },
      tls: { ciphers: 'SSLv3', rejectUnauthorized: false }
    })

    const fromAddress = `"${senderName || 'KFP Sawmill Operations'}" <${smtpUser}>`

    await transporter.sendMail({
      from: fromAddress,
      to,
      subject: subject || `Invoice ${invoiceNumber} from Kentucky Forest Products`,
      html: invoiceHtml,
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('Invoice send error:', err)
    res.status(500).json({ error: err.message || 'Failed to send invoice.' })
  }
})

// ── Contact Form ─────────────────────────────────────────────────────────────
const SALES_REPS = {
  lumber:         { name: 'Josh Lakes',     email: 'Josh.lakes@kyforest.com',    phone: '(606) 493-5526', specialty: 'Fencing, Lumber & Mulch' },
  fencing:        { name: 'Josh Lakes',     email: 'Josh.lakes@kyforest.com',    phone: '(606) 493-5526', specialty: 'Fencing, Lumber & Mulch' },
  mulch:          { name: 'Josh Lakes',     email: 'Josh.lakes@kyforest.com',    phone: '(606) 493-5526', specialty: 'Fencing, Lumber & Mulch' },
  matting:        { name: 'Ben Klingerman', email: 'Ben.klingeman@kyforest.com', phone: '(330) 247-8113', specialty: 'Utility Poles & Matting' },
  utility:        { name: 'Ben Klingerman', email: 'Ben.klingeman@kyforest.com', phone: '(330) 247-8113', specialty: 'Utility Poles & Matting' },
  'cross-ties':   { name: 'Tony Love',      email: 'tony.love@kyforest.com',     phone: '(606) 250-2220', specialty: 'Sales Manager' },
  general:        { name: 'Tony Love',      email: 'tony.love@kyforest.com',     phone: '(606) 250-2220', specialty: 'Sales Manager' },
}
const DEFAULT_REP = { name: 'Tony Love', email: 'tony.love@kyforest.com', phone: '(606) 250-2220', specialty: 'Sales Manager' }

const PRODUCT_LABELS = {
  lumber: 'Lumber', fencing: 'Fencing', mulch: 'Mulch / Byproducts',
  matting: 'Industrial Matting', utility: 'Utility Poles & Cross Arms',
  'cross-ties': 'Railroad Cross-Ties', general: 'General Inquiry',
}

app.post('/api/contact', async (req, res) => {
  const { name, email, phone, product, message } = req.body
  if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, and message are required.' })

  const smtpUser = process.env.SMTP_USER
  const smtpPass = process.env.SMTP_PASS
  if (!smtpUser || !smtpPass) return res.status(500).json({ error: 'Email not configured.' })

  const rep = SALES_REPS[product] || DEFAULT_REP
  const productLabel = PRODUCT_LABELS[product] || 'General Inquiry'

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#00450d;padding:24px 32px;border-radius:8px 8px 0 0;">
        <h2 style="color:white;margin:0;font-size:20px;">New Website Inquiry</h2>
        <p style="color:rgba(255,255,255,0.7);margin:6px 0 0;font-size:13px;">Kentucky Forest Products — kfp-website.com</p>
      </div>
      <div style="background:#f9f9f4;padding:32px;border:1px solid #e0e0d8;border-top:none;border-radius:0 0 8px 8px;">
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
          <tr><td style="padding:8px 0;color:#666;font-size:13px;width:140px;vertical-align:top;">Product Interest</td><td style="padding:8px 0;font-weight:700;color:#1a1a1a;">${productLabel}</td></tr>
          <tr><td style="padding:8px 0;color:#666;font-size:13px;vertical-align:top;">Name</td><td style="padding:8px 0;color:#1a1a1a;">${name}</td></tr>
          <tr><td style="padding:8px 0;color:#666;font-size:13px;vertical-align:top;">Email</td><td style="padding:8px 0;"><a href="mailto:${email}" style="color:#00450d;">${email}</a></td></tr>
          ${phone ? `<tr><td style="padding:8px 0;color:#666;font-size:13px;vertical-align:top;">Phone</td><td style="padding:8px 0;"><a href="tel:${phone.replace(/\D/g,'')}" style="color:#00450d;">${phone}</a></td></tr>` : ''}
        </table>
        <hr style="border:none;border-top:1px solid #e0e0d8;margin:0 0 20px;"/>
        <p style="color:#666;font-size:13px;margin:0 0 8px;font-weight:600;">Message</p>
        <p style="color:#1a1a1a;white-space:pre-wrap;margin:0;line-height:1.7;font-size:15px;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
        <hr style="border:none;border-top:1px solid #e0e0d8;margin:24px 0 16px;"/>
        <p style="color:#999;font-size:12px;margin:0;">Routed to <strong>${rep.name}</strong> (${rep.specialty}) · Reply directly to this email to respond to ${name}.</p>
      </div>
    </div>`

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.office365.com', port: 587, secure: false,
      auth: { user: smtpUser, pass: smtpPass },
      tls: { ciphers: 'SSLv3', rejectUnauthorized: false }
    })
    await transporter.sendMail({
      from: `"KFP Website" <${smtpUser}>`,
      to: rep.email,
      cc: smtpUser,
      replyTo: email,
      subject: `Website Inquiry: ${productLabel} — ${name}`,
      html,
    })
    res.json({ ok: true, rep: rep.name })
  } catch (err) {
    console.error('Contact form error:', err)
    res.status(500).json({ error: 'Failed to send. Please call us directly.' })
  }
})

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080
// Local dev: start server
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`KFP Server running on http://localhost:${PORT}`))
}

// Vercel serverless export
module.exports = app
