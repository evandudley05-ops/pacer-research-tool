// sources.js — All 9 academic source adapters
'use strict';

const fetch = require('node-fetch');
const xml2js = require('xml2js');

// ─── Utility ─────────────────────────────────────────────────────────────────

function makePaperRecord({ doi, title, authors, journal, year, abstract, source, pmid, citationCount, oaUrl } = {}) {
  return {
    doi: doi || '',
    title: title || '',
    authors: Array.isArray(authors) ? authors : (authors ? [authors] : []),
    journal: journal || '',
    year: year ? parseInt(year, 10) : 0,
    abstract: abstract || '',
    source: source || 'unknown',
    pmid: pmid || '',
    citation_count: citationCount || 0,
    oa_url: oaUrl || '',
  };
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

async function safeXml(str) {
  try { return await xml2js.parseStringPromise(str, { explicitArray: false }); } catch { return null; }
}

// ─── 1. PubMed / MEDLINE ─────────────────────────────────────────────────────

async function queryPubMed(query, maxResults = 20, log = () => {}) {
  const results = [];
  try {
    log(`gray|Querying PubMed: ${query}...`);
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json&sort=relevance`;
    const searchRes = await fetch(searchUrl, { timeout: 15000 });
    if (!searchRes.ok) { log(`gray|PubMed search failed: ${searchRes.status}`); return results; }
    const searchData = await safeJson(searchRes);
    const ids = searchData?.esearchresult?.idlist || [];
    if (!ids.length) return results;

    const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&retmode=xml`;
    const fetchRes = await fetch(fetchUrl, { timeout: 15000 });
    if (!fetchRes.ok) { log(`gray|PubMed fetch failed: ${fetchRes.status}`); return results; }
    const xmlText = await fetchRes.text();
    const parsed = await safeXml(xmlText);
    const articles = parsed?.PubmedArticleSet?.PubmedArticle;
    const list = Array.isArray(articles) ? articles : (articles ? [articles] : []);

    for (const art of list) {
      try {
        const med = art.MedlineCitation;
        const article = med.Article;
        const title = typeof article.ArticleTitle === 'string' ? article.ArticleTitle : article.ArticleTitle?._ || '';
        const abstract = article.Abstract?.AbstractText;
        const abstractText = typeof abstract === 'string' ? abstract : abstract?._ || (Array.isArray(abstract) ? abstract.map(a => a._ || a).join(' ') : '') || '';
        const journal = article.Journal?.Title || article.Journal?.ISOAbbreviation || '';
        const year = article.Journal?.JournalIssue?.PubDate?.Year || article.Journal?.JournalIssue?.PubDate?.MedlineDate?.slice(0, 4) || 0;
        const pmid = med.PMID?._ || med.PMID || '';
        const authorList = article.AuthorList?.Author;
        const authors = Array.isArray(authorList) ? authorList.map(a => `${a.LastName || ''} ${a.ForeName || a.Initials || ''}`.trim()).filter(Boolean) : [];
        const eidList = art.PubmedData?.ArticleIdList?.ArticleId;
        const eidArr = Array.isArray(eidList) ? eidList : (eidList ? [eidList] : []);
        const doi = eidArr.find(e => e.$?.IdType === 'doi')?._ || '';

        results.push(makePaperRecord({ doi, title, authors, journal, year, abstract: abstractText, source: 'pubmed', pmid }));
      } catch { /* skip malformed */ }
    }
    log(`gray|PubMed returned ${results.length} results for: ${query}`);
  } catch (e) {
    log(`gray|PubMed error: ${e.message}`);
  }
  return results;
}

// ─── 2. Europe PMC ───────────────────────────────────────────────────────────

async function queryEuropePMC(query, maxResults = 20, log = () => {}) {
  const results = [];
  try {
    log(`gray|Querying Europe PMC: ${query}...`);
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&resultType=core&pageSize=${maxResults}&format=json&sort=RELEVANCE`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) { log(`gray|Europe PMC failed: ${res.status}`); return results; }
    const data = await safeJson(res);
    const papers = data?.resultList?.result || [];
    for (const p of papers) {
      results.push(makePaperRecord({
        doi: p.doi || '',
        title: p.title || '',
        authors: p.authorList?.author?.map(a => a.fullName || `${a.lastName || ''} ${a.initials || ''}`.trim()) || [],
        journal: p.journalTitle || '',
        year: p.pubYear || 0,
        abstract: p.abstractText || '',
        source: 'europepmc',
        pmid: p.pmid || '',
        citationCount: p.citedByCount || 0,
      }));
    }
    log(`gray|Europe PMC returned ${results.length} results for: ${query}`);
  } catch (e) {
    log(`gray|Europe PMC error: ${e.message}`);
  }
  return results;
}

// ─── 3. Semantic Scholar ─────────────────────────────────────────────────────

async function querySemanticScholar(query, maxResults = 20, log = () => {}) {
  const results = [];
  try {
    log(`gray|Querying Semantic Scholar: ${query}...`);
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${maxResults}&fields=title,authors,year,externalIds,abstract,venue,citationCount,openAccessPdf`;
    const res = await fetch(url, { timeout: 15000, headers: { 'User-Agent': 'PacerResearchPipeline/4.0' } });
    if (!res.ok) { log(`gray|Semantic Scholar failed: ${res.status}`); return results; }
    const data = await safeJson(res);
    const papers = data?.data || [];
    for (const p of papers) {
      results.push(makePaperRecord({
        doi: p.externalIds?.DOI || '',
        title: p.title || '',
        authors: p.authors?.map(a => a.name) || [],
        journal: p.venue || '',
        year: p.year || 0,
        abstract: p.abstract || '',
        source: 'semantic_scholar',
        citationCount: p.citationCount || 0,
        oaUrl: p.openAccessPdf?.url || '',
      }));
    }
    log(`gray|Semantic Scholar returned ${results.length} results for: ${query}`);
  } catch (e) {
    log(`gray|Semantic Scholar error: ${e.message}`);
  }
  return results;
}

// ─── 4. CrossRef ─────────────────────────────────────────────────────────────

async function queryCrossRef(query, maxResults = 20, log = () => {}) {
  const results = [];
  try {
    log(`gray|Querying CrossRef: ${query}...`);
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${maxResults}&select=DOI,title,author,published,abstract,container-title,is-referenced-by-count&mailto=research@pacer.app`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) { log(`gray|CrossRef failed: ${res.status}`); return results; }
    const data = await safeJson(res);
    const items = data?.message?.items || [];
    for (const item of items) {
      const year = item.published?.['date-parts']?.[0]?.[0] || 0;
      const authors = item.author?.map(a => `${a.given || ''} ${a.family || ''}`.trim()) || [];
      results.push(makePaperRecord({
        doi: item.DOI || '',
        title: Array.isArray(item.title) ? item.title[0] : item.title || '',
        authors,
        journal: Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'] || '',
        year,
        abstract: item.abstract?.replace(/<[^>]+>/g, '') || '',
        source: 'crossref',
        citationCount: item['is-referenced-by-count'] || 0,
      }));
    }
    log(`gray|CrossRef returned ${results.length} results for: ${query}`);
  } catch (e) {
    log(`gray|CrossRef error: ${e.message}`);
  }
  return results;
}

// Chase citations from a seed DOI via CrossRef
async function chaseCitationsDOI(doi, log = () => {}) {
  const results = [];
  try {
    log(`gray|Chasing citations for DOI: ${doi}...`);
    const encodedDoi = encodeURIComponent(doi);
    const url = `https://api.crossref.org/works/${encodedDoi}?mailto=research@pacer.app`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) return results;
    const data = await safeJson(res);
    const item = data?.message;
    if (!item) return results;
    // Get papers that reference this DOI
    const refUrl = `https://api.crossref.org/works?filter=references:${encodedDoi}&rows=15&mailto=research@pacer.app`;
    const refRes = await fetch(refUrl, { timeout: 15000 });
    if (refRes.ok) {
      const refData = await safeJson(refRes);
      const refs = refData?.message?.items || [];
      for (const r of refs) {
        const year = r.published?.['date-parts']?.[0]?.[0] || 0;
        results.push(makePaperRecord({
          doi: r.DOI || '',
          title: Array.isArray(r.title) ? r.title[0] : r.title || '',
          authors: r.author?.map(a => `${a.given || ''} ${a.family || ''}`.trim()) || [],
          journal: Array.isArray(r['container-title']) ? r['container-title'][0] : r['container-title'] || '',
          year,
          abstract: r.abstract?.replace(/<[^>]+>/g, '') || '',
          source: 'crossref_citation',
          citationCount: r['is-referenced-by-count'] || 0,
        }));
      }
    }
    log(`gray|Citation chase yielded ${results.length} papers for DOI: ${doi}`);
  } catch (e) {
    log(`gray|Citation chase error: ${e.message}`);
  }
  return results;
}

// ─── 5. NIH NLM ──────────────────────────────────────────────────────────────

async function queryNIHNLM(query, maxResults = 20, log = () => {}) {
  const results = [];
  try {
    log(`gray|Querying NIH NLM: ${query}...`);
    // Use PubMed E-utilities targeting NLM datasets
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pmc&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) { log(`gray|NIH NLM failed: ${res.status}`); return results; }
    const data = await safeJson(res);
    const ids = data?.esearchresult?.idlist || [];
    if (!ids.length) return results;

    // Fetch summaries for PMC articles
    const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pmc&id=${ids.slice(0, 10).join(',')}&retmode=json`;
    const sumRes = await fetch(sumUrl, { timeout: 15000 });
    if (!sumRes.ok) return results;
    const sumData = await safeJson(sumRes);
    const uids = sumData?.result?.uids || [];
    for (const uid of uids) {
      const item = sumData.result[uid];
      if (!item) continue;
      results.push(makePaperRecord({
        doi: item.doi || '',
        title: item.title || '',
        authors: (item.authors || []).map(a => a.name || ''),
        journal: item.fulljournalname || item.source || '',
        year: item.pubdate ? parseInt(item.pubdate.slice(0, 4), 10) : 0,
        abstract: '',
        source: 'nih_nlm',
        pmid: item.pmid || '',
      }));
    }
    log(`gray|NIH NLM returned ${results.length} results for: ${query}`);
  } catch (e) {
    log(`gray|NIH NLM error: ${e.message}`);
  }
  return results;
}

// ─── 6. DOAJ ─────────────────────────────────────────────────────────────────

async function queryDOAJ(query, maxResults = 20, log = () => {}) {
  const results = [];
  try {
    log(`gray|Querying DOAJ: ${query}...`);
    const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?pageSize=${maxResults}&sort=relevance`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) { log(`gray|DOAJ failed: ${res.status}`); return results; }
    const data = await safeJson(res);
    const hits = data?.results || [];
    for (const h of hits) {
      const bib = h.bibjson || {};
      const doi = bib.identifier?.find(i => i.type === 'doi')?.id || '';
      const year = bib.year ? parseInt(bib.year, 10) : 0;
      const authors = bib.author?.map(a => `${a.name || ''}`.trim()) || [];
      const abstract = bib.abstract || '';
      results.push(makePaperRecord({
        doi,
        title: bib.title || '',
        authors,
        journal: bib.journal?.title || '',
        year,
        abstract,
        source: 'doaj',
      }));
    }
    log(`gray|DOAJ returned ${results.length} results for: ${query}`);
  } catch (e) {
    log(`gray|DOAJ error: ${e.message}`);
  }
  return results;
}

