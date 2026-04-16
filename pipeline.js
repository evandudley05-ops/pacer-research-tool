// pipeline.js — Core pipeline logic: source querying, deduplication, scoring
'use strict';

const { queryAllSources, chaseCitationsDOI, enrichWithUnpaywall } = require('./sources');
const { processPaper } = require('./scorer');
const { addPaper, getPapers } = require('./storage');
const { ALL_DOMAINS, getQueriesForDomain, getDomainLabel, getDomainMinPapers } = require('./searchStrings');

// ─── Seed DOIs ────────────────────────────────────────────────────────────────

const SEED_DOIS = [
  { doi: '10.1249/MSS.0000000000000852', description: 'ACSM Nutrition & Athletic Performance — Tier 2 Consensus' },
  { doi: '10.1136/bjsports-2023-106994', description: 'IOC RED-S Consensus Statement 2023 — Tier 2' },
  { doi: '10.1249/MSS.0b013e31802ca597', description: 'ACSM Fluid Replacement Position Stand — Tier 2' },
  { doi: '10.1249/MSS.0b013e31802fa199', description: 'Exertional Heat Illness — Tier 2' },
  { doi: '10.1136/bjsports-2018-099027', description: 'IOC Dietary Supplements Consensus — Tier 2' },
  { doi: '10.1123/ijsnem.2019-0065', description: 'IAAF Nutrition for Athletics — Tier 2' },
  { doi: '10.1123/IJSPP.2017-0208', description: 'Monitoring Athlete Training Loads — Tier 2' },
  { doi: '10.1136/bjsports-2016-096581', description: 'IOC Load & Injury Prevention — Tier 2' },
  { doi: '10.1113/jphysiol.2007.143834', description: 'Physiology of Endurance Champions — Tier 3' },
  { doi: '10.1097/00005768-200001000-00012', description: 'VO2max Determinants — Tier 3' },
  { doi: '10.1007/s40279-014-0148-z', description: 'Personalised CHO Intake During Exercise — Tier 3' },
  { doi: '10.1007/s40279-024-02018-z', description: 'Strength Training for Runners — Tier 3' },
  { doi: '10.1007/s40279-024-01993-7', description: 'Injury Prevention in Runners — Tier 3' },
];

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicateByDOI(papers) {
  const seen = new Map();
  for (const p of papers) {
    const key = p.doi ? p.doi.toLowerCase().trim() : null;
    if (key) {
      if (!seen.has(key)) seen.set(key, p);
      else {
        // Merge: prefer longer abstract
        const existing = seen.get(key);
        if ((p.abstract || '').length > (existing.abstract || '').length) {
          seen.set(key, { ...p, citation_count: Math.max(p.citation_count || 0, existing.citation_count || 0) });
        }
      }
    } else {
      // No DOI: use title-based dedup
      const titleKey = (p.title || '').toLowerCase().slice(0, 80);
      if (titleKey && !seen.has(`title:${titleKey}`)) {
        seen.set(`title:${titleKey}`, p);
      }
    }
  }
  return Array.from(seen.values());
}

// ─── Check if paper already processed ────────────────────────────────────────

function isAlreadyProcessed(doi, existingPapers) {
  if (!doi) return false;
  const normalized = doi.toLowerCase().trim();
  return existingPapers.some(p => p.doi && p.doi.toLowerCase().trim() === normalized);
}

// ─── Generate unique paper ID ─────────────────────────────────────────────────

function generatePaperId() {
  return `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Pipeline state ───────────────────────────────────────────────────────────

let pipelineRunning = false;
let pipelineAbort = false;

function isRunning() { return pipelineRunning; }
function stopPipeline() { pipelineAbort = true; }

// ─── Resolve seed DOIs via CrossRef ──────────────────────────────────────────

async function resolveSeedDOI(doi, log = () => {}) {
  try {
    const fetch = require('node-fetch');
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=research@pacer.app`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.message;
    if (!item) return null;
    const year = item.published?.['date-parts']?.[0]?.[0] || 0;
    return {
      doi: item.DOI || doi,
      title: Array.isArray(item.title) ? item.title[0] : item.title || '',
      authors: item.author?.map(a => `${a.given || ''} ${a.family || ''}`.trim()) || [],
      journal: Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'] || '',
      year,
      abstract: item.abstract?.replace(/<[^>]+>/g, '') || '',
      citation_count: item['is-referenced-by-count'] || 0,
      source: 'crossref_seed',
    };
  } catch (e) {
    log(`gray|Could not resolve seed DOI ${doi}: ${e.message}`);
    return null;
  }
}

// ─── Process seeds ────────────────────────────────────────────────────────────

