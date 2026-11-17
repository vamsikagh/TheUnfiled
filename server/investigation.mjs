import { choice, embed, inputText, list, models, record, string, structured } from './models.mjs';
import { allPassages, analysisStep, retrieve } from './store.mjs';
import { followEvidenceLinks } from './graph-retrieval.mjs';
import { runCaseEvidenceTools } from './evidence-tools.mjs';
import { applyMachineTimeline, correctMachineTimestamps, machineRecords } from './machine-events.mjs';

const references = list(string);
const graphSchema = record({
  entities: list(record({ name: string, kind: choice('person', 'organization', 'place', 'object', 'other'), sources: references })),
  events: list(record({ when: string, event: string, entities: list(string), sources: references })),
  evidence_gaps: list(string),
});
const assessment = record({
  timeline: list(record({ when: string, title: string, narrative: string, sources: references })),
  contradictions: list(record({ issue: string, account_a: string, account_b: string, sources_a: references, sources_b: references })),
  hypotheses: list(record({
    explanation: string, claims: list(record({ claim: string, support: references, conflict: references, dispute_sources: references })),
    unresolved: string,
  })),
});
const planner = record({ queries: list(string) });
const evidenceAnswer = record({
  status: choice('answered', 'insufficient'),
  answer: string,
  support: list(record({ id: string, quote: string })),
});

async function agent(model, name, instructions, input, schema) {
  return structured(model, name, instructions, [inputText(JSON.stringify(input))], schema);
}

const noAnswer = { status: 'insufficient', text: '', citations: [] };
const normalizeQuote = (text) => text.trim().replace(/\s+/g, ' ');

function completeTimeCitations(query, passages, citations) {
  if (!/\b(?:reconcile|align|compare)\b/i.test(query)) return;
  const sides = query.split(/\b(?:with|against|versus|and)\b/i);
  if (sides.length !== 2) return;
  const times = sides.map((side) => side.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0]);
  if (!times[0] || !times[1] || times[0] === times[1]) return;
  for (let index = 0; index < sides.length; index++) {
    if (citations.length >= 4) break;
    const terms = sides[index].toLowerCase().match(/[a-z]{4,}/g) || [];
    const time = times[index];
    const timePattern = new RegExp(`(?<!\\d)${time}(?!\\d)`);
    const candidates = passages.flatMap((item) => {
      const label = item.document.toLowerCase().split(/[^a-z]+/);
      const relevance = terms.filter((term) => label.includes(term)).length;
      const line = item.text.split(/\r?\n/).find((value) => timePattern.test(value));
      return relevance && line ? [{ item, relevance, line }] : [];
    }).sort((a, b) => b.relevance - a.relevance);
    const best = candidates[0];
    if (!best || citations.some(({ passageId }) => passageId === best.item.id)) continue;
    const match = best.line.search(timePattern);
    citations.push({ passageId: best.item.id, quote: normalizeQuote(best.line.slice(Math.max(0, match - 90), match + 110)) });
  }
}

