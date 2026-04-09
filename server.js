const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Load config
let config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// Ensure data directory
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

// Pipeline state
let state = {
  status: 'idle',
  stage: 0,
  progress: { current: 0, total: 0, stage_label: '' },
  stats: { discovered: 0, hard_filtered: 0, ai_scored: 0, auto_approved: 0, review_queue: 0, auto_rejected: 0 },
  log: [],
  last_run: null,
  report_text: null
};

// Load saved state if exists
const stateFile = path.join(__dirname, 'data', 'state.json');
if (fs.existsSync(stateFile)) {
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}
}

// Category search queries
const CATEGORY_QUERIES = {
  endurance: {
    pubmed: '("training intensity distribution" OR "polarized training" OR "periodization" OR "training load" OR "aerobic threshold") AND (endurance OR running OR cycling OR triathlon)',
    semantic: 'polarized training endurance performance zone 2'
  },
  biomechanics: {
    pubmed: '("running economy" OR "running biomechanics" OR "cadence" OR "foot strike" OR "ground contact time" OR "gait analysis") AND (running OR endurance OR performance)',
    semantic: 'running economy biomechanics stride gait'
  },
  nutrition: {
    pubmed: '("carbohydrate periodization" OR "protein requirements" OR "race fueling" OR "energy availability" OR "gut training") AND (endurance OR athlete OR performance)',
    semantic: 'sports nutrition endurance athlete carbohydrate protein'
  },
  recovery: {
    pubmed: '("heart rate variability" OR "HRV" OR "overtraining syndrome" OR "sleep athletic performance" OR "recovery monitoring") AND (athlete OR training OR endurance)',
    semantic: 'HRV recovery training load athlete sleep'
  },
  vo2max: {
    pubmed: '("VO2max" OR "maximal oxygen uptake" OR "lactate threshold" OR "critical power" OR "ventilatory threshold") AND (training OR endurance OR running OR performance)',
    semantic: 'VO2max training improvement lactate threshold'
  },
  strength: {
    pubmed: '("concurrent training" OR "strength training" OR "plyometric" OR "resistance training endurance") AND (running OR cycling OR endurance OR "running economy")',
    semantic: 'strength training endurance running economy concurrent'
  },
  mental: {
    pubmed: '("self-efficacy" OR "attentional focus" OR "pain tolerance" OR "psychological skills" OR "motivation") AND (sport OR athlete OR exercise OR endurance)',
    semantic: 'psychology endurance sport motivation self-efficacy'
  },
  'body-comp': {
    pubmed: '("body composition" OR "racing weight" OR "relative energy deficiency" OR "RED-S") AND (athlete OR endurance OR running)',
    semantic: 'body composition endurance athlete performance weight'
  },
  environmental: {
    pubmed: '("heat acclimatization" OR "altitude training" OR "heat stress exercise") AND (endurance OR performance OR athlete)',
    semantic: 'heat altitude environmental physiology endurance exercise'
  },
  populations: {
    pubmed: '("masters athlete" OR "female athlete physiology" OR "youth athlete" OR "sex differences exercise") AND (endurance OR training OR performance)',
    semantic: 'masters female youth athlete endurance training'
  }
};

// Helpers
function addLog(message, type = 'info') {
  state.log.push({ time: new Date().toISOString(), message, type });
  if (state.log.length > 200) state.log = state.log.slice(-200);
  saveState();
}

