import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { embed, models } from './models.mjs';
import { allPassages, retrieve } from './store.mjs';
import { followEvidenceLinks } from './graph-retrieval.mjs';

const protocol = '2025-06-18';
const versions = new Set([protocol, '2025-11-25']);
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string', minLength: 1, maxLength: 500 };
const ids = { type: 'array', maxItems: 32, items: text };
const readOnly = { readOnlyHint: true, destructiveHint: false };
const tools = [
  {
    name: 'search_evidence', description: 'Search indexed passages in the bound Text Detective case.',
    inputSchema: schema({ query: text }, ['query']), annotations: readOnly,
  },
  {
    name: 'follow_graph_links', description: 'Retrieve sources linked to case events through shared entities.',
    inputSchema: schema({ focus: text, seedIds: ids, excludeIds: ids, graph: { type: 'object' } }, ['focus']),
    annotations: readOnly,
  },
  {
    name: 'read_source', description: 'Read an indexed source passage from the bound case.',
    inputSchema: schema({ sourceId: text }, ['sourceId']), annotations: readOnly,
  },
];

const file = process.env.TD_MCP_DATABASE;
const caseId = process.env.TD_MCP_CASE_ID;
if (!file || !caseId) {
  console.error('Set TD_MCP_DATABASE and TD_MCP_CASE_ID before starting the evidence MCP server.');
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
if (!db.prepare('SELECT 1 FROM cases WHERE id = ?').get(caseId)) {
  console.error('The selected case does not exist.');
  db.close();
  process.exit(1);
}
const emit = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const bounded = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
let initialized = false;
let ready = false;

async function callTool(name, args) {
  if (name === 'search_evidence' && bounded(args.query)) {
    const [vector] = await embed([args.query], 'RETRIEVAL_QUERY');
    return { passages: retrieve(db, caseId, args.query, vector, models.embedding, 4) };
  }
  const passages = new Map(allPassages(db, caseId).map((item) => [item.id, item]));
  if (name === 'read_source' && bounded(args.sourceId)) {
    const passage = passages.get(args.sourceId);
    if (!passage) throw new Error('Source is unavailable in the selected case.');
    return { passage };
  }
  if (name === 'follow_graph_links' && bounded(args.focus)) {
    const saved = db.prepare('SELECT result FROM cases WHERE id = ?').get(caseId)?.result;
    const graph = args.graph || (saved && JSON.parse(saved).graph);
    if (!Array.isArray(graph?.entities) || !Array.isArray(graph?.events)) return { links: [] };
    const resolve = (values) => Array.isArray(values)
      ? values.slice(0, 32).flatMap((id) => passages.has(id) ? [passages.get(id)] : []) : [];
    return { links: followEvidenceLinks(graph, passages, args.focus, resolve(args.seedIds).slice(0, 3), resolve(args.excludeIds), 3) };
  }
  throw new Error('Unknown tool or invalid arguments.');
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let finished;
input.on('close', () => { finished = true; });
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); }
  catch { emit({ id: null, error: { code: -32700, message: 'Invalid JSON.' } }); continue; }
  const id = message?.id;
  const method = message?.method;
  if (message?.jsonrpc !== '2.0' || typeof method !== 'string') {
    emit({ id: id ?? null, error: { code: -32600, message: 'Invalid request.' } });
    continue;
  }
  if (id === undefined) {
    if (method === 'notifications/initialized' && initialized) ready = true;
    continue;
  }
  let result;
  if (method === 'initialize' && !initialized) {
    initialized = true;
    const requested = message.params?.protocolVersion;
    result = { protocolVersion: versions.has(requested) ? requested : protocol, capabilities: { tools: {} },
      serverInfo: { name: 'text-detective-evidence', version: '1.0.0' } };
  } else if (method === 'ping') {
    result = {};
  } else if (!ready) {
    emit({ id, error: { code: -32002, message: 'Initialize the client before calling tools.' } });
    continue;
  } else if (method === 'tools/list') {
    result = { tools };
  } else if (method === 'tools/call') {
    const params = message.params || {};
    try {
      const data = await callTool(params.name, params.arguments || {});
      result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      result = { content: [{ type: 'text', text: error.message }], isError: true };
    }
  } else {
    emit({ id, error: { code: -32601, message: 'Method not found.' } });
    continue;
  }
  if (!finished) emit({ id, result });
}
db.close();
