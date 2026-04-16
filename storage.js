// storage.js — Local JSON read/write helpers
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function filePath(name) {
  return path.join(DATA_DIR, name);
}

function readJSON(name, defaultValue = []) {
  ensureDataDir();
  const fp = filePath(name);
  if (!fs.existsSync(fp)) return defaultValue;
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[storage] Failed to read ${name}:`, e.message);
    return defaultValue;
  }
}

function writeJSON(name, data) {
  ensureDataDir();
  const fp = filePath(name);
  try {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error(`[storage] Failed to write ${name}:`, e.message);
    return false;
  }
}

// Papers database
function getPapers() {
  return readJSON('papers.json', []);
}

function savePapers(papers) {
  return writeJSON('papers.json', papers);
}

function addPaper(paper) {
  const papers = getPapers();
  const existing = papers.findIndex(p => p.doi && paper.doi && p.doi === paper.doi);
  if (existing >= 0) {
    papers[existing] = { ...papers[existing], ...paper };
  } else {
    papers.push(paper);
  }
  return savePapers(papers);
}

function updatePaperStatus(id, status, note = '') {
  const papers = getPapers();
  const idx = papers.findIndex(p => p.id === id);
  if (idx >= 0) {
    papers[idx].status = status;
    if (note) papers[idx].review_note = note;
    papers[idx].reviewed_at = new Date().toISOString();
    savePapers(papers);
    return papers[idx];
  }
  return null;
}

// Library
function getLibrary() {
  return readJSON('library.json', []);
}

function saveLibrary(entries) {
  return writeJSON('library.json', entries);
}

function addLibraryEntry(entry) {
  const lib = getLibrary();
  const existing = lib.findIndex(e => e.id === entry.id);
  if (existing >= 0) {
    lib[existing] = entry;
  } else {
    lib.push(entry);
  }
  return saveLibrary(lib);
}

function deleteLibraryEntry(id) {
  const lib = getLibrary().filter(e => e.id !== id);
  return saveLibrary(lib);
}

// Config (API keys, settings)
function getConfig() {
  ensureDataDir();
  const fp = path.join(__dirname, 'data', 'config.json');
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveConfig(config) {
  ensureDataDir();
  const fp = path.join(__dirname, 'data', 'config.json');
  fs.writeFileSync(fp, JSON.stringify(config, null, 2), 'utf8');
}

// Stats helpers
function getStats() {
  const papers = getPapers();
  const library = getLibrary();
  return {
    total: papers.length,
    approved: papers.filter(p => p.status === 'approved').length,
    review_queue: papers.filter(p => p.status === 'review_queue').length,
    rejected: papers.filter(p => p.status === 'rejected' || p.status === 'rejected_prescreen').length,
    library_entries: library.length,
  };
}

// Coverage by domain (approved papers only)
function getCoverage() {
  const papers = getPapers().filter(p => p.status === 'approved');
  const coverage = {};
  for (const p of papers) {
    if (p.domain) {
      coverage[p.domain] = (coverage[p.domain] || 0) + 1;
    }
  }
  return coverage;
}

module.exports = {
  ensureDataDir,
  readJSON,
  writeJSON,
  getPapers,
  savePapers,
  addPaper,
  updatePaperStatus,
  getLibrary,
  saveLibrary,
  addLibraryEntry,
  deleteLibraryEntry,
  getConfig,
  saveConfig,
  getStats,
  getCoverage,
};
