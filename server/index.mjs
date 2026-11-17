import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configured, embed, isTemporaryModelError, models, provider } from './models.mjs';
import { extractDocument, inspectImage, validateFile, visualLocator } from './ingestion.mjs';
import { addImageObservation, allPassages, asksAboutVisuals, deleteCase, openStore, publicCase, retrieve, saveDocument } from './store.mjs';
import { answerFromEvidence, describeCase, investigate } from './investigation.mjs';
import { followEvidenceLinks } from './graph-retrieval.mjs';
import { runCaseEvidenceTools } from './evidence-tools.mjs';
import { exportInvestigationReport, writeInvestigationReport } from './report.mjs';
import { describePreview, imageTypes, renderPdfPage } from './document-preview.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'frontend/dist');
const publicMode = process.env.TD_PUBLIC_MODE === '1';
const publicOrigin = publicMode ? new URL(process.env.TD_PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL) : null;
const publicDailyLimit = Number(process.env.TD_PUBLIC_DAILY_LIMIT || 60);
if (publicOrigin && (publicOrigin.protocol !== 'https:' || !process.env.TD_DATA_DIR)) {
  throw new Error('Public mode requires an HTTPS origin and a dedicated TD_DATA_DIR.');
}
if (publicMode && (!Number.isSafeInteger(publicDailyLimit) || publicDailyLimit < 1)) {
  throw new Error('TD_PUBLIC_DAILY_LIMIT must be a positive integer.');
}
const data = resolve(process.env.TD_DATA_DIR || resolve(root, 'storage/agent-workspace'));
await mkdir(data, { recursive: true });
const database = resolve(data, 'workspace.sqlite3');
const db = openStore(database);
const visualJobs = new Map();
const overviewJobs = new Map();
const port = Number(process.env.PORT || process.env.TD_PORT || 8001);
const maxUpload = (publicMode ? 8 : 48) * 1024 * 1024;
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function usePublicCapacity() {
  if (!publicMode) return;
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const minute = now.slice(0, 16);
  db.prepare('DELETE FROM public_usage WHERE bucket NOT IN (?, ?)').run(day, minute);
  const usage = db.prepare('SELECT count FROM public_usage WHERE bucket = ?');
  if ((usage.get(day)?.count ?? 0) >= publicDailyLimit || (usage.get(minute)?.count ?? 0) >= 6) {
    throw new HttpError(429, 'The public demo is busy or has reached its usage limit. Try again later.');
  }
  const increment = db.prepare(`INSERT INTO public_usage VALUES (?, 1)
    ON CONFLICT(bucket) DO UPDATE SET count = count + 1`);
  increment.run(day);
  increment.run(minute);
}

function ownsCase(id, owner) {
  return db.prepare('SELECT 1 FROM cases WHERE id = ? AND owner IS ?').get(id, owner);
}

async function parseBody(req, max, format) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'The upload or request exceeds the size limit.');
    chunks.push(chunk);
  }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] || '' } })[format]();
  } catch {
    throw new HttpError(400, 'The request body could not be read.');
  }
}

const reportStage = 'Report agent is writing the final investigation report';

function begin(id, state, task) {
  const start = db.prepare(`UPDATE cases SET state = ?, stage = ?, error = NULL
    WHERE id = ? AND state NOT IN ('indexing', 'analyzing', 'reporting')`).run(state, 'Starting', id);
  if (!start.changes) throw new HttpError(409, 'This case already has a job in progress.');
  let stage = 'Starting';
  const update = (description) => {
    stage = description;
    db.prepare('UPDATE cases SET stage = ? WHERE id = ?').run(stage, id);
  };
  void task(update).then(() => {
    db.prepare("UPDATE cases SET state = 'ready', stage = NULL WHERE id = ?").run(id);
  }).catch((error) => {
    const report = stage === reportStage;
    const next = report ? 'Retry the report. Your analysis is saved.' : state === 'analyzing'
      ? 'Resume analysis to continue from the last completed stage.' : 'Retry the upload. Successfully indexed files are saved.';
    const message = isTemporaryModelError(error)
      ? `${provider} is temporarily busy. ${next}`
      : (report ? 'Analysis saved. ' : '') + error.message;
    db.prepare("UPDATE cases SET state = 'failed', error = ? WHERE id = ?").run(message, id);
  });
}

async function saveReport(id, name, documents, result, update) {
  update(reportStage);
  const report = await writeInvestigationReport(name, documents, result);
  const { rankedConclusion, ...analysis } = result;
  db.prepare('UPDATE cases SET result = ? WHERE id = ?').run(JSON.stringify({ ...analysis, report }), id);
}

