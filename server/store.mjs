import { DatabaseSync } from 'node:sqlite';
import { rankConclusion } from './report-ranking.mjs';
import { compactReport } from './report.mjs';

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'ready', stage TEXT, error TEXT, result TEXT
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id),
      name TEXT NOT NULL, type TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE(case_id, hash)
    );
    CREATE TABLE IF NOT EXISTS passages (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
      locator TEXT NOT NULL, text TEXT NOT NULL, vector BLOB NOT NULL, model TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS originals (
      document_id TEXT PRIMARY KEY REFERENCES documents(id), content BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_progress (
      case_id TEXT NOT NULL REFERENCES cases(id), stage TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(case_id, stage)
    );
    CREATE TABLE IF NOT EXISTS case_overviews (
      case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS public_usage (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS documents_case ON documents(case_id);
    CREATE INDEX IF NOT EXISTS passages_document ON passages(document_id);
    UPDATE cases SET state = 'failed', error = 'The server restarted during this job. Retry the operation.'
      WHERE state IN ('indexing', 'analyzing', 'reporting');
  `);
  if (!db.prepare('PRAGMA table_info(cases)').all().some(({ name }) => name === 'owner')) {
    db.exec('ALTER TABLE cases ADD COLUMN owner TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS cases_owner ON cases(owner)');
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS passage_text USING fts5(id UNINDEXED, text);
      INSERT INTO passage_text SELECT id, text FROM passages WHERE id NOT IN (SELECT id FROM passage_text);`);
  } catch (error) {
    if (!error.message.includes('no such module: fts5')) throw error;
  }
  return db;
}

function hasFullText(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'passage_text'").get());
}

export function deleteCase(db, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT state FROM cases WHERE id = ?').get(id);
    if (!current || ['indexing', 'analyzing', 'reporting'].includes(current.state)) {
      db.exec('ROLLBACK');
      return current ? 'busy' : 'missing';
    }
    if (hasFullText(db)) {
      db.prepare(`DELETE FROM passage_text WHERE id IN (
        SELECT p.id FROM passages p JOIN documents d ON p.document_id = d.id WHERE d.case_id = ?
      )`).run(id);
    }
    db.prepare('DELETE FROM passages WHERE document_id IN (SELECT id FROM documents WHERE case_id = ?)').run(id);
    db.prepare('DELETE FROM originals WHERE document_id IN (SELECT id FROM documents WHERE case_id = ?)').run(id);
    db.prepare('DELETE FROM documents WHERE case_id = ?').run(id);
    db.prepare('DELETE FROM analysis_progress WHERE case_id = ?').run(id);
    db.prepare('DELETE FROM cases WHERE id = ?').run(id);
    db.exec('COMMIT');
    return 'deleted';
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function publicCase(db, id) {
  const current = db.prepare('SELECT id, name, created, state, stage, error, result FROM cases WHERE id = ?').get(id);
  if (!current) return null;
  const documents = db.prepare(`
    SELECT d.id, d.name, d.type, count(p.id) AS passages FROM documents d
    LEFT JOIN passages p ON p.document_id = d.id WHERE d.case_id = ? GROUP BY d.id ORDER BY d.rowid
  `).all(id);
  const result = current.result ? JSON.parse(current.result) : null;
  if (result) {
    result.rankedConclusion = rankConclusion(result.hypotheses);
    if (result.report) result.report = compactReport(result.report);
  }
  const canResume = Boolean(db.prepare('SELECT 1 FROM analysis_progress WHERE case_id = ? LIMIT 1').get(id));
  const error = /^Gemini returned HTTP 50[234] /.test(current.error || '')
    ? 'Gemini was temporarily unavailable. Run analysis again to continue.' : current.error;
  const overview = db.prepare('SELECT value FROM case_overviews WHERE case_id = ?').get(id);
  return { ...current, documents, result, canResume, error, overview: overview ? JSON.parse(overview.value) : null };
}

export async function analysisStep(db, caseId, stage, task) {
  const saved = db.prepare('SELECT value FROM analysis_progress WHERE case_id = ? AND stage = ?').get(caseId, stage);
  if (saved) return JSON.parse(saved.value);
  const value = await task();
  db.prepare('INSERT INTO analysis_progress VALUES (?, ?, ?)').run(caseId, stage, JSON.stringify(value));
  return value;
}

export function saveDocument(db, caseId, document, model) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('INSERT OR IGNORE INTO documents VALUES (?, ?, ?, ?, ?)')
      .run(document.id, caseId, document.name, document.type, document.hash);
    const { id } = db.prepare('SELECT id FROM documents WHERE case_id = ? AND hash = ?').get(caseId, document.hash);
    db.prepare('INSERT OR IGNORE INTO originals VALUES (?, ?)').run(id, document.content);
    if (row.changes) {
      const insert = db.prepare('INSERT INTO passages VALUES (?, ?, ?, ?, ?, ?)');
      const insertText = hasFullText(db) ? db.prepare('INSERT INTO passage_text VALUES (?, ?)') : null;
      for (const chunk of document.chunks) {
        insert.run(chunk.id, document.id, chunk.locator, chunk.text, Buffer.from(new Float32Array(chunk.vector).buffer), model);
        insertText?.run(chunk.id, chunk.text);
      }
      db.prepare('UPDATE cases SET result = NULL WHERE id = ?').run(caseId);
      db.prepare('DELETE FROM case_overviews WHERE case_id = ?').run(caseId);
      db.prepare('DELETE FROM analysis_progress WHERE case_id = ?').run(caseId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const publicFields = 'p.id, p.locator, p.text, d.name AS document, d.id AS documentId';

export function allPassages(db, caseId) {
  return db.prepare(`SELECT ${publicFields} FROM passages p JOIN documents d ON p.document_id = d.id
    WHERE d.case_id = ? ORDER BY d.rowid, p.rowid`).all(caseId);
}

const tokens = (text) => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
const commonTerms = new Set('a an the this that what who when where why how was were is are can did does do in on at to for of from with by and or it me show visible see find which'.split(' '));
export const asksAboutVisuals = (query) => /\b(?:photo|photograph|picture|image|visible|frame|screenshot)s?\b/i.test(query);

function filenameRanking(name, terms) {
  const fileTerms = new Set(tokens(name.replace(/\.[^.]+$/, '').replaceAll('_', ' ')));
  const matching = terms.filter((term) => fileTerms.has(term));
  return matching.length >= 2 || matching.some((term) => term.length >= 4 && !asksAboutVisuals(term)) ? matching.length : 0;
}

function keywordMatches(rows, terms) {
  const documents = rows.map((row) => {
    const words = tokens(row.text);
    const counts = new Map();
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
    return { id: row.id, length: words.length, counts };
  });
  const avgLength = documents.reduce((sum, row) => sum + row.length, 0) / documents.length || 1;
  const weights = terms.map((term) => {
    const frequency = documents.filter((row) => row.counts.has(term)).length;
    return Math.log1p((documents.length - frequency + 0.5) / (frequency + 0.5));
  });
  return documents.map(({ id, length, counts }) => ({
    id,
    score: terms.reduce((sum, term, index) => {
      const count = counts.get(term) || 0;
      return sum + weights[index] * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * length / avgLength));
    }, 0),
  })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, 40);
}

export function retrieve(db, caseId, query, vector, model, limit = 8) {
  const indexed = db.prepare(`SELECT ${publicFields}, p.vector FROM passages p
    JOIN documents d ON p.document_id = d.id WHERE d.case_id = ? AND p.model = ?`).all(caseId, model);
  const observed = new Set(indexed.filter((row) => row.locator === 'Visual observations').map((row) => row.documentId));
  const rows = indexed.filter((row) => !observed.has(row.documentId) || !/^no (?:legible |readable )?(?:textual content|text) (?:found|detected)\.?$/i.test(row.text.trim()));
  const semantic = rows.map(({ vector: bytes, ...source }) => {
    const values = new Float32Array(Uint8Array.from(bytes).buffer);
    const score = values.length === vector.length ? values.reduce((sum, value, i) => sum + value * vector[i], 0) : 0;
    return { ...source, score };
  }).sort((a, b) => b.score - a.score);
  const terms = [...new Set(tokens(query).filter((term) => !commonTerms.has(term)))].slice(0, 24);
  const filenameTerms = [...new Set(tokens(query.replaceAll('_', ' ')).filter((term) => !commonTerms.has(term)))];
  const lexical = terms.length && hasFullText(db) ? db.prepare(`SELECT p.id FROM passage_text
    JOIN passages p ON passage_text.id = p.id JOIN documents d ON p.document_id = d.id
    WHERE passage_text MATCH ? AND d.case_id = ? ORDER BY bm25(passage_text) LIMIT 40
  `).all(terms.map((term) => `"${term}"`).join(' OR '), caseId) : keywordMatches(rows, terms);
  const ranks = new Map(lexical.map(({ id }, index) => [id, index + 1]));
  const visual = asksAboutVisuals(query);
  return semantic.map(({ score, ...source }, index) => {
    const titleMatches = filenameRanking(source.document, filenameTerms);
    const visualBonus = visual && source.locator === 'Visual observations' ? 0.025 : 0;
    return {
      ...source,
      score: 1 / (61 + index) + (ranks.has(source.id) ? 1 / (60 + ranks.get(source.id)) : 0) +
        titleMatches * (visual ? 0.035 : 0.007) + visualBonus,
    };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function addImageObservation(db, caseId, documentId, passage, model) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM passages WHERE document_id = ? AND locator = ?').get(documentId, passage.locator)) {
      db.prepare('INSERT INTO passages VALUES (?, ?, ?, ?, ?, ?)')
        .run(passage.id, documentId, passage.locator, passage.text, Buffer.from(new Float32Array(passage.vector).buffer), model);
      if (hasFullText(db)) db.prepare('INSERT INTO passage_text VALUES (?, ?)').run(passage.id, passage.text);
      db.prepare('DELETE FROM analysis_progress WHERE case_id = ?').run(caseId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