function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function checkPaused() {
  if (state.status === 'idle') throw new Error('Pipeline cancelled');
  while (state.status === 'paused') {
    await new Promise(r => setTimeout(r, 500));
    // Re-read state in case resume was called
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state.status = s.status;
    } catch (e) {}
    if (state.status === 'idle') throw new Error('Pipeline cancelled');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeDoi(doi) {
  if (!doi) return null;
  return String(doi).toLowerCase().trim().replace(/^https?:\/\/doi\.org\//, '');
}

function normalizeTitle(title) {
  if (!title) return '';
  return String(title).toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function titleOverlap(a, b) {
  const wordsA = new Set(normalizeTitle(a).split(/\s+/));
  const wordsB = new Set(normalizeTitle(b).split(/\s+/));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// Fetch PubMed papers for a category
async function fetchPubMed(category, query) {
  const papers = [];
  try {
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${config.papers_per_category}&retmode=json&datetype=pdat&mindate=1990&maxdate=2025`;
    const searchRes = await axios.get(searchUrl, { timeout: 30000 });
    const ids = searchRes.data.esearchresult?.idlist || [];
    if (ids.length === 0) return papers;

    // Fetch in batches of 20
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      try {
        const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${batch.join(',')}&rettype=abstract&retmode=xml`;
        const fetchRes = await axios.get(fetchUrl, { timeout: 30000 });
        const parsed = await xml2js.parseStringPromise(fetchRes.data, { explicitArray: false });
        let articles = parsed?.PubmedArticleSet?.PubmedArticle;
        if (!articles) continue;
        if (!Array.isArray(articles)) articles = [articles];

        for (const art of articles) {
          try {
            const mc = art.MedlineCitation;
            const article = mc?.Article;
            if (!article) continue;

            const title = typeof article.ArticleTitle === 'string' ? article.ArticleTitle : (article.ArticleTitle?._ || JSON.stringify(article.ArticleTitle) || '');

            // Authors
            let authors = '';
            const authorList = article.AuthorList?.Author;
            if (authorList) {
              const auths = Array.isArray(authorList) ? authorList : [authorList];
              const names = auths.slice(0, 3).map(a => `${a.LastName || ''} ${a.Initials || ''}`.trim()).filter(Boolean);
              authors = names.join(', ');
              if (auths.length > 3) authors += ' et al.';
            }

            // Year
            const pubDate = article.Journal?.JournalIssue?.PubDate;
            let year = pubDate?.Year || (pubDate?.MedlineDate ? pubDate.MedlineDate.substring(0, 4) : null);

            // Journal
            const journal = article.Journal?.Title || '';

            // Abstract
            let abstract = '';
            const absText = article.Abstract?.AbstractText;
            if (absText) {
              if (typeof absText === 'string') abstract = absText;
              else if (Array.isArray(absText)) abstract = absText.map(a => (typeof a === 'string' ? a : a._ || '')).join(' ');
              else abstract = absText._ || String(absText);
            }

            // DOI
            let doi = null;
            const articleIds = article.ELocationID;
            if (articleIds) {
              const idArr = Array.isArray(articleIds) ? articleIds : [articleIds];
              for (const eid of idArr) {
                if (eid.$ && eid.$.EIdType === 'doi') { doi = eid._ || eid; break; }
              }
            }
            if (!doi) {
              const pmArticleIds = mc?.PMID;
              // Try ArticleIdList from PubmedData
              const pubmedData = art.PubmedData;
              if (pubmedData?.ArticleIdList?.ArticleId) {
                const aids = Array.isArray(pubmedData.ArticleIdList.ArticleId) ? pubmedData.ArticleIdList.ArticleId : [pubmedData.ArticleIdList.ArticleId];
                for (const aid of aids) {
                  if (aid.$ && aid.$.IdType === 'doi') { doi = aid._ || aid; break; }
                }
              }
            }

            // Pub types
            let pub_types = [];
            const ptList = article.PublicationTypeList?.PublicationType;
            if (ptList) {
              const pts = Array.isArray(ptList) ? ptList : [ptList];
              pub_types = pts.map(p => (typeof p === 'string' ? p : p._ || String(p)));
            }

            // PMID
            const pmid = typeof mc.PMID === 'string' ? mc.PMID : mc.PMID?._ || '';

            papers.push({
              title, authors, year, journal, abstract, doi: normalizeDoi(doi),
              pub_types, pmid, source: 'pubmed', category
            });
          } catch (e) { /* skip individual article parse errors */ }
        }
      } catch (e) { /* skip batch errors */ }
      await sleep(300);
    }
  } catch (e) {
    addLog(`PubMed error for ${category}: ${e.message}`, 'warn');
  }
  return papers;
}

// Fetch Europe PMC papers
async function fetchEuropePMC(category, query) {
  const papers = [];
  try {
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}+AND+OPEN_ACCESS:y&format=json&resulttype=core&pageSize=50&sort=CITED+desc`;
    const res = await axios.get(url, { timeout: 30000 });
    const results = res.data?.resultList?.result || [];
    for (const r of results) {
      papers.push({
        title: r.title || '',
        authors: r.authorString || '',
        year: r.pubYear || null,
        journal: r.journalTitle || '',
        abstract: r.abstractText || '',
        doi: normalizeDoi(r.doi),
        pub_types: [],
        pmid: r.pmid || r.id || '',
        source: 'europepmc',
        open_access: true,
        category
      });
    }
  } catch (e) {
    addLog(`Europe PMC error for ${category}: ${e.message}`, 'warn');
  }
  return papers;
}

// Fetch Semantic Scholar papers
async function fetchSemanticScholar(category, query) {
  const papers = [];
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,authors,year,journal,abstract,externalIds,citationCount,publicationTypes&limit=30`;
    const res = await axios.get(url, { timeout: 30000 });
    const results = res.data?.data || [];
    for (const r of results) {
      const authorNames = (r.authors || []).slice(0, 3).map(a => a.name).filter(Boolean);
      let authors = authorNames.join(', ');
      if ((r.authors || []).length > 3) authors += ' et al.';
      papers.push({
        title: r.title || '',
        authors,
        year: r.year || null,
        journal: r.journal?.name || '',
        abstract: r.abstract || '',
        doi: normalizeDoi(r.externalIds?.DOI),
        pub_types: r.publicationTypes || [],
        pmid: r.externalIds?.PubMed || '',
        citationCount: r.citationCount || 0,
        source: 'semantic_scholar',
        category
      });
    }
  } catch (e) {
    addLog(`Semantic Scholar error for ${category}: ${e.message}`, 'warn');
  }
  return papers;
}

// Deduplicate papers
function deduplicatePapers(papers) {
  const byDoi = new Map();
  const noDoi = [];

  for (const p of papers) {
    if (p.doi) {
      const existing = byDoi.get(p.doi);
      if (!existing || (p.abstract || '').length > (existing.abstract || '').length) {
        byDoi.set(p.doi, p);
      }
    } else {
      noDoi.push(p);
    }
  }

  const result = [...byDoi.values()];
  const resultTitles = result.map(p => normalizeTitle(p.title));

  for (const p of noDoi) {
    const nt = normalizeTitle(p.title);
    let isDup = false;
    for (const rt of resultTitles) {
      if (titleOverlap(nt, rt) > 0.8) { isDup = true; break; }
    }
    if (!isDup) {
      result.push(p);
      resultTitles.push(nt);
    }
  }

  return result;
}

// Hard filters
function applyHardFilters(papers) {
  const kept = [];
  const rejected = [];
  const reasons = {};

  for (const p of papers) {
    let reason = null;

    if (!p.doi) reason = 'no_doi';
    else if (p.year && parseInt(p.year) < 1990) reason = 'too_old';
    else {
      const badTypes = ['Case Report','Letter','Editorial','Comment','News','Congress','Retracted Publication','Published Erratum'];
      if (p.pub_types && p.pub_types.some(t => badTypes.includes(typeof t === 'string' ? t : t._ || ''))) reason = 'bad_pub_type';
    }

    if (!reason) {
      const text = ((p.title || '') + ' ' + (p.abstract || '')).toLowerCase();
      const nonHuman = ['in vitro',' rat ',' rats ',' mouse ',' mice ',' rodent ','animal model','cell culture','in vivo rat'];
      if (nonHuman.some(k => text.includes(k))) reason = 'non_human';
    }

    if (!reason) {
      const text = ((p.title || '') + ' ' + (p.abstract || '')).toLowerCase();
      if (p.category !== 'populations' && (text.includes('pediatric') || text.includes('children') || text.includes(' adolescent '))) {
        reason = 'wrong_population';
      }
    }

    if (!reason) {
      if (!p.abstract || p.abstract.split(' ').length < 60) reason = 'thin_abstract';
    }

    if (reason) {
      p.rejection_reason = reason;
      rejected.push(p);
      reasons[reason] = (reasons[reason] || 0) + 1;
    } else {
      kept.push(p);
    }
  }

  return { kept, rejected, reasons };
}

// AI scoring
async function scorePaper(paper) {
  const prompt = `Score this sports science paper for a recreational endurance athlete coaching database.
Paper: '${paper.title}' by ${paper.authors} (${paper.year}) in ${paper.journal}
Category: ${paper.category}
Abstract: ${(paper.abstract || '').substring(0, 500)}

Score each dimension 1-10. Overall score 0-100.
methodology: 10=meta-analysis/systematic review, 8=RCT, 6=cohort, 4=cross-sectional, 2=case-report
applicability: 10=recreational athletes studied, 7=mixed/transferable, 4=elite only limited transfer, 1=no athlete relevance
recency: 10=2022+, 8=2017-2021, 6=2010-2016, 4=2000-2009, 2=pre-2000
citation_weight: 10=landmark 500+, 8=well-cited 100-499, 6=established 20-99, 4=emerging <20
relevance: 10=directly informs Pacer coaching decisions, 7=strong background, 5=useful context, 2=tangential
conflict: true if contradicts mainstream consensus
band: approve if overall>=85, reject if overall<50, else review

Return ONLY this JSON, no other text:
{"methodology":0,"applicability":0,"recency":0,"citation_weight":0,"relevance":0,"overall":0,"band":"review","conflict":false,"flag":null,"rationale":"one sentence"}`;

  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropic_api_key,
        'anthropic-version': '2023-06-01'
      },
      timeout: 30000
    });

    const text = res.data.content[0].text.trim();
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const scores = JSON.parse(jsonMatch[0]);
    return scores;
  } catch (e) {
    return {
      methodology: 5, applicability: 5, recency: 5,
      citation_weight: 5, relevance: 5, overall: 55,
      band: 'review', conflict: false,
      flag: 'AI scoring failed — manual review required',
      rationale: `Scoring error: ${e.message}`
    };
  }
}

