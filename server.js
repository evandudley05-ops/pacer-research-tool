// server.js — Express server, all API routes
'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const storage = require('./storage');
const pipeline = require('./pipeline');
const scorer = require('./scorer');
const { ALL_DOMAINS, getDomainLabel, getDomainMinPapers, getDomainKeys } = require('./searchStrings');

const app = express();
const PORT = 3333;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve index.html from project root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── SSE clients for progress log ────────────────────────────────────────────

const sseClients = new Set();

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

function sseLog(msg) {
  // Format: "color|message"
  const parts = msg.split('|');
  const color = parts.length > 1 ? parts[0] : 'gray';
  const text = parts.length > 1 ? parts.slice(1).join('|') : msg;
  broadcast({ type: 'log', color, text });
  console.log(`[${color}] ${text}`);
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial heartbeat
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ─── Config / API Keys ────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const config = storage.getConfig();
  // Never send secrets back in plaintext — send masked version
  const masked = { ...config };
  if (masked.anthropicKey) masked.anthropicKey = '••••••••' + masked.anthropicKey.slice(-4);
  if (masked.serpApiKey) masked.serpApiKey = '••••••••' + masked.serpApiKey.slice(-4);
  if (masked.ebscoKey) masked.ebscoKey = '••••••••' + masked.ebscoKey.slice(-4);
  masked.hasAnthropicKey = !!config.anthropicKey;
  masked.hasSerpApiKey = !!config.serpApiKey;
  masked.hasEbscoKey = !!config.ebscoKey;
  res.json(masked);
});

app.post('/api/config', (req, res) => {
  const existing = storage.getConfig();
  const { anthropicKey, serpApiKey, ebscoKey, unpaywallEmail } = req.body;
  const updated = { ...existing };
  // Only update if non-empty (don't overwrite with masked values)
  if (anthropicKey && !anthropicKey.includes('••')) updated.anthropicKey = anthropicKey;
  if (serpApiKey && !serpApiKey.includes('••')) updated.serpApiKey = serpApiKey;
  if (ebscoKey && !ebscoKey.includes('••')) updated.ebscoKey = ebscoKey;
  if (unpaywallEmail) updated.unpaywallEmail = unpaywallEmail;
  storage.saveConfig(updated);
  res.json({ success: true });
});

app.post('/api/test-connection', async (req, res) => {
  const config = storage.getConfig();
  if (!config.anthropicKey) return res.json({ success: false, message: 'No Anthropic API key saved' });
  const result = await scorer.testConnection(config.anthropicKey);
  res.json(result);
});

// ─── Seeds ────────────────────────────────────────────────────────────────────

app.get('/api/seeds', (req, res) => {
  const seeds = pipeline.SEED_DOIS;
  const papers = storage.getPapers();
  const withStatus = seeds.map(seed => {
    const found = papers.find(p => p.doi && p.doi.toLowerCase() === seed.doi.toLowerCase());
    return { ...seed, resolved: !!found, paper: found || null };
  });
  res.json(withStatus);
});

app.post('/api/seeds/resolve/:doi', async (req, res) => {
  const doi = decodeURIComponent(req.params.doi);
  const config = storage.getConfig();
  if (!config.anthropicKey) return res.status(400).json({ error: 'No Anthropic API key' });
  const paper = await pipeline.resolveSeedDOI(doi, sseLog);
  if (!paper) return res.status(404).json({ error: 'DOI not found' });
  res.json({ success: true, paper });
});

app.post('/api/seeds/add', async (req, res) => {
  const { doi } = req.body;
  if (!doi) return res.status(400).json({ error: 'DOI required' });
  const config = storage.getConfig();
  const paper = await pipeline.resolveSeedDOI(doi.trim(), sseLog);
  if (!paper) return res.status(404).json({ error: 'Could not resolve DOI' });
  const existing = storage.getPapers();
  if (existing.find(p => p.doi && p.doi.toLowerCase() === doi.toLowerCase())) {
    return res.json({ success: true, message: 'Already exists', paper });
  }
  const processed = {
    ...paper,
    id: `paper_${Date.now()}`,
    domain: 'seeds',
    tier: 2,
    is_seed: true,
    status: 'approved',
    score: 90,
    score_breakdown: {},
    coaching_tags: [],
    one_line_summary: paper.title,
    added_date: new Date().toISOString().slice(0, 10),
  };
  storage.addPaper(processed);
  res.json({ success: true, paper: processed });
});

// ─── Pipeline ─────────────────────────────────────────────────────────────────

app.get('/api/domains', (req, res) => {
  const domains = getDomainKeys().map(key => ({
    key,
    label: getDomainLabel(key),
    minPapers: getDomainMinPapers(key),
    isPriority: getDomainMinPapers(key) > 0,
  }));
  res.json(domains);
});

