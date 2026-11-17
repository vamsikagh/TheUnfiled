import { Clock3, Download, FileText, Fingerprint, Printer, RefreshCw, ShieldAlert } from 'lucide-react';

type Cited = { sources: string[] };
type NarrativeItem = Cited & { title: string; text: string };
export type ReportData = {
  generatedAt: string; model: string;
  executiveSummary: NarrativeItem[]; findings: NarrativeItem[]; limitations: NarrativeItem[];
  nextSteps: NarrativeItem[]; conclusion: NarrativeItem[];
};
type Source = { id: string; document: string; documentId: string; locator: string; text: string };
type Findings = {
  rankedConclusion: {
    score: number; margin: number | null;
    leaders: ({ explanation: string } & Cited)[];
  } | null;
  timeline: unknown[];
  contradictions: unknown[];
  sources: Source[];
};
type Props = {
  caseName: string;
  documents: { id: string; name: string; passages: number }[];
  report: ReportData;
  findings: Findings;
  downloadUrl: string;
  blocked: boolean;
  onGenerate: () => void;
  onSource: (source: Source) => void;
};

export function InvestigationReport({ caseName, documents, report, findings, downloadUrl, blocked, onGenerate, onSource }: Props) {
  const ranking = findings.rankedConclusion;
  const references = new Map(findings.sources.map((item, index) => [item.id, { item, label: 'E' + (index + 1) }]));
  const citations = (ids: string[]) => {
    const entries = ids.flatMap((id) => {
      const entry = references.get(id);
      return entry ? [entry] : [];
    });
    return entries.length > 0 && <div className="td-report-citations" aria-label="Sources">
      {entries.map(({ item, label }) =>
        <button key={item.id} type="button" title={item.document + ' · ' + item.locator}
          aria-label={label + ' ' + item.document + ' ' + item.locator} onClick={() => onSource(item)}>{label}</button>)}
    </div>;
  };
  const narrative = (items: NarrativeItem[], empty: string) => items.length ? items.map((item, index) =>
    <div className="td-report-item" key={index}>
      {item.title && <h3>{item.title}</h3>}
      <p>{item.text}</p>
      {citations(item.sources)}
    </div>) : <p className="td-report-muted">{empty}</p>;

  return (
    <article className="td-report" aria-label="Investigation report">
      <header className="td-report-header">
        <div className="td-report-cover-title">
          <div>
            <p className="td-overline">Investigation report</p>
            <h2>{caseName}</h2>
            <p className="td-report-muted">
              Generated <time dateTime={report.generatedAt}>{new Date(report.generatedAt).toLocaleString()}</time> · {report.model}
            </p>
          </div>
          <span className="td-report-seal" aria-hidden="true"><Fingerprint size={37} /></span>
        </div>
        <dl className="td-report-metrics">
          <div><dt><FileText size={15} /> Evidence files</dt><dd>{documents.length}</dd></div>
          <div><dt><Clock3 size={15} /> Timeline events</dt><dd>{findings.timeline.length}</dd></div>
          <div><dt><ShieldAlert size={15} /> Contradictions</dt><dd>{findings.contradictions.length}</dd></div>
        </dl>
        <div className="td-report-actions">
          <a className="td-secondary" href={downloadUrl}><Download size={15} /> Markdown</a>
          <button className="td-secondary" type="button" onClick={() => window.print()}><Printer size={15} /> Print / Save PDF</button>
          <button className="td-secondary" type="button" disabled={blocked} onClick={onGenerate}><RefreshCw size={15} /> Regenerate</button>
        </div>
      </header>
      <section className="td-report-summary">
        <h2>Executive summary</h2>
        {narrative(report.executiveSummary, 'The analysis did not establish a cited summary.')}
      </section>
      <section>
        <h2>Conclusion</h2>
        {ranking && <div className="td-report-ranking">
          <div className="td-report-score"><strong>{ranking.score}</strong><span>Evidence score</span></div>
          <div>
            <h3>{ranking.leaders.length === 1 ? 'Highest-ranked hypothesis' : 'Tied highest-ranked hypotheses'}</h3>
            {ranking.leaders.map((item, index) => <div key={index}>
              <p>{item.explanation}</p>
              {citations(item.sources)}
            </div>)}
            {ranking.margin !== null && <p className="td-report-muted">{ranking.margin} {ranking.margin === 1 ? 'point' : 'points'} ahead of the next explanation</p>}
            <p className="td-report-muted">The score ranks the hypotheses. The conclusion below describes what the sources establish.</p>
          </div>
        </div>}
        {narrative(report.conclusion, 'The available evidence did not establish a cited conclusion.')}
      </section>
      <section>
        <h2>Key findings</h2>
        {narrative(report.findings, 'No additional cited findings were established.')}
      </section>
      {(report.limitations.length > 0 || report.nextSteps.length > 0) && <section>
        <h2>Open questions and next steps</h2>
        {narrative([...report.limitations, ...report.nextSteps], '')}
      </section>}
    </article>
  );
}