// Main pipeline
async function runPipeline(categories) {
  state.status = 'running';
  state.stage = 1;
  state.stats = { discovered: 0, hard_filtered: 0, ai_scored: 0, auto_approved: 0, review_queue: 0, auto_rejected: 0 };
  state.log = [];
  state.report_text = null;
  saveState();

  const sourceCounts = { pubmed: 0, europepmc: 0, semantic_scholar: 0 };
  let allPapers = [];

  try {
    // STAGE 1 — DISCOVERY
    state.stage = 1;
    state.progress = { current: 0, total: categories.length, stage_label: 'Stage 1: Discovering papers...' };
    addLog('Stage 1: Starting paper discovery...', 'info');

    // Process categories in batches of 3
    for (let i = 0; i < categories.length; i += 3) {
      await checkPaused();
      const batch = categories.slice(i, i + 3);
      const results = await Promise.allSettled(batch.map(async (cat) => {
        const queries = CATEGORY_QUERIES[cat];
        if (!queries) { addLog(`Unknown category: ${cat}`, 'warn'); return []; }

        addLog(`Searching ${cat}...`, 'info');
        const [pubmed, epmc, ss] = await Promise.all([
          fetchPubMed(cat, queries.pubmed),
          fetchEuropePMC(cat, queries.pubmed),
          fetchSemanticScholar(cat, queries.semantic)
        ]);

        // Wait for Semantic Scholar rate limit
        await sleep(1200);

        addLog(`${cat}: PubMed=${pubmed.length}, EuropePMC=${epmc.length}, SemanticScholar=${ss.length}`, 'info');
        sourceCounts.pubmed += pubmed.length;
        sourceCounts.europepmc += epmc.length;
        sourceCounts.semantic_scholar += ss.length;

        return [...pubmed, ...epmc, ...ss];
      }));

      for (const r of results) {
        if (r.status === 'fulfilled') allPapers.push(...r.value);
      }

      state.progress.current = Math.min(i + 3, categories.length);
      saveState();
    }

    // Deduplicate
    allPapers = deduplicatePapers(allPapers);

    // Assign IDs
    const catCounters = {};
    for (const p of allPapers) {
      catCounters[p.category] = (catCounters[p.category] || 0) + 1;
      p.id = `${p.category}-${catCounters[p.category]}`;
      p.status = 'pending';
      p.skip_count = 0;
    }

    state.stats.discovered = allPapers.length;
    addLog(`Stage 1 complete: ${allPapers.length} unique papers discovered`, 'success');
    saveState();

    // STAGE 2 — HARD FILTERS
    state.stage = 2;
    state.progress = { current: 0, total: allPapers.length, stage_label: 'Stage 2: Applying hard filters...' };
    addLog('Stage 2: Applying hard filters...', 'info');

    const { kept, rejected, reasons } = applyHardFilters(allPapers);

    state.stats.hard_filtered = rejected.length;
    const reasonStr = Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(', ');
    addLog(`Stage 2: ${kept.length} passed, ${rejected.length} rejected (${reasonStr})`, 'info');
    state.progress = { current: allPapers.length, total: allPapers.length, stage_label: 'Stage 2: Filtering complete' };
    saveState();

    // STAGE 3 — AI SCORING
    state.stage = 3;
    state.progress = { current: 0, total: kept.length, stage_label: 'Stage 3: AI scoring papers...' };
    addLog(`Stage 3: AI scoring ${kept.length} papers...`, 'info');

    if (!config.anthropic_api_key) {
      addLog('No API key configured — all papers sent to manual review', 'warn');
      for (const p of kept) {
        p.scores = { methodology: 5, applicability: 5, recency: 5, citation_weight: 5, relevance: 5, overall: 55, band: 'review', conflict: false, flag: 'No API key — manual review required', rationale: '' };
        p.status = 'pending';
      }
      state.stats.ai_scored = kept.length;
      state.stats.review_queue = kept.length;
    } else {
      const autoApproved = [];
      const reviewQueue = [];
      const autoRejected = [];
      let scoringFailures = 0;

      for (let i = 0; i < kept.length; i += 5) {
        await checkPaused();
        const batch = kept.slice(i, i + 5);

        for (const paper of batch) {
          const scores = await scorePaper(paper);
          paper.scores = scores;

          if (scores.flag && scores.flag.includes('failed')) scoringFailures++;

          if (scores.overall >= config.auto_approve_threshold) {
            paper.status = 'approved';
            autoApproved.push(paper);
          } else if (scores.overall < config.auto_reject_threshold) {
            paper.status = 'rejected';
            autoRejected.push(paper);
          } else {
            paper.status = 'pending';
            reviewQueue.push(paper);
          }
        }

        state.progress.current = Math.min(i + 5, kept.length);
        state.stats.ai_scored = state.progress.current;
        state.stats.auto_approved = autoApproved.length;
        state.stats.review_queue = reviewQueue.length;
        state.stats.auto_rejected = autoRejected.length;

        if ((i + 5) % 10 === 0 || i + 5 >= kept.length) saveState();
        if ((i + 5) % 25 === 0 || i + 5 >= kept.length) {
          addLog(`Scored ${Math.min(i + 5, kept.length)}/${kept.length}: approved=${autoApproved.length} review=${reviewQueue.length} rejected=${autoRejected.length}`, 'info');
        }

        if (i + 5 < kept.length) await sleep(1000);
      }

      state.stats.scoring_failures = scoringFailures;

      // STAGE 4 — SAVE
      state.stage = 4;
      state.progress = { current: 0, total: 1, stage_label: 'Stage 4: Saving results...' };
      addLog('Stage 4: Saving results...', 'info');

      // Sort review queue by category then score DESC
      reviewQueue.sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return (b.scores?.overall || 0) - (a.scores?.overall || 0);
      });

      fs.writeFileSync(path.join(__dirname, 'data', 'review_queue.json'), JSON.stringify(reviewQueue, null, 2));
      fs.writeFileSync(path.join(__dirname, 'data', 'auto_approved.json'), JSON.stringify(autoApproved, null, 2));
      fs.writeFileSync(path.join(__dirname, 'data', 'auto_rejected.json'), JSON.stringify(autoRejected, null, 2));

      // Generate report
      const now = new Date().toISOString();
      const reviewMinutes = reviewQueue.length * 2;
      const reviewHours = Math.floor(reviewMinutes / 60);
      const reviewMins = reviewMinutes % 60;
      const sessions = Math.ceil(reviewMinutes / 60);

      const catCounts = {};
      for (const p of reviewQueue) { catCounts[p.category] = (catCounts[p.category] || 0) + 1; }

      const report = `PACER RESEARCH PIPELINE REPORT
================================
Run completed: ${now}
Categories run: ${categories.join(', ')}

DISCOVERY
PubMed: ${sourceCounts.pubmed} | Europe PMC: ${sourceCounts.europepmc} | Semantic Scholar: ${sourceCounts.semantic_scholar}
After deduplication: ${allPapers.length} unique papers

FILTERING
Hard filter rejections: ${rejected.length} (${reasonStr})
Remaining after filters: ${kept.length}

AI SCORING
Auto-approved (score >=${config.auto_approve_threshold}): ${autoApproved.length} papers
Human review queue (${config.auto_reject_threshold}-${config.auto_approve_threshold - 1}): ${reviewQueue.length} papers
Auto-rejected (score <${config.auto_reject_threshold}): ${autoRejected.length} papers
Scoring failures: ${scoringFailures}

REVIEW QUEUE BY CATEGORY
${Object.entries(catCounts).map(([c, n]) => `${c}: ${n} papers`).join('\n')}

ESTIMATED REVIEW TIME
${reviewQueue.length} papers x 2 min = ${reviewHours}h ${reviewMins}m
Suggested: ${sessions} sessions of ~1 hour`;

      fs.writeFileSync(path.join(__dirname, 'data', 'pipeline_report.txt'), report);
      state.report_text = report;
      state.progress = { current: 1, total: 1, stage_label: 'Stage 4: Complete' };
    }

    state.status = 'complete';
    state.last_run = new Date().toISOString();
    saveState();
    addLog('Pipeline complete!', 'success');

  } catch (e) {
    if (e.message === 'Pipeline cancelled') {
      addLog('Pipeline cancelled.', 'warn');
      state.status = 'idle';
    } else {
      addLog(`Pipeline error: ${e.message}`, 'error');
      state.status = 'idle';
    }
    saveState();
  }
}