async function processSeeds(apiKey, config, log = () => {}) {
  log(`mint|=== Processing ${SEED_DOIS.length} seed DOIs ===`);
  const existingPapers = getPapers();
  const results = [];

  for (const seed of SEED_DOIS) {
    if (pipelineAbort) break;

    if (isAlreadyProcessed(seed.doi, existingPapers)) {
      log(`gray|Seed already processed: ${seed.doi}`);
      continue;
    }

    log(`blue|Resolving seed DOI: ${seed.doi}`);
    const paper = await resolveSeedDOI(seed.doi, log);
    if (!paper) {
      log(`red|Could not resolve seed: ${seed.doi}`);
      continue;
    }

    log(`blue|Found seed: ${paper.title.slice(0, 80)} [${paper.year}]`);

    const processed = await processPaper(
      { ...paper, tier: 2, is_seed: true },
      apiKey,
      true, // isSeed = true, bypasses prescreen, ensures score >= 88
      log
    );

    processed.id = generatePaperId();
    processed.domain = 'seeds';
    processed.added_date = new Date().toISOString().slice(0, 10);

    addPaper(processed);
    results.push(processed);

    // Chase citations from seed via CrossRef
    const citations = await chaseCitationsDOI(seed.doi, log);
    log(`gray|Found ${citations.length} citation-adjacent papers for ${seed.doi}`);
    for (const cited of citations.slice(0, 5)) {
      if (!pipelineAbort && !isAlreadyProcessed(cited.doi, getPapers())) {
        const citedProcessed = await processPaper(cited, apiKey, false, log);
        citedProcessed.id = generatePaperId();
        citedProcessed.domain = 'seeds';
        citedProcessed.added_date = new Date().toISOString().slice(0, 10);
        addPaper(citedProcessed);
      }
    }
  }

  return results;
}

// ─── Run pipeline for selected domains ───────────────────────────────────────

async function runPipeline(selectedDomains, apiKey, config, sseLog = () => {}) {
  if (pipelineRunning) {
    sseLog(`gray|Pipeline already running`);
    return;
  }

  pipelineRunning = true;
  pipelineAbort = false;

  try {
    sseLog(`mint|=== Pacer Research Pipeline v4 Starting ===`);

    // Process seeds first
    await processSeeds(apiKey, config, sseLog);
    if (pipelineAbort) { sseLog(`amber|Pipeline stopped by user`); return; }

    // Process each selected domain
    for (const domainKey of selectedDomains) {
      if (pipelineAbort) break;

      const domainLabel = getDomainLabel(domainKey);
      const minPapers = getDomainMinPapers(domainKey);
      const queries = getQueriesForDomain(domainKey);

      sseLog(`mint|=== Domain: ${domainLabel} ===`);

      let domainApproved = 0;
      const existingForDomain = getPapers().filter(p => p.domain === domainKey && p.status === 'approved').length;
      domainApproved = existingForDomain;

      for (const query of queries) {
        if (pipelineAbort) break;

        if (minPapers > 0 && domainApproved >= minPapers) {
          sseLog(`mint|=== ${domainLabel}: ${domainApproved}/${minPapers} minimum reached ===`);
          break;
        }

        // Query all sources
        const rawResults = await queryAllSources(query, domainKey, config, sseLog);
        const deduped = deduplicateByDOI(rawResults);
        const existingPapers = getPapers();

        sseLog(`gray|Query "${query}" → ${rawResults.length} raw, ${deduped.length} after dedup`);

        // Filter out already-processed papers
        const newPapers = deduped.filter(p => !isAlreadyProcessed(p.doi, existingPapers) && p.title);

        sseLog(`gray|${newPapers.length} new papers to score for: ${query}`);

        for (const paper of newPapers) {
          if (pipelineAbort) break;

          sseLog(`blue|Found: ${(paper.title || 'Untitled').slice(0, 80)} [${paper.year || '?'}]`);

          // Enrich with Unpaywall OA data
          if (paper.doi) {
            const oa = await enrichWithUnpaywall(paper.doi, config.unpaywallEmail || 'research@pacer.app', sseLog);
            if (oa?.oaUrl) paper.oa_url = oa.oaUrl;
          }

          const processed = await processPaper(paper, apiKey, false, sseLog);
          processed.id = generatePaperId();
          processed.domain = domainKey;
          processed.tier = 3;
          processed.added_date = new Date().toISOString().slice(0, 10);

          addPaper(processed);

          if (processed.status === 'approved') {
            domainApproved++;
          }
        }

        // Small delay between queries to be polite to APIs
        await sleep(500);
      }

      // Run additional targeted queries if priority domain below minimum
      if (minPapers > 0 && domainApproved < minPapers && !pipelineAbort) {
        sseLog(`amber|${domainLabel} below minimum (${domainApproved}/${minPapers}) — running additional queries`);
        for (const query of queries) {
          if (pipelineAbort || domainApproved >= minPapers) break;
          const rawResults = await queryAllSources(`systematic review ${query}`, domainKey, config, sseLog);
          const deduped = deduplicateByDOI(rawResults);
          const existingPapers = getPapers();
          const newPapers = deduped.filter(p => !isAlreadyProcessed(p.doi, existingPapers) && p.title);
          for (const paper of newPapers) {
            if (pipelineAbort || domainApproved >= minPapers) break;
            const processed = await processPaper(paper, apiKey, false, sseLog);
            processed.id = generatePaperId();
            processed.domain = domainKey;
            processed.tier = 3;
            processed.added_date = new Date().toISOString().slice(0, 10);
            addPaper(processed);
            if (processed.status === 'approved') domainApproved++;
          }
          await sleep(500);
        }
      }

      sseLog(`mint|=== ${domainLabel} complete: ${domainApproved} approved papers ===`);
    }

    sseLog(`mint|=== Pipeline complete ===`);
  } catch (e) {
    sseLog(`red|Pipeline error: ${e.message}`);
  } finally {
    pipelineRunning = false;
    pipelineAbort = false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  SEED_DOIS,
  isRunning,
  stopPipeline,
  runPipeline,
  resolveSeedDOI,
  processSeeds,
};