export async function answerFromEvidence(query, passages) {
  if (!passages.length) return { passages, answer: noAnswer };
  const candidates = new Map(passages.map((item, index) => ['P' + (index + 1), item]));
  try {
    const result = await agent(models.analysis, 'evidence_answer',
      'Answer the user question directly in one to three sentences, using only the supplied case passages. ' +
      'Preserve attribution. If asked who said something, name the speaker and use reported speech. Distinguish an account from what actually happened. ' +
      'If relevant evidence conflicts, describe the conflict without choosing a side. Prefer a passage that directly states the requested fact over one that just mentions the same entity. ' +
      'For a question about a photo, prioritize its Visual observations passage. Attribute what the photo shows and avoid guessing. ' +
      'For a comparison or reconciliation, independently verify the facts on both sides, even if the question already supplies them. Cite the original passage for each side and any separate record that supplies the rule, offset, or context connecting them. ' +
      'For example, when reconciling a clock overlay with a sensor record, cite the passage showing the original overlay, the calibration passage establishing the offset, and the passage showing the sensor timestamp. A calibration quote alone supports only the offset. ' +
      'For each material assertion provide a supporting passage ID and one short exact contiguous quote copied verbatim from that passage. Order supporting passages strongest first. Do not cite filenames as evidence. ' +
      'Use answered only when you can state the specific fact requested, or the question explicitly asks what conflicting sources say and you can state their accounts. ' +
      'For identity questions, an obscured person, an assigned badge, or an authorized operator list does not by itself identify who acted. ' +
      'If a requested fact remains unknown, return insufficient even if you can explain why. Example: Question: Who drove cart Q-3? Evidence: the driver was obscured. Return insufficient and say the driver could not be identified because the footage obscured them. ' +
      'For insufficient, explain what is missing and cite any passages that establish the limitation. If you have no verified basis for an explanation, leave answer and support empty.',
      { query, candidates: [...candidates].map(([id, item]) => ({
        id, document: item.document, locator: item.locator, text: item.text,
      })) }, evidenceAnswer);
    if (!result.answer.trim()) return { passages, answer: noAnswer };
    const citations = [];
    const selected = new Set();
    for (const { id, quote } of result.support) {
      const passage = candidates.get(id);
      const excerpt = normalizeQuote(quote);
      if (!passage || excerpt.length < 6 || selected.has(passage.id) || !normalizeQuote(passage.text).includes(excerpt)) continue;
      citations.push({ passageId: passage.id, quote: excerpt });
      selected.add(passage.id);
      if (citations.length === 4) break;
    }
    if (!citations.length) return { passages, answer: noAnswer };
    if (result.status === 'answered') completeTimeCitations(query, passages, citations);
    for (const { passageId } of citations) selected.add(passageId);
    const byId = new Map(passages.map((passage) => [passage.id, passage]));
    return {
      answer: { status: result.status, text: correctMachineTimestamps(result.answer.trim(), [...selected], machineRecords(passages)), citations },
      passages: [...citations.map(({ passageId }) => byId.get(passageId)), ...passages.filter(({ id }) => !selected.has(id))],
    };
  } catch {
    return { passages, answer: { status: 'unavailable', text: '', citations: [] } };
  }
}

export async function searchCase(db, caseId, queries) {
  const vectors = await embed(queries, 'RETRIEVAL_QUERY');
  return queries.map((query, index) => ({
    query, passages: retrieve(db, caseId, query, vectors[index], models.embedding),
  }));
}

function cited(items, available) {
  return items.flatMap((item) => {
    const sources = [...new Set(item.sources)];
    return sources.length && sources.every((id) => available.has(id)) ? [{ ...item, sources }] : [];
  });
}

function sourceLabels(passages) {
  const labels = new Map(passages.map(({ id }, index) => [id, 'E' + (index + 1)]));
  const ids = new Map([...labels].map(([id, label]) => [label, id]));
  return {
    passage: (item) => ({ ...item, id: labels.get(item.id) }),
    labelRow: (item) => ({ ...item, sources: item.sources.map((id) => labels.get(id)) }),
    restore: (refs) => [...new Set(refs.map((ref) => ids.get(ref.trim().toUpperCase())).filter(Boolean))],
  };
}

export async function describeCase(name, passages) {
  const byDocument = new Map();
  for (const passage of passages) {
    if (!byDocument.has(passage.documentId)) byDocument.set(passage.documentId, []);
    byDocument.get(passage.documentId).push(passage);
  }
  const groups = [...byDocument.values()];
  const excerpts = [];
  for (let index = 0; excerpts.length < 36 && groups.length; index++) {
    const round = groups.flatMap((group) => group[index] ? [group[index]] : []);
    if (!round.length) break;
    excerpts.push(...round.slice(0, 36 - excerpts.length));
  }
  const refs = sourceLabels(excerpts);
  const result = await agent(models.analysis, 'case_overview',
    'Write a neutral overview for the header of an investigation case. In one or two plain-language sentences, identify the central incident or issue and what the case seeks to establish. Maximum 65 words. Lead with the main incident, rather than listing documents, dates, or background details. Use only the supplied excerpts. Treat witness accounts as attributed and do not imply disputed facts, guilt, or responsibility are established. The case title is only context. Return the exact evidence labels for the core facts, up to three. If the evidence does not identify a case subject, return an empty text and sources.',
    { name, evidence: excerpts.map((item) => ({ ...refs.passage(item), text: item.text.slice(0, 1000) })) },
    record({ text: string, sources: references }));
  const ids = new Set(refs.restore(result.sources).slice(0, 3));
  const text = result.text.trim().replace(/\s+/g, ' ');
  return text && ids.size ? { text, sources: excerpts.filter(({ id }) => ids.has(id)) } : null;
}