// ─── ROUTES ─────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.post('/api/config', (req, res) => {
  config = { ...config, ...req.body };
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  res.json(state);
});

app.post('/api/pipeline/start', (req, res) => {
  if (state.status === 'running') return res.status(400).json({ error: 'Pipeline already running' });
  const categories = req.body.categories || config.categories;
  res.json({ ok: true });
  setImmediate(() => runPipeline(categories));
});

app.post('/api/pipeline/pause', (req, res) => {
  state.status = 'paused';
  saveState();
  addLog('Pipeline paused', 'warn');
  res.json({ ok: true });
});

app.post('/api/pipeline/resume', (req, res) => {
  state.status = 'running';
  saveState();
  addLog('Pipeline resumed', 'info');
  res.json({ ok: true });
});

app.post('/api/pipeline/reset', (req, res) => {
  state = {
    status: 'idle', stage: 0,
    progress: { current: 0, total: 0, stage_label: '' },
    stats: { discovered: 0, hard_filtered: 0, ai_scored: 0, auto_approved: 0, review_queue: 0, auto_rejected: 0 },
    log: [], last_run: null, report_text: null
  };
  saveState();
  const files = ['review_queue.json', 'auto_approved.json', 'auto_rejected.json', 'pipeline_report.txt'];
  for (const f of files) {
    const fp = path.join(__dirname, 'data', f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  res.json({ ok: true });
});

app.get('/api/papers/review', (req, res) => {
  const fp = path.join(__dirname, 'data', 'review_queue.json');
  if (!fs.existsSync(fp)) return res.json([]);
  let papers = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (req.query.category) papers = papers.filter(p => p.category === req.query.category);
  if (req.query.status) papers = papers.filter(p => p.status === req.query.status);
  res.json(papers);
});

app.post('/api/papers/:id/decide', (req, res) => {
  const fp = path.join(__dirname, 'data', 'review_queue.json');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'No review queue' });
  const papers = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const paper = papers.find(p => p.id === req.params.id);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  paper.status = req.body.status;
  fs.writeFileSync(fp, JSON.stringify(papers, null, 2));
  res.json({ ok: true });
});