// ─── 7. Unpaywall ────────────────────────────────────────────────────────────

async function enrichWithUnpaywall(doi, email = 'research@pacer.app', log = () => {}) {
  try {
    if (!doi) return null;
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return null;
    const data = await safeJson(res);
    if (!data) return null;
    return {
      isOA: data.is_oa || false,
      oaUrl: data.best_oa_location?.url_for_pdf || data.best_oa_location?.url || '',
      oaStatus: data.oa_status || '',
    };
  } catch {
    return null;
  }
}

// ─── 8. SPORTDiscus (EBSCO EDS) ──────────────────────────────────────────────

async function querySPORTDiscus(query, ebscoKey, maxResults = 20, log = () => {}) {
  if (!ebscoKey) {
    log(`gray|SPORTDiscus skipped — no EBSCO API key provided`);
    return [];
  }
  const results = [];
  try {
    log(`gray|Querying SPORTDiscus (EBSCO): ${query}...`);
    // EBSCO EDS API endpoint
    const authUrl = 'https://eds-api.ebscohost.com/authservice/rest/UIDAuth';
    const authBody = JSON.stringify({ UserId: 'edsuser', Password: ebscoKey, InterfaceId: 'edsapi' });
    const authRes = await fetch(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: authBody,
      timeout: 10000,
    });
    if (!authRes.ok) { log(`gray|SPORTDiscus auth failed: ${authRes.status}`); return results; }
    const authData = await safeJson(authRes);
    const authToken = authData?.AuthToken;
    if (!authToken) { log(`gray|SPORTDiscus: no auth token received`); return results; }

    const sessionUrl = 'https://eds-api.ebscohost.com/edsapi/rest/CreateSession';
    const sessionRes = await fetch(sessionUrl, {
      method: 'GET',
      headers: { 'x-authenticationToken': authToken, 'x-sessionToken': '' },
      timeout: 10000,
    });
    if (!sessionRes.ok) { log(`gray|SPORTDiscus session failed`); return results; }
    const sessionData = await safeJson(sessionRes);
    const sessionToken = sessionData?.SessionToken;

    const searchUrl = `https://eds-api.ebscohost.com/edsapi/rest/Search?query=${encodeURIComponent(query)}&includefacets=n&resultsperpage=${maxResults}&pagenumber=1&databaseid=s3h`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'x-authenticationToken': authToken, 'x-sessionToken': sessionToken || '' },
      timeout: 15000,
    });
    if (!searchRes.ok) { log(`gray|SPORTDiscus search failed: ${searchRes.status}`); return results; }
    const searchData = await safeJson(searchRes);
    const records = searchData?.SearchResult?.Data?.Records || [];
    for (const r of records) {
      const items = r.Items || [];
      const getItem = (name) => items.find(i => i.Name === name)?.Data || '';
      results.push(makePaperRecord({
        doi: getItem('DOI'),
        title: getItem('Title'),
        authors: (getItem('Author') || '').split(';').map(a => a.trim()).filter(Boolean),
        journal: getItem('Source'),
        year: parseInt(getItem('PubDate') || '0', 10),
        abstract: getItem('Abstract'),
        source: 'sportdiscus',
      }));
    }
    log(`gray|SPORTDiscus returned ${results.length} results for: ${query}`);
  } catch (e) {
    log(`gray|SPORTDiscus error: ${e.message}`);
  }
  return results;
}