app.post('/api/pipeline/run', async (req, res) => {
  if (pipeline.isRunning()) {
    return res.status(400).json({ error: 'Pipeline already running' });
  }
  const { domains } = req.body;
  const config = storage.getConfig();
  if (!config.anthropicKey) return res.status(400).json({ error: 'No Anthropic API key configured' });

  const selectedDomains = Array.isArray(domains) && domains.length > 0 ? domains : getDomainKeys();

  res.json({ success: true, message: 'Pipeline started', domains: selectedDomains });

  // Run asynchronously
  setImmediate(() => {
    pipeline.runPipeline(selectedDomains, config.anthropicKey, config, sseLog)
      .then(() => broadcast({ type: 'pipeline_complete' }))
      .catch(e => { sseLog(`red|Pipeline error: ${e.message}`); broadcast({ type: 'pipeline_complete' }); });
  });
});

app.post('/api/pipeline/stop', (req, res) => {
  pipeline.stopPipeline();
  broadcast({ type: 'pipeline_stopped' });
  res.json({ success: true });
});

app.get('/api/pipeline/status', (req, res) => {
  res.json({ running: pipeline.isRunning() });
});

// ─── Papers ───────────────────────────────────────────────────────────────────

app.get('/api/papers', (req, res) => {
  const { status, domain } = req.query;
  let papers = storage.getPapers();
  if (status) papers = papers.filter(p => p.status === status);
  if (domain) papers = papers.filter(p => p.domain === domain);
  res.json(papers);
});

app.get('/api/papers/review-queue', (req, res) => {
  const queue = storage.getPapers().filter(p => p.status === 'review_queue');
  res.json(queue);
});

app.post('/api/papers/:id/approve', (req, res) => {
  const { id } = req.params;
  const updated = storage.updatePaperStatus(id, 'approved');
  if (!updated) return res.status(404).json({ error: 'Paper not found' });
  broadcast({ type: 'paper_reviewed', id, status: 'approved' });
  res.json({ success: true, paper: updated });
});

app.post('/api/papers/:id/reject', (req, res) => {
  const { id } = req.params;
  const { note } = req.body;
  const updated = storage.updatePaperStatus(id, 'rejected', note);
  if (!updated) return res.status(404).json({ error: 'Paper not found' });
  broadcast({ type: 'paper_reviewed', id, status: 'rejected' });
  res.json({ success: true, paper: updated });
});

app.get('/api/stats', (req, res) => {
  res.json(storage.getStats());
});

// ─── Library ──────────────────────────────────────────────────────────────────

app.get('/api/library', (req, res) => {
  res.json(storage.getLibrary());
});

app.post('/api/library', (req, res) => {
  const entry = req.body;
  if (!entry.id) entry.id = `lib_${Date.now()}`;
  if (!entry.added_date) entry.added_date = new Date().toISOString().slice(0, 10);
  if (!entry.status) entry.status = 'approved';
  storage.addLibraryEntry(entry);
  res.json({ success: true, entry });
});

app.put('/api/library/:id', (req, res) => {
  const entry = { ...req.body, id: req.params.id };
  storage.addLibraryEntry(entry);
  res.json({ success: true, entry });
});

app.delete('/api/library/:id', (req, res) => {
  storage.deleteLibraryEntry(req.params.id);
  res.json({ success: true });
});

// ─── Export ───────────────────────────────────────────────────────────────────

app.get('/api/export', (req, res) => {
  const papers = storage.getPapers().filter(p => p.status === 'approved');
  const library = storage.getLibrary();
  const coverage = storage.getCoverage();
  const date = new Date().toISOString().slice(0, 10);

  const exportData = {
    export_date: date,
    version: '4',
    total_papers: papers.length,
    total_library_entries: library.length,
    coverage,
    papers: papers.map((p, i) => ({
      id: p.id || `paper_${String(i + 1).padStart(3, '0')}`,
      doi: p.doi || '',
      title: p.title || '',
      authors: p.authors || [],
      journal: p.journal || '',
      year: p.year || 0,
      abstract: p.abstract || '',
      citation_count: p.citation_count || 0,
      score: p.score || 0,
      score_breakdown: p.score_breakdown || {},
      coaching_tags: p.coaching_tags || [],
      one_line_summary: p.one_line_summary || '',
      tier: p.tier || 3,
      domain: p.domain || '',
      status: p.status || 'approved',
      is_seed: p.is_seed || false,
      recency_bonus_applied: p.recency_bonus_applied || false,
      source: p.source || '',
      oa_url: p.oa_url || '',
    })),
    library_entries: library,
  };

  const filename = `pacer_database_${date}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(exportData);
});

app.get('/api/coverage', (req, res) => {
  const coverage = storage.getCoverage();
  const domains = getDomainKeys().map(key => ({
    key,
    label: getDomainLabel(key),
    minPapers: getDomainMinPapers(key),
    count: coverage[key] || 0,
  }));
  res.json(domains);
});

// ─── Start server ─────────────────────────────────────────────────────────────

storage.ensureDataDir();

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  Pacer Research Pipeline v4            ║`);
  console.log(`║  Running at http://localhost:${PORT}    ║`);
  console.log(`╚════════════════════════════════════════╝\n`);
});