app.post('/api/papers/:id/undo', (req, res) => {
  const fp = path.join(__dirname, 'data', 'review_queue.json');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'No review queue' });
  const papers = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const paper = papers.find(p => p.id === req.params.id);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  paper.status = 'pending';
  fs.writeFileSync(fp, JSON.stringify(papers, null, 2));
  res.json({ ok: true });
});

app.get('/api/export', (req, res) => {
  let approved = [];

  const aaFile = path.join(__dirname, 'data', 'auto_approved.json');
  if (fs.existsSync(aaFile)) approved.push(...JSON.parse(fs.readFileSync(aaFile, 'utf8')));

  const rqFile = path.join(__dirname, 'data', 'review_queue.json');
  if (fs.existsSync(rqFile)) {
    const rq = JSON.parse(fs.readFileSync(rqFile, 'utf8'));
    approved.push(...rq.filter(p => p.status === 'approved'));
  }

  // Deduplicate by DOI
  const seen = new Set();
  approved = approved.filter(p => {
    if (!p.doi) return true;
    if (seen.has(p.doi)) return false;
    seen.add(p.doi);
    return true;
  });

  const date = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Disposition', `attachment; filename=pacer_database_${date}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.json(approved);
});

app.get('/api/stats', (req, res) => {
  const stats = { total_papers: 0, by_category: {}, by_status: { approved: 0, rejected: 0, later: 0, pending: 0 }, review_progress_pct: 0, estimated_minutes_remaining: 0 };

  const rqFile = path.join(__dirname, 'data', 'review_queue.json');
  if (fs.existsSync(rqFile)) {
    const papers = JSON.parse(fs.readFileSync(rqFile, 'utf8'));
    stats.total_papers = papers.length;
    for (const p of papers) {
      stats.by_category[p.category] = (stats.by_category[p.category] || 0) + 1;
      stats.by_status[p.status] = (stats.by_status[p.status] || 0) + 1;
    }
    const decided = stats.by_status.approved + stats.by_status.rejected + stats.by_status.later;
    stats.review_progress_pct = stats.total_papers > 0 ? Math.round((decided / stats.total_papers) * 100) : 0;
    stats.estimated_minutes_remaining = stats.by_status.pending * 2;
  }

  const aaFile = path.join(__dirname, 'data', 'auto_approved.json');
  if (fs.existsSync(aaFile)) {
    const aa = JSON.parse(fs.readFileSync(aaFile, 'utf8'));
    stats.by_status.approved += aa.length;
    stats.total_papers += aa.length;
  }

  res.json(stats);
});

// Start server
const PORT = 3333;
app.listen(PORT, () => {
  console.log(`Pacer Research Tool running at http://localhost:${PORT}`);
});