// ─── 9. Google Scholar via SerpAPI ───────────────────────────────────────────

async function queryGoogleScholar(query, serpApiKey, maxResults = 10, log = () => {}) {
  if (!serpApiKey) {
    log(`gray|Google Scholar skipped — no SerpAPI key provided`);
    return [];
  }
  const results = [];
  try {
    log(`gray|Querying Google Scholar (SerpAPI): ${query}...`);
    const url = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(query)}&num=${maxResults}&api_key=${serpApiKey}`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) { log(`gray|Google Scholar failed: ${res.status}`); return results; }
    const data = await safeJson(res);
    const items = data?.organic_results || [];
    for (const item of items) {
      const doi = (item.inline_links?.related_pages_link || '').match(/10\.\d{4,}\/[^\s&]+/)?.[0] || '';
      results.push(makePaperRecord({
        doi,
        title: item.title || '',
        authors: (item.publication_info?.authors || []).map(a => a.name || ''),
        journal: item.publication_info?.summary?.split(' - ')?.[1] || '',
        year: parseInt((item.publication_info?.summary || '').match(/\d{4}/)?.[0] || '0', 10),
        abstract: item.snippet || '',
        source: 'google_scholar',
        citationCount: item.inline_links?.cited_by?.total || 0,
      }));
    }
    log(`gray|Google Scholar returned ${results.length} results for: ${query}`);
  } catch (e) {
    log(`gray|Google Scholar error: ${e.message}`);
  }
  return results;
}

// ─── Query all sources in parallel ───────────────────────────────────────────

async function queryAllSources(query, domain, config, log = () => {}) {
  const { serpApiKey, ebscoKey } = config;
  const sourcePromises = [
    queryPubMed(query, 15, log),
    queryEuropePMC(query, 15, log),
    querySemanticScholar(query, 15, log),
    queryCrossRef(query, 15, log),
    queryNIHNLM(query, 10, log),
    queryDOAJ(query, 10, log),
    querySPORTDiscus(query, ebscoKey, 10, log),
    queryGoogleScholar(query, serpApiKey, 10, log),
  ];
  const settled = await Promise.allSettled(sourcePromises);
  const all = [];
  for (const result of settled) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      all.push(...result.value);
    }
  }
  return all;
}

module.exports = {
  queryPubMed,
  queryEuropePMC,
  querySemanticScholar,
  queryCrossRef,
  chaseCitationsDOI,
  queryNIHNLM,
  queryDOAJ,
  enrichWithUnpaywall,
  querySPORTDiscus,
  queryGoogleScholar,
  queryAllSources,
};