async function indexLegacyImage(caseId, documentId) {
  const file = db.prepare(`SELECT d.type, o.content FROM documents d JOIN originals o ON d.id = o.document_id
    WHERE d.case_id = ? AND d.id = ? AND NOT EXISTS
      (SELECT 1 FROM passages p WHERE p.document_id = d.id AND p.locator = ?)`).get(caseId, documentId, visualLocator);
  if (!file || !imageTypes[file.type]) return;
  let job = visualJobs.get(documentId);
  if (!job) {
    job = (async () => {
      const { observations } = await inspectImage(file.content, file.type);
      const text = observations.trim().slice(0, 2200);
      if (!text) return;
      const [vector] = await embed([text]);
      const current = db.prepare('SELECT state FROM cases WHERE id = ?').get(caseId);
      if (current && !['analyzing', 'indexing', 'reporting'].includes(current.state)) {
        addImageObservation(db, caseId, documentId, { id: randomUUID(), locator: visualLocator, text, vector }, models.embedding);
      }
    })().finally(() => visualJobs.delete(documentId));
    visualJobs.set(documentId, job);
  }
  await job;
}

async function api(req, url, owner) {
  const method = req.method;
  const path = url.pathname;
  if (method === 'GET' && path === '/api/workspace') {
    const cases = db.prepare(`
      SELECT c.id, c.name, c.created, c.state, c.result IS NOT NULL AS analyzed,
        (SELECT count(*) FROM documents d WHERE d.case_id = c.id) AS documentCount
      FROM cases c WHERE c.owner IS ? ORDER BY c.rowid DESC
    `).all(owner);
    return [200, { configured: configured(), provider, models, cases, publicMode }];
  }
  if (method === 'POST' && path === '/api/workspace/cases') {
    const body = await parseBody(req, 10_000, 'json');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 160) throw new HttpError(400, 'Enter a case name of up to 160 characters.');
    if (publicMode && db.prepare('SELECT count(*) AS n FROM cases WHERE owner = ?').get(owner).n >= 3) {
      throw new HttpError(409, 'Delete an existing case before creating another. The public demo supports three cases per browser.');
    }
    usePublicCapacity();
    const id = randomUUID();
    db.prepare('INSERT INTO cases (id, name, created, owner) VALUES (?, ?, ?, ?)').run(id, name, new Date().toISOString(), owner);
    return [201, publicCase(db, id)];
  }
  const match = /^\/api\/workspace\/cases\/([0-9a-f-]+)(?:\/(upload|analyze|search|report|overview))?$/.exec(path);
  if (!match) throw new HttpError(404, 'Workspace endpoint not found.');
  const [, id, action] = match;
  if (!ownsCase(id, owner)) throw new HttpError(404, 'Case not found.');
  if (method === 'DELETE' && !action) {
    const outcome = deleteCase(db, id);
    if (outcome === 'missing') throw new HttpError(404, 'Case not found.');
    if (outcome === 'busy') throw new HttpError(409, 'Wait for the current case job to finish before deleting.');
    return [200, { id }];
  }
  const current = publicCase(db, id);
  if (!current) throw new HttpError(404, 'Case not found.');
  if (method === 'GET' && !action) return [200, current];
  if (method === 'GET' && action === 'report') {
    if (!current.result?.report) throw new HttpError(404, 'Generate the investigation report before downloading it.');
    return [200, exportInvestigationReport(current), {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="investigation-report.md"',
      'X-Content-Type-Options': 'nosniff',
    }];
  }
  if (method !== 'POST' || !action) throw new HttpError(405, 'Method not supported.');
  if (action === 'overview' && current.overview) return [200, { overview: current.overview }];
  if (!configured()) throw new HttpError(503, 'Set GEMINI_API_KEY or OPENAI_API_KEY in server/.env and restart the workspace.');
  if (action === 'overview') {
    if (current.state === 'indexing') throw new HttpError(409, 'Wait for evidence indexing to finish.');
    const passages = allPassages(db, id);
    if (!passages.length) return [200, { overview: null }];
    const version = passages.map(({ id }) => id).join(',');
    const key = id + ':' + version;
    if (!overviewJobs.has(key)) {
      usePublicCapacity();
      const job = (async () => {
        const overview = await describeCase(current.name, passages).catch(() => {
          throw new HttpError(503, 'The case summary is temporarily unavailable. Try again shortly.');
        });
        const latest = db.prepare('SELECT state FROM cases WHERE id = ?').get(id);
        if (!latest) throw new HttpError(404, 'Case not found.');
        if (latest.state === 'indexing' || allPassages(db, id).map(({ id }) => id).join(',') !== version) {
          throw new HttpError(409, 'The case evidence changed. Generate the summary again.');
        }
        if (overview) db.prepare('INSERT OR REPLACE INTO case_overviews VALUES (?, ?)').run(id, JSON.stringify(overview));
        return overview;
      })().finally(() => overviewJobs.delete(key));
      overviewJobs.set(key, job);
    }
    return [200, { overview: await overviewJobs.get(key) }];
  }
  if (action === 'upload') {
    const form = await parseBody(req, maxUpload, 'formData');
    const files = form.getAll('files');
    if (!files.length || files.length > 12 || files.some((file) => typeof file === 'string')) {
      throw new HttpError(400, 'Upload between 1 and 12 files per batch.');
    }
    for (const file of files) {
      try { validateFile(file); } catch (error) { throw new HttpError(400, error.message); }
    }
    if (publicMode && current.documents.length + files.length > 12) {
      throw new HttpError(409, 'Each public demo case supports up to 12 evidence files.');
    }
    usePublicCapacity();
    begin(id, 'indexing', async (update) => {
      for (const file of files) {
        update(`Extracting and indexing ${file.name}`);
        const document = await extractDocument(file);
        const vectors = await embed(document.chunks.map(({ text }) => text));
        document.chunks.forEach((chunk, index) => { chunk.vector = vectors[index]; });
        saveDocument(db, id, document, models.embedding);
      }
    });
    return [202, publicCase(db, id)];
  }
  if (action === 'analyze') {
    if (!current.documents.length) throw new HttpError(400, 'Upload and index a case file before starting analysis.');
    usePublicCapacity();
    begin(id, 'analyzing', async (update) => {
      const result = await investigate(db, id, current.name, update, database);
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE cases SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
        db.prepare('DELETE FROM analysis_progress WHERE case_id = ?').run(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      await saveReport(id, current.name, current.documents, result, update);
    });
    return [202, publicCase(db, id)];
  }
  if (action === 'report') {
    if (!current.result) throw new HttpError(409, 'Run case analysis before generating the report.');
    usePublicCapacity();
    begin(id, 'reporting', (update) => saveReport(id, current.name, current.documents, current.result, update));
    return [202, publicCase(db, id)];
  }
  const body = await parseBody(req, 10_000, 'json');
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query || query.length > 500) throw new HttpError(400, 'Enter a search query of up to 500 characters.');
  usePublicCapacity();
  const [vector] = await embed([query], 'RETRIEVAL_QUERY');
  const find = () => retrieve(db, id, query, vector, models.embedding, 12);
  let passages = find();
  let visualWarning;
  const first = passages[0];
  if (first && asksAboutVisuals(query) && !['analyzing', 'indexing', 'reporting'].includes(current.state)) {
    try {
      await indexLegacyImage(id, first.documentId);
      passages = find();
    } catch {
      visualWarning = 'The photo is available. Its visual description could not be generated right now.';
    }
  }
  const question = /\?$/.test(query) || /^(?:what|when|where|who|why|how|which)\b/i.test(query);
  const graph = body.mode === 'hybrid' ? null : current.result?.graph;
  const sources = question && graph ? new Map(allPassages(db, id).map((item) => [item.id, item])) : new Map();
  let graphLinks = question && !asksAboutVisuals(query) && graph
    ? followEvidenceLinks(graph, sources, query, passages.slice(0, 2), passages.slice(0, 8), 3)
    : [];
  let candidates = [...new Map([...passages.slice(0, 8), ...graphLinks.map(({ passage }) => passage),
    ...passages.slice(8)].map((passage) => [passage.id, passage])).values()];
  let toolTrace = [];
  let retrievalMode = body.mode === 'hybrid' ? 'hybrid' : 'baseline';
  const shouldAnswer = question && body.retrievalOnly !== true;
  const toolsEnabled = question && passages.length && body.mode !== 'baseline' && body.mode !== 'hybrid';
  const adaptive = shouldAnswer && toolsEnabled && body.mode !== 'tools';
  let result = adaptive ? await answerFromEvidence(query, candidates) : null;
  if (toolsEnabled && (!adaptive || result.answer.status === 'insufficient')) {
    try {
      const discovery = await runCaseEvidenceTools({
        database, caseId: id, question: query, seeds: candidates.slice(0, 4), graph,
        evidenceGap: result?.answer.text,
      });
      if (discovery?.trace.length) {
        toolTrace = discovery.trace;
        retrievalMode = 'tools';
        graphLinks = discovery.graphLinks;
        const candidateIds = new Set(candidates.map(({ id }) => id));
        if (discovery.passages.some(({ id }) => !candidateIds.has(id))) result = null;
        candidates = [...new Map([...discovery.passages, ...candidates].map((passage) => [passage.id, passage])).values()];
      }
    } catch { /* Preserve the existing retrieval workflow when model tools are unavailable. */ }
  }
  result ??= shouldAnswer
    ? await answerFromEvidence(query, candidates)
    : { passages: candidates, answer: null };
  return [200, { query, ...result, passages: result.passages.slice(0, 8), graphLinks, visualWarning, toolTrace, retrievalMode,
    ...(body.includeRetrieval === true ? { retrievalCandidates: candidates.map(({ document }) => document) } : {}),
  }];
}

