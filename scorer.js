// scorer.js — Two-stage Haiku pre-screen and scoring logic
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

let _client = null;

function getClient(apiKey) {
  if (!_client || _client._apiKey !== apiKey) {
    _client = new Anthropic({ apiKey });
    _client._apiKey = apiKey;
  }
  return _client;
}

// ─── Stage 1: Coach relevance pre-screen (binary gate) ───────────────────────

async function prescreenPaper(paper, apiKey, log = () => {}) {
  const client = getClient(apiKey);
  const title = paper.title || '';
  const abstract = paper.abstract || '';

  if (!title && !abstract) {
    return { passed: false, reason: 'no_content' };
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: 'You are a sports science librarian evaluating research for an AI endurance coaching platform.',
      messages: [{
        role: 'user',
        content: `Is this paper directly useful to a human endurance sports coach making training decisions for runners, cyclists, triathletes, or trail runners? Respond YES or NO only. No explanation. Auto-reject if the paper is: pure molecular biology with no applied angle, clinical pathology unrelated to performance, equipment engineering, animal studies only, nutrition biochemistry with no sport-specific application, or pediatric clinical medicine.

Title: ${title}
Abstract: ${abstract}`,
      }],
    });

    const text = (response.content[0]?.text || '').trim().toUpperCase();
    const passed = text.startsWith('YES');
    return { passed, reason: passed ? 'passed' : 'prescreen_rejected' };
  } catch (e) {
    log(`gray|Prescreen error for "${title.slice(0, 50)}": ${e.message}`);
    // On API error, pass through to avoid losing papers
    return { passed: true, reason: 'prescreen_error_pass' };
  }
}

// ─── Stage 2: Five-criteria scoring ──────────────────────────────────────────

async function scorePaper(paper, apiKey, log = () => {}) {
  const client = getClient(apiKey);
  const title = paper.title || '';
  const abstract = paper.abstract || '';
  const year = paper.year || 0;

  const FALLBACK_SCORE = {
    evidence_quality: 10,
    endurance_relevance: 10,
    coaching_actionability: 10,
    athlete_safety: 5,
    coaching_specificity: 10,
    total: 45,
    coaching_tags: ['endurance', 'research', 'performance'],
    one_line_summary: title.slice(0, 100),
    recency_bonus: false,
  };

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: 'You are a sports science librarian scoring research papers for an AI endurance coaching platform\'s knowledge base. Score each criterion 0-20. Respond ONLY with valid JSON.',
      messages: [{
        role: 'user',
        content: `Score this paper on 5 criteria (0-20 each, total 0-100):
1. EVIDENCE_QUALITY (0-20): Is this peer-reviewed? Is the methodology sound? Is it published in a respected journal?
2. ENDURANCE_RELEVANCE (0-20): How directly relevant is this to endurance sports (running, cycling, triathlon, trail running)?
3. COACHING_ACTIONABILITY (0-20): Can a coach use this to make specific training decisions? Practical > theoretical.
4. ATHLETE_SAFETY (0-20): Does this paper contain information relevant to preventing injury, illness, overtraining, or medical risk? If yes, score higher.
5. COACHING_SPECIFICITY (0-20): Does this describe how to structure training, not just physiology? Papers on "how to train VO2max" score higher than "what is VO2max".

Also provide: 3 coaching_tags (short phrases describing coaching utility), a one_line_summary for the review UI, and a recency_bonus: true if published 2020 or later.

Respond with ONLY this JSON structure, no other text:
{"evidence_quality":0,"endurance_relevance":0,"coaching_actionability":0,"athlete_safety":0,"coaching_specificity":0,"total":0,"coaching_tags":["","",""],"one_line_summary":"","recency_bonus":false}

Title: ${title}
Abstract: ${abstract}
Year: ${year}`,
      }],
    });

    const text = response.content[0]?.text || '';
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log(`gray|Score parse error for "${title.slice(0, 50)}" — using fallback`);
      return FALLBACK_SCORE;
    }

    const scores = JSON.parse(jsonMatch[0]);

    // Validate and clamp scores
    const criteria = ['evidence_quality', 'endurance_relevance', 'coaching_actionability', 'athlete_safety', 'coaching_specificity'];
    for (const c of criteria) {
      scores[c] = Math.max(0, Math.min(20, parseInt(scores[c], 10) || 0));
    }

    // Recalculate total from criteria
    scores.total = criteria.reduce((sum, c) => sum + scores[c], 0);

    // Apply recency bonus (+3 if 2020+, capped at 100)
    if (scores.recency_bonus && year >= 2020) {
      scores.total = Math.min(100, scores.total + 3);
      scores.recency_bonus_applied = true;
    } else {
      scores.recency_bonus_applied = false;
    }

    scores.coaching_tags = (scores.coaching_tags || []).slice(0, 3).map(t => String(t).slice(0, 50));
    scores.one_line_summary = String(scores.one_line_summary || '').slice(0, 200);

    return scores;
  } catch (e) {
    log(`gray|Scoring error for "${title.slice(0, 50)}": ${e.message}`);
    return FALLBACK_SCORE;
  }
}

// ─── Stage 3: Routing ─────────────────────────────────────────────────────────

function routePaper(score) {
  if (score >= 88) return 'approved';
  if (score >= 65) return 'review_queue';
  return 'rejected';
}

// ─── Full two-stage process ───────────────────────────────────────────────────

async function processPaper(paper, apiKey, isSeed = false, log = () => {}) {
  const title = paper.title || 'Untitled';

  // Stage 1: Pre-screen
  const prescreen = await prescreenPaper(paper, apiKey, log);
  if (!prescreen.passed && !isSeed) {
    log(`red|✗ REJECTED [prescreen] — ${title.slice(0, 80)}`);
    return { ...paper, status: 'rejected_prescreen', score: 0, score_breakdown: {} };
  }

  // Stage 2: Score
  const scores = await scorePaper(paper, apiKey, log);
  const finalScore = isSeed ? Math.max(scores.total, 88) : scores.total;

  // Stage 3: Route
  const status = isSeed ? 'approved' : routePaper(finalScore);

  const result = {
    ...paper,
    score: finalScore,
    score_breakdown: {
      evidence_quality: scores.evidence_quality,
      endurance_relevance: scores.endurance_relevance,
      coaching_actionability: scores.coaching_actionability,
      athlete_safety: scores.athlete_safety,
      coaching_specificity: scores.coaching_specificity,
    },
    coaching_tags: scores.coaching_tags || [],
    one_line_summary: scores.one_line_summary || '',
    recency_bonus_applied: scores.recency_bonus_applied || false,
    is_seed: isSeed,
    status,
  };

  if (status === 'approved') {
    log(`green|✓ AUTO-APPROVED [Score: ${finalScore}] — ${title.slice(0, 80)}`);
  } else if (status === 'review_queue') {
    log(`amber|⏳ REVIEW QUEUE [Score: ${finalScore}] — ${title.slice(0, 80)}`);
  } else {
    log(`red|✗ REJECTED [Score: ${finalScore}] — ${title.slice(0, 80)}`);
  }

  return result;
}

// ─── Test connection ──────────────────────────────────────────────────────────

async function testConnection(apiKey) {
  try {
    const client = getClient(apiKey);
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Reply OK' }],
    });
    return { success: true, message: 'Connection successful — Haiku responding' };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

module.exports = {
  prescreenPaper,
  scorePaper,
  routePaper,
  processPaper,
  testConnection,
};
