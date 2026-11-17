import { inputText, list, models, record, string, structured } from './models.mjs';
import { rankConclusion } from './report-ranking.mjs';
import { correctMachineTimestamps, machineRecords } from './machine-events.mjs';

const narrativeItem = record({ title: string, text: string, sources: list(string) });
const narrative = record({
  executiveSummary: list(narrativeItem),
  findings: list(narrativeItem),
  limitations: list(narrativeItem),
  nextSteps: list(narrativeItem),
  conclusion: list(narrativeItem),
});
const limits = { executiveSummary: 1, findings: 3, limitations: 1, nextSteps: 2, conclusion: 1 };

export function compactReport(report) {
  return {
    ...report,
    // Older reports put unresolved disputes in a separate closing paragraph.
    ...Object.fromEntries(Object.entries(limits).map(([section, limit]) => [section, report[section].slice(0, section === 'conclusion' ? 2 : limit)])),
  };
}

export async function writeInvestigationReport(name, documents, result) {
  const { timeline, contradictions, hypotheses, graph, sources } = result;
  const machineEvents = machineRecords(sources);
  const priority = [
    ...contradictions.flatMap((item) => [...item.sources_a, ...item.sources_b]),
    ...timeline.flatMap((item) => item.sources),
    ...hypotheses.flatMap((item) => item.claims.flatMap((claim) => [...claim.support, ...claim.conflict])),
    ...sources.map(({ id }) => id),
  ];
  const byId = new Map(sources.map((item) => [item.id, item]));
  const passages = [...new Set(priority)].slice(0, 48).flatMap((id) => {
    const source = byId.get(id);
    return source ? [{ id, document: source.document, locator: source.locator, excerpt: source.text.slice(0, 1500) }] : [];
  });
  const draft = await structured(models.report, 'report_agent',
    'Write a concise investigation briefing for a professional reviewer, aiming for 220 words total. Use plain, precise prose and short, specific titles. ' +
    'Write one short executive summary that sets the context, up to three distinct key findings, one material limitation if needed, up to two concrete follow-up actions, and one short conclusion. Keep each item to one or two sentences. ' +
    'State the central issue, what the evidence supports, what is disputed, and what remains unresolved. Distinguish records of actions from witness claims, inferences, and verified physical observations. ' +
    'Treat the original passages as authoritative over the upstream analysis. Attribute each fact to the source that actually establishes it. ' +
    'For access-control evidence, a swipe or a log naming an assigned credential establishes the recorded credential use, even if the record names its assignee. Attribute physical identity to independent evidence that actually identifies the person. ' +
    'When a log records a badge and a witness reports a person, state their contributions separately, including in the executive summary and conclusion. ' +
    'Distinguish exact logged actions: credential accepted, door opened, and door closed can be separate events with different timestamps. ' +
    'When a hypothesis combines several claims, state which component has support and which remains unverified. Even a unique highest score cannot establish an unobserved action. ' +
    'For a missing item, separate last confirmed presence, first confirmed absence, and direct evidence of removal. If no source documents the act, state that who removed it and when remain unestablished. Never present a suggested actor or folder contents as established by timing, access, or opportunity alone. ' +
    'The application displays the hypothesis ranking separately. In the conclusion, state only what the original passages establish and what remains disputed. Do not restate or endorse an unverified action as a leading assessment. ' +
    'For images distinguish visible details from context supplied in companion records. Distinguish raw timestamps from corrected times and do not invent dates, identities, motives, outcomes, or missing evidence. ' +
    'Cite exact passage IDs from the supplied passages for every factual narrative item. Never insert bracketed citations in the prose, because they are rendered from the sources field. ' +
    'When no passage supports a claim, omit it or state the uncertainty. General limitations and proposed actions may have empty sources. ' +
    'Use scores only as relative rankings of candidate explanations. Summarize the decisive facts and avoid repeating findings in multiple sections. Leave detailed chronology, disputed accounts, and score breakdowns to the dedicated case views.',
    [inputText(JSON.stringify({
      caseName: name,
      documents: documents.map(({ name, passages }) => ({ name, passages })),
      timeline, contradictions, hypotheses, rankedConclusion: rankConclusion(hypotheses), machineEvents,
      entities: graph.entities.slice(0, 40),
      passages,
    }))],
    narrative,
  );
  const available = new Set(passages.map(({ id }) => id));
  function clean(items, limit, needsSources) {
    return items.flatMap((item) => {
      const sources = [...new Set(item.sources)];
      const title = item.title.trim();
      const text = correctMachineTimestamps(item.text.trim(), sources, machineEvents);
      if (!text || (needsSources && !sources.length) || sources.some((id) => !available.has(id))) return [];
      return [{ title, text, sources }];
    }).slice(0, limit);
  }
  const report = {
    generatedAt: new Date().toISOString(), model: models.report,
    executiveSummary: clean(draft.executiveSummary, limits.executiveSummary, true),
    findings: clean(draft.findings, limits.findings, true),
    limitations: clean(draft.limitations, limits.limitations, false),
    nextSteps: clean(draft.nextSteps, limits.nextSteps, false),
    conclusion: clean(draft.conclusion, limits.conclusion, true),
  };
  if (timeline.length && (!report.executiveSummary.length || !report.conclusion.length)) {
    throw new Error('The report model did not return a cited executive summary and conclusion. Use Generate report to retry.');
  }
  return report;
}