export async function extractGraph(passages) {
  const refs = sourceLabels(passages);
  const result = await agent(models.extraction, 'graph_agent',
    'You are the case graph agent. Extract named entities and event assertions from the supplied passages. Put the exact short evidence labels, such as E1, in sources. Include participants, location, and precise times where stated. Keep conflicting accounts distinct. Distinguish a timestamp documenting a record from the time of the event. Preserve date and timezone uncertainty; do not infer missing date/time. Request targeted retrieval queries for gaps that matter. Keep event descriptions concise.',
    { passages: passages.map(refs.passage) }, graphSchema);
  const restoreRows = (items) => items.map((item) => ({ ...item, sources: refs.restore(item.sources) })).filter((item) => item.sources.length);
  if (result.events.length && !restoreRows(result.events).length) {
    throw new Error('The event extractor returned source references it could not match. Retry analysis to resume.');
  }
  return { ...result, entities: restoreRows(result.entities), events: restoreRows(result.events) };
}

export async function investigate(db, caseId, name, update, database) {
  const passages = allPassages(db, caseId);
  if (!passages.length) throw new Error('Upload and index at least one case file first.');
  if (passages.length > 240) throw new Error('This workspace supports up to 240 passages per analysis. Split this case into smaller batches.');
  const evidence = new Map(passages.map((passage) => [passage.id, passage]));
  const machineEvents = machineRecords(passages);
  const step = (stage, task) => analysisStep(db, caseId, stage, task);
  update('Evidence agent is finding relevant passages');
  const plan = await step('evidence-plan', () => agent(models.extraction, 'evidence_agent',
    'You are the evidence retrieval agent. Plan up to four different short searches for chronology, named parties, and disputed facts. Use the source previews as orientation only.',
    { name, previews: passages.filter((item, index) => index === 0 || item.document !== passages[index - 1].document)
      .slice(0, 24).map(({ document, text }) => ({ document, text: text.slice(0, 400) })) }, planner));
  const searchLog = [];
  async function gather(stage, queries) {
    const terms = [...new Set(queries.map((query) => query.trim().slice(0, 500)).filter(Boolean))].slice(0, 4);
    if (!terms.length) return [];
    const results = await step(stage, () => searchCase(db, caseId, terms));
    searchLog.push(...results.map(({ query, passages }) => ({ query, sources: passages.map(({ id }) => id) })));
    return [...new Map(results.flatMap((result) => result.passages).map((passage) => [passage.id, passage])).values()];
  }
  const initial = await gather('initial-retrieval', plan.queries.length ? plan.queries : [name]);
  update('Graph agent is extracting entities, events, and times');
  const graphs = [];
  for (let i = 0; i < passages.length; i += 18) {
    graphs.push(await step('graph-' + i, () => extractGraph(passages.slice(i, i + 18))));
  }
  const gaps = graphs.flatMap((graph) => graph.evidence_gaps).slice(0, 16);
  const preliminaryGraph = {
    entities: graphs.flatMap((item) => item.entities),
    events: graphs.flatMap((item) => item.events),
  };
  const graphLinks = followEvidenceLinks(preliminaryGraph, evidence, gaps.join(' '), initial.slice(0, 3), initial);
  if (graphLinks.length) searchLog.push({
    query: 'Related evidence found through the case graph',
    sources: graphLinks.map(({ passage }) => passage.id),
    graphLinks: graphLinks.map(({ passage, ...path }) => ({ ...path, source: passage.id })),
  });
  let followup = [];
  if (gaps.length) {
    update('Evidence agent is retrieving sources for open questions');
    let discovery;
    try {
      discovery = await step('followup-tools', () => runCaseEvidenceTools({
        database, caseId,
        question: `Find evidence for the open questions in case ${name}: ${gaps.join(' | ')}`,
        seeds: initial.slice(0, 4), graph: preliminaryGraph,
      }));
    } catch { /* The scripted follow-up remains available. */ }
    if (discovery?.trace.length) {
      followup = discovery.passages;
      searchLog.push(...discovery.trace.map(({ tool, detail, sources, transport }) => ({ query: detail || tool, sources, tool, transport })));
    } else {
      const followupPlan = await step('followup-plan', () => agent(models.extraction, 'followup_agent',
        'Act as the evidence retrieval agent. Use the linked events as leads and turn the most important unresolved evidence gaps into up to four short and specific database searches. Graph links can suggest context; they do not prove a claim.',
        { gaps, graphLeads: graphLinks.map(({ entity, from, to, passage }) => ({ entity, from, to, document: passage.document })) }, planner));
      followup = await gather('followup-retrieval', followupPlan.queries);
    }
    if (followup.length) graphs.push(await step('followup-graph', () => extractGraph(followup.slice(0, 18))));
  }
  const graph = {
    entities: cited(graphs.flatMap((item) => item.entities), evidence),
    events: cited(graphs.flatMap((item) => item.events), evidence),
  };
  update('Analysis agent is writing the timeline and comparing claims');
  const retrieved = [...new Map([...graphLinks.map(({ passage }) => passage), ...initial, ...followup].map((passage) => [passage.id, passage])).values()].slice(0, 28);
  const available = new Set([
    ...graph.entities.flatMap((item) => item.sources),
    ...graph.events.flatMap((item) => item.sources),
    ...retrieved.map(({ id }) => id),
  ]);
  const refs = sourceLabels(passages.filter(({ id }) => available.has(id)));
  const output = await agent(models.analysis, 'analysis_agent',
    'You are the case synthesis agent. Write a chronological, story-like timeline from the case graph and retrieved sources. One meaningful event per entry, dated and timed only to supported precision. Put unknown times after dated events. Attribute contested accounts and do not choose between them without evidence. Identify contradictions only for incompatible assertions about the same event, with separate citations for both sides. Propose up to three plausible hypotheses with testable claims. Cite direct support and direct conflict separately for each claim; use empty lists when evidence is missing. In dispute_sources, cite both sides of a listed contradiction only when the claim takes one side and the available evidence leaves that dispute open. Copy the exact short evidence labels, such as E1, into all citation arrays.',
    { name, graph: { entities: graph.entities.map(refs.labelRow), events: graph.events.map(refs.labelRow) }, retrieved: retrieved.map(refs.passage),
      machineEvents: machineEvents.filter((item) => item.sources.some((id) => available.has(id)))
        .map((item) => refs.labelRow({ ...item, sources: item.sources.filter((id) => available.has(id)) })) },
    assessment);
  const ids = refs.restore;
  const contradictions = output.contradictions.flatMap((item) => {
    const sources_a = ids(item.sources_a);
    const sources_b = ids(item.sources_b);
    const independent = sources_a.some((a) => sources_b.some((b) => evidence.get(a).documentId !== evidence.get(b).documentId));
    return independent ? [{ ...item, sources_a, sources_b }] : [];
  });
  const hypotheses = output.hypotheses.map((item) => {
    const claims = item.claims.map((claim) => ({
      ...claim, support: ids(claim.support), conflict: ids(claim.conflict), dispute_sources: ids(claim.dispute_sources),
    }));
    const support = new Set(claims.flatMap((claim) => claim.support)).size;
    const conflict = new Set(claims.flatMap((claim) => claim.conflict)).size;
    const corroboration = claims.filter((claim) => new Set(claim.support.map((id) => evidence.get(id).documentId)).size >= 2).length;
    const penalty = Math.min(2, claims.filter((claim) => contradictions.some((item) =>
      item.sources_a.some((id) => claim.dispute_sources.includes(id)) &&
      item.sources_b.some((id) => claim.dispute_sources.includes(id)))).length);
    return { ...item, claims, score: support - conflict + corroboration - penalty, support, conflict, corroboration, penalty };
  }).sort((a, b) => b.score - a.score);
  const timeline = applyMachineTimeline(cited(output.timeline.map((item) => ({ ...item, sources: ids(item.sources) })), available), machineEvents);
  if (!timeline.length && (graph.events.length || output.timeline.length)) {
    throw new Error('The timeline model returned no usable citations. Resume analysis to rebuild only the timeline.');
  }
  return {
    timeline, contradictions, hypotheses, graph,
    searchLog, sources: passages, models,
  };
}