export const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');
      return;
    }
    const listeningPort = server.address().port;
    const allowedHosts = publicMode ? [publicOrigin.host] : [`localhost:${listeningPort}`, `127.0.0.1:${listeningPort}`];
    const origin = publicOrigin?.origin || `http://${req.headers.host}`;
    if (!allowedHosts.includes(req.headers.host) || (req.headers.origin && req.headers.origin !== origin)) {
      throw new HttpError(403, 'Open the workspace at its configured address.');
    }
    const url = new URL(req.url, 'http://localhost');
    let owner = null;
    if (publicMode && url.pathname.startsWith('/api/workspace')) {
      owner = /(?:^|;\s*)__Host-td_workspace=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      if (!owner) {
        owner = randomBytes(32).toString('hex');
        res.setHeader('Set-Cookie', `__Host-td_workspace=${owner}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
      }
    }
    const document = /^\/api\/workspace\/cases\/([0-9a-f-]+)\/documents\/([0-9a-f-]+)\/(original|preview|page)$/.exec(url.pathname);
    if (document && req.method === 'GET') {
      const [, caseId, documentId, action] = document;
      if (!ownsCase(caseId, owner)) throw new HttpError(404, 'The original file is unavailable.');
      const file = db.prepare(`SELECT d.name, d.type, o.content FROM originals o
        JOIN documents d ON d.id = o.document_id WHERE d.case_id = ? AND d.id = ?`).get(caseId, documentId);
      if (!file) throw new HttpError(404, 'The original file is unavailable.');
      if (action === 'preview') {
        usePublicCapacity();
        const preview = await describePreview(file).catch(() => { throw new HttpError(422, 'This document could not be previewed. You can still download the original.'); });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(preview));
        return;
      }
      if (action === 'page') {
        const page = Number(url.searchParams.get('number'));
        if (file.type !== '.pdf' || !Number.isSafeInteger(page) || page < 1) throw new HttpError(400, 'Invalid PDF page.');
        usePublicCapacity();
        const body = await renderPdfPage(file.content, page).catch(() => { throw new HttpError(422, 'This PDF page could not be rendered.'); });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(body);
        return;
      }
      const download = url.searchParams.get('download') === '1';
      const inline = imageTypes[file.type] || (file.type === '.pdf' && url.searchParams.get('inline') === '1' ? 'application/pdf' : null);
      res.writeHead(200, {
        'Content-Type': inline || 'application/octet-stream',
        'Content-Disposition': `${inline && !download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16))}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }).end(file.content);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const [status, output, headers] = await api(req, url, owner);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
        .end(headers ? output : JSON.stringify(output));
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/agent-workspace' }).end();
      return;
    }
    const target = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (target !== dist && !target.startsWith(dist + sep)) throw new HttpError(404, 'Page not found.');
    const info = await stat(target).catch(() => null);
    const file = info?.isFile() ? target : resolve(dist, 'index.html');
    const body = await readFile(file).catch(() => { throw new HttpError(503, 'Build the frontend with npm run build before starting the workspace.'); });
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body);
  } catch (error) {
    const status = error.status ?? 500;
    if (status === 500) console.error(error.message);
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: status === 500 ? 'The request failed. Check the server output.' : error.message }));
  }
});
server.once('close', () => db.close());
server.listen(port, publicMode ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Text Detective workspace at ${publicOrigin?.origin || `http://127.0.0.1:${server.address().port}`}`);
});