const plain = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]()#!|]/g, '\\$&');

export function exportInvestigationReport(caseData) {
  const { name, result } = caseData;
  const { sources, rankedConclusion } = result;
  const report = compactReport(result.report);
  const numbers = new Map(sources.map(({ id }, index) => [id, 'E' + (index + 1)]));
  const usedSources = new Set();
  const cited = (ids) => {
    for (const id of ids) if (numbers.has(id)) usedSources.add(id);
    const labels = [...new Set(ids.map((id) => numbers.get(id)).filter(Boolean))];
    return labels.length ? ' [' + labels.join(', ') + ']' : '';
  };
  const lines = ['# Investigation report', '', '**Case** ' + plain(name),
    '**Generated** ' + plain(report.generatedAt), '**Report model** ' + plain(report.model), ''];
  function section(title, content, empty) {
    lines.push('## ' + title, '', ...(content.length ? content : [empty]), '');
  }
  const narrativeLines = (items) => items.map((item) =>
    (item.title ? '**' + plain(item.title) + '**. ' : '') + plain(item.text) + cited(item.sources) + '\n');
  section('Executive summary', narrativeLines(report.executiveSummary), 'The analysis did not establish a cited summary.');
  const ranking = [];
  if (rankedConclusion) {
    const { score, leaders, margin } = rankedConclusion;
    ranking.push(leaders.length === 1 ? '**Highest-ranked hypothesis**' : '**Tied highest-ranked hypotheses**', '');
    ranking.push(...leaders.map((item) => '- ' + plain(item.explanation) + cited(item.sources)), '');
    ranking.push('**Evidence score** ' + score + (margin === null ? '' : ' · ' + margin + ' points ahead of the next explanation'), '');
    ranking.push('The evidence score is a relative ranking. Identity and disputed events still depend on what the sources establish.', '');
  }
  section('Conclusion', [...ranking, ...narrativeLines(report.conclusion)], 'The available evidence did not establish a cited conclusion.');
  section('Key findings', narrativeLines(report.findings), 'No additional cited findings were established.');
  section('Open questions and next steps', narrativeLines([...report.limitations, ...report.nextSteps]), 'No follow-up actions were proposed.');
  if (usedSources.size) section('Cited sources', sources.filter(({ id }) => usedSources.has(id)).map((item) =>
    '- **' + numbers.get(item.id) + '** · ' + plain(item.document) + ' · ' + plain(item.locator)));
  return lines.join('\n');
}
