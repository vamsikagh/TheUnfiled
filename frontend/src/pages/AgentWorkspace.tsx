import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, Clock3, FileText, Fingerprint, FolderOpen, Network, ScanLine, Search, ShieldAlert, UploadCloud } from 'lucide-react';
import './workspace.css';
import { CaseGraphViewer } from '../components/CaseGraphViewer';
import { InvestigationReport, type ReportData } from '../components/InvestigationReport';
import { DocumentViewer, type DocumentSelection } from '../components/DocumentViewer';
import { CaseDirectory, caseStatus, type CaseEntry } from './CaseDirectory';
import type { CaseGraph } from '../types';

type Source = { id: string; document: string; documentId: string; locator: string; text: string };
type CaseOverview = { text: string; sources: Source[] };
type GraphLink = { entity: string; from: string; to: string };
type ToolAction = { tool: string; detail: string; sources: string[]; transport?: string };
const toolLabel = (tool: string) => ({
  search_evidence: 'Search evidence', follow_graph_links: 'Follow graph links',
  read_source: 'Read source', select_evidence: 'Select sources',
} as Record<string, string>)[tool] || 'Evidence tool';
type EvidenceAnswer = { status: 'answered' | 'insufficient' | 'unavailable'; text: string;
  citations: { passageId: string; quote: string }[] };
type Cited = { sources: string[] };
type Result = {
  rankedConclusion: {
    score: number; margin: number | null;
    leaders: { explanation: string; sources: string[] }[];
  } | null;
  report?: ReportData;
  timeline: ({ when: string; title: string; narrative: string } & Cited)[];
  contradictions: { issue: string; account_a: string; account_b: string; sources_a: string[]; sources_b: string[] }[];
  hypotheses: { explanation: string; score: number; support: number; conflict: number; corroboration: number; penalty: number; unresolved: string;
    claims: { claim: string; support: string[]; conflict: string[] }[] }[];
  graph: { entities: ({ name: string; kind: string } & Cited)[]; events: ({ when: string; event: string; entities: string[] } & Cited)[] };
  searchLog: { query: string; sources: string[]; tool?: string; transport?: string; graphLinks?: (GraphLink & { source: string })[] }[];
  sources: Source[];
  models: Record<string, string>;
};
type CaseData = Pick<CaseEntry, 'id' | 'name' | 'created' | 'state'> & { stage: string | null; error: string | null; result: Result | null; canResume: boolean;
  overview: CaseOverview | null;
  documents: { id: string; name: string; passages: number }[] };
type Workspace = { configured: boolean; provider: string; cases: CaseEntry[]; models: Record<string, string>; publicMode?: boolean };
const base = '/api/workspace';
const tabs = ['Timeline', 'Evidence', 'Case graph', 'Contradictions', 'Hypotheses', 'Report'] as const;
type Tab = typeof tabs[number];
const busy = (state?: string) => state === 'indexing' || state === 'analyzing' || state === 'reporting';
const caseFromLocation = () => /^#case\/([a-f0-9-]+)$/.exec(window.location.hash)?.[1] || '';
const tabIcons = [Clock3, Search, Network, ShieldAlert, ScanLine, FileText];

function caseEntry(data: CaseData): CaseEntry {
  return { id: data.id, name: data.name, created: data.created, state: data.state,
    analyzed: Number(Boolean(data.result)), documentCount: data.documents.length };
}

function graphView(result: Result): CaseGraph {
  const lookup = new Map(result.sources.map((item) => [item.id, item]));
  const entities = new Map(result.graph.entities.map((entity, index) => [entity.name.toLowerCase(), {
    id: 'entity-' + index, label: entity.name, node_type: 'entity', sub_type: entity.kind === 'place' ? 'location' : entity.kind,
  }]));
  const documents = new Map(result.sources.map((source) => [source.documentId, {
    id: source.documentId, label: source.document, node_type: 'document',
  }]));
  const nodes: CaseGraph['nodes'] = [...documents.values(), ...entities.values()];
  const edges: CaseGraph['edges'] = [];
  for (const [index, event] of result.graph.events.entries()) {
    const id = 'event-' + index;
    nodes.push({ id, label: event.event, node_type: 'event', properties: { time: event.when } });
    const names = new Set(event.entities.map((name) => name.toLowerCase()));
    for (const name of names) {
      const entity = entities.get(name);
      if (entity) edges.push({ id: 'edge-' + edges.length, source: entity.id, target: id, relation: 'linked_to' });
    }
    const documentIds = new Set(event.sources.map((sourceId) => lookup.get(sourceId)?.documentId));
    for (const documentId of documentIds) {
      if (documentId) edges.push({ id: 'edge-' + edges.length, source: documentId, target: id, relation: 'provides_evidence' });
    }
  }
  return { nodes, edges };
}

async function request<T>(path: string, method = 'GET', body?: FormData | object): Promise<T> {
  const response = await fetch(base + path, {
    method,
    ...(body instanceof FormData ? { body } : body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => { throw new Error('Open the Node.js workspace on port 8001.'); });
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

export function AgentWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [selected, setSelected] = useState(caseFromLocation);
  const [caseData, setCaseData] = useState<CaseData>();
  const [tab, setTab] = useState<Tab>('Timeline');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Source[] | null>(null);
  const [graphLinks, setGraphLinks] = useState<(GraphLink & { passage: Source })[]>([]);
  const [toolTrace, setToolTrace] = useState<ToolAction[]>([]);
  const [answer, setAnswer] = useState<EvidenceAnswer | null>(null);
  const [visualWarning, setVisualWarning] = useState('');
  const [source, setSource] = useState<Source>();
  const [openDocument, setOpenDocument] = useState<DocumentSelection>();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [overviewStatus, setOverviewStatus] = useState<'loading' | 'empty' | 'error'>();
  const [overviewRetry, setOverviewRetry] = useState(0);
  const directoryRevision = useRef(0);

  useEffect(() => {
    const restore = () => resetCase(caseFromLocation());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  useEffect(() => {
    let retired = false;
    let timer: number | undefined;
    const refresh = () => {
      const revision = directoryRevision.current;
      return request<Workspace>('').then((data) => {
        if (retired) return;
        if (revision === directoryRevision.current) setWorkspace(data);
        if (!selected && data.cases.some((item) => busy(item.state))) timer = window.setTimeout(refresh, 1600);
      }).catch((reason) => { if (!retired) setError(reason.message); });
    };
    void refresh();
    return () => { retired = true; window.clearTimeout(timer); };
  }, [selected]);

  const active = caseData?.id === selected ? caseData : undefined;
  const running = busy(active?.state);
  const shouldGenerateOverview = Boolean(workspace?.configured && active && !active.overview &&
    active.state !== 'indexing' && active.documents.some(({ passages }) => passages > 0));
  useEffect(() => {
    if (!selected) return;
    let retired = false;
    let timer: number | undefined;
    const refresh = () => request<CaseData>('/cases/' + selected).then((data) => {
      if (retired) return;
      setCaseData(data);
      if (busy(data.state)) timer = window.setTimeout(refresh, 1300);
    }).catch((reason) => { if (!retired) setError(reason.message); });
    void refresh();
    return () => { retired = true; window.clearTimeout(timer); };
  }, [selected, running]);

  useEffect(() => {
    if (!shouldGenerateOverview) return;
    let retired = false;
    setOverviewStatus('loading');
    request<{ overview: CaseOverview | null }>('/cases/' + selected + '/overview', 'POST').then(({ overview }) => {
      if (retired) return;
      if (overview) {
        setCaseData((current) => current?.id === selected ? { ...current, overview } : current);
        setOverviewStatus(undefined);
      } else {
        setOverviewStatus('empty');
      }
    }).catch(() => { if (!retired) setOverviewStatus('error'); });
    return () => { retired = true; };
  }, [selected, shouldGenerateOverview, overviewRetry]);

  function resetCase(id: string) {
    setSelected(id);
    setFiles([]);
    setMatches(null);
    setGraphLinks([]);
    setToolTrace([]);
    setAnswer(null);
    setVisualWarning('');
    setSource(undefined);
    setOpenDocument(undefined);
    setQuery('');
    setError('');
    setOverviewStatus(undefined);
    setTab('Timeline');
  }

  function select(id: string) {
    if (id === selected) return;
    window.history.pushState(null, '', id ? '#case/' + id : window.location.pathname + window.location.search);
    resetCase(id);
    window.scrollTo(0, 0);
  }

  async function perform(action: () => Promise<void>) {
    setError('');
    setPending(true);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The request failed.'); }
    finally { setPending(false); }
  }

  async function create(name: string) {
    let created = false;
    await perform(async () => {
      const data = await request<CaseData>('/cases', 'POST', { name });
      setWorkspace((current) => current && ({ ...current, cases: [caseEntry(data), ...current.cases] }));
      select(data.id);
      setCaseData(data);
      created = true;
    });
    return created;
  }

  async function removeCase(id: string) {
    await request('/cases/' + id, 'DELETE');
    directoryRevision.current++;
    setWorkspace((current) => current && ({ ...current, cases: current.cases.filter((item) => item.id !== id) }));
    setCaseData((current) => current?.id === id ? undefined : current);
  }

  function upload() {
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    void perform(async () => {
      const data = await request<CaseData>('/cases/' + selected + '/upload', 'POST', form);
      if (caseFromLocation() !== selected) return;
      setCaseData(data);
      setFiles([]);
      setSource(undefined);
      setMatches(null);
      setGraphLinks([]);
      setToolTrace([]);
      setAnswer(null);
    });
  }

  function analyze() {
    void perform(async () => {
      const data = await request<CaseData>('/cases/' + selected + '/analyze', 'POST');
      if (caseFromLocation() !== selected) return;
      setCaseData(data);
      setTab('Timeline');
    });
  }

  function generateReport() {
    void perform(async () => {
      const data = await request<CaseData>('/cases/' + selected + '/report', 'POST');
      if (caseFromLocation() === selected) setCaseData(data);
    });
  }

  function search(event: FormEvent) {
    event.preventDefault();
    void perform(async () => {
      setVisualWarning('');
      setAnswer(null);
      setMatches(null);
      setGraphLinks([]);
      setToolTrace([]);
      const results = await request<{ passages: Source[]; answer: EvidenceAnswer | null; visualWarning?: string;
        graphLinks: (GraphLink & { passage: Source })[]; toolTrace: ToolAction[] }>('/cases/' + selected + '/search', 'POST', { query });
      if (caseFromLocation() !== selected) return;
      setMatches(results.passages);
      setGraphLinks(results.graphLinks);
      setToolTrace(results.toolTrace);
      setAnswer(results.answer);
      setVisualWarning(results.visualWarning || '');
    });
  }

  const result = active?.result;
  const status = active && caseStatus(caseEntry(active));
  const retryReport = active?.state === 'failed' && active.stage?.startsWith('Report agent') && Boolean(result);
  const blocked = pending || running || !workspace?.configured;
  const sourcesById = new Map([...(active?.overview?.sources || []), ...(result?.sources || []), ...(matches || []), ...graphLinks.map(({ passage }) => passage)]
    .map((item) => [item.id, item]));
  const sourceUrl = source && `${base}/cases/${selected}/documents/${source.documentId}/original`;
  const citations = (ids: string[]) => ids.length > 0 && (
    <div className="td-citations">
      {ids.map((id) => {
        const item = sourcesById.get(id);
        return item && <button key={id} onClick={() => setSource(item)}><FileText size={13} />{item.document} · {item.locator}</button>;
      })}
    </div>
  );

  return (
    <div className="td-workspace">
      <header className="td-header">
        <button type="button" className="td-brand" onClick={() => select('')} disabled={pending}><span><Fingerprint size={21} /></span> Text Detective</button>
        <button type="button" className="td-directory-nav" aria-current={!selected ? 'page' : undefined} onClick={() => select('')} disabled={pending}><FolderOpen size={16} /> Case directory</button>
        {workspace?.configured && <span className="td-provider"><span /> {workspace.provider} connected</span>}
      </header>
      {workspace?.publicMode && <div className="td-public-note" role="note">Public demo. Use fictional or redacted evidence. Cases are available in this browser and may reset when the demo restarts.</div>}
      <div hidden={Boolean(selected)}>
        <CaseDirectory cases={workspace?.cases || []} loading={!workspace && !error} pending={pending} error={error}
          onOpen={select} onCreate={create} onDelete={removeCase} />
      </div>
      {selected && <div className="td-case-page">
        <nav className="td-breadcrumb" aria-label="Breadcrumb">
          <button type="button" disabled={pending} onClick={() => select('')}><ArrowLeft size={15} /> All cases</button>
          {active && <span>{active.name}</span>}
        </nav>
        <div className="td-layout">

        <main className="td-main">
          {workspace && !workspace.configured && <div className="td-notice" role="status">Add a Gemini or OpenAI API key to server/.env and restart the workspace.</div>}
          {(error || active?.error) && <div className="td-alert" role="alert">{error || active?.error}</div>}
          <div className="td-case-heading">
            <div className="td-dossier-body">
              {status && <span className={`td-case-status td-tone-${status.tone}`}>{status.label}</span>}
              <h1>{active?.name || (error ? 'Case unavailable' : 'Loading case…')}</h1>
              {active?.overview && <div className="td-case-overview">
                <p>{active.overview.text}</p>
                {citations(active.overview.sources.map(({ id }) => id))}
              </div>}
              {!active?.overview && shouldGenerateOverview && <div className="td-case-overview td-case-overview-status" role="status">
                {overviewStatus === 'error' ? <>Case summary is temporarily unavailable. <button type="button" className="td-link" onClick={() => setOverviewRetry((count) => count + 1)}>Retry</button></>
                  : overviewStatus === 'empty' ? 'The indexed evidence does not yet establish what this case is about.'
                    : 'Summarizing the indexed evidence…'}
              </div>}
              {active && <div className="td-case-metrics"><button type="button" onClick={() => document.getElementById('td-case-documents')?.scrollIntoView({ block: 'start' })}><FileText size={15} /> {active.documents.length} files</button>
                {result && <><span><Clock3 size={15} /> {result.timeline.length} {result.timeline.length === 1 ? 'event' : 'events'}</span>
                  <span><ShieldAlert size={15} /> {result.contradictions.length} {result.contradictions.length === 1 ? 'contradiction' : 'contradictions'}</span></>}</div>}
            </div>
            {active && <button className="td-primary"
              onClick={retryReport ? () => { setTab('Report'); generateReport(); } : analyze}
              disabled={blocked || !active.documents.length}>
              <Network size={16} /> {retryReport ? 'Retry report' : active.canResume ? 'Resume analysis' : 'Run analysis'}
            </button>}
          </div>
          {running && <div className="td-status" role="status"><span />{active?.stage || 'Starting job'}</div>}
          {active && <>
            <nav className="td-tabs" aria-label="Case analysis">
              {tabs.map((item, index) => {
                const Icon = tabIcons[index];
                return <button key={item} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}><Icon size={15} /> {item}</button>;
              })}
            </nav>
            {tab === 'Timeline' && <section className="td-chronology">
              <h2>Chronology</h2>
              {result?.timeline.length ? <ol className="td-timeline">
                {result.timeline.map((item, index) => <li key={index}><time>{item.when}</time><div><h3>{item.title}</h3><p>{item.narrative}</p>{citations(item.sources)}</div></li>)}
              </ol> : <div className="td-empty"><BookOpen size={25} /><p>{result ? 'No cited timeline events were returned.' : 'Index the case files and run analysis to generate a cited timeline.'}</p></div>}
            </section>}
            {tab === 'Evidence' && <section>
              <h2>Evidence search</h2>
              <form className="td-search" onSubmit={search}>
                <input aria-label="Evidence search query" placeholder="Search this case by fact, name, or question" value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} />
                <button className="td-primary" disabled={blocked || !query.trim() || !active.documents.length}><Search size={16} /> Search</button>
              </form>
              {answer && <article className="td-evidence-answer" aria-live="polite">
                <h3>{answer.status === 'insufficient' ? 'Insufficient evidence' : 'Answer from case evidence'}</h3>
                <p>{answer.status === 'unavailable'
                  ? 'Answer generation is temporarily unavailable. You can still read the retrieved passages.'
                  : answer.text || 'The retrieved evidence does not establish an answer.'}</p>
                {answer.citations.length > 0 && <div className="td-answer-sources">
                  <h4>{answer.status === 'insufficient' ? 'Documents showing what is known' : 'Supporting documents'}</h4>
                  {answer.citations.map(({ passageId, quote }) => {
                    const item = sourcesById.get(passageId);
                    if (!item) return null;
                    return <div className="td-answer-source" key={passageId}>
                      <button className="td-link" type="button" onClick={() => setSource(item)}>
                        <FileText size={15} /> {item.document} · {item.locator} <ArrowUpRight size={14} />
                      </button>
                      <blockquote>{quote}</blockquote>
                    </div>;
                  })}
                </div>}
              </article>}
              {matches?.length === 0 && <p>No matching passages.</p>}
              {visualWarning && <p className="td-notice" role="status">{visualWarning}</p>}
              {toolTrace.length > 0 && <details className="td-panel">
                <summary>Evidence agent actions ({toolTrace.length})</summary>
                <ol>{toolTrace.map((action, index) => <li key={index}>
                  <p><strong>{toolLabel(action.tool)}{action.transport && <> via {action.transport}</>}</strong>{action.detail && <> · {action.detail}</>}</p>
                  {citations(action.sources)}
                </li>)}</ol>
              </details>}
              {graphLinks.length > 0 && <details className="td-panel">
                <summary>Graph-linked evidence ({graphLinks.length})</summary>
                {graphLinks.map(({ entity, from, to, passage }) => <div className="td-answer-source" key={passage.id}>
                  <p>{from} → <strong>{entity}</strong> → {to}</p>
                  <button className="td-link" type="button" onClick={() => setSource(passage)}>{passage.document} <ArrowUpRight size={14} /></button>
                </div>)}
              </details>}
              {answer && Boolean(matches?.length) && <h3 className="td-retrieved-heading">Retrieved passages</h3>}
              {matches?.map((item, index) => <article className="td-panel" key={item.id}>
                <h3>{item.document} · {item.locator}</h3>
                {/\.(png|jpe?g|webp|gif)$/i.test(item.document) && matches.findIndex((match) => match.documentId === item.documentId) === index &&
                  <button className="td-search-image" type="button" aria-label={`View ${item.document}`} onClick={() =>
                    setOpenDocument({ id: item.documentId, name: item.document, locator: item.locator })}>
                    <img src={`${base}/cases/${selected}/documents/${item.documentId}/original`} loading="lazy" alt={item.document} />
                  </button>}
                <p>{item.text}</p><button className="td-link" onClick={() => setSource(item)}>Read passage <ArrowUpRight size={14} /></button>
              </article>)}
              {result && <details className="td-panel"><summary>Agent retrieval history</summary>{result.searchLog.map((entry, index) => <div key={index}>
                <p>{entry.tool && <strong>{toolLabel(entry.tool)}{entry.transport && <> via {entry.transport}</>} · </strong>}{entry.query}</p>
                {entry.graphLinks?.map((path) => <p key={path.source}>{path.from} → <strong>{path.entity}</strong> → {path.to}</p>)}
                {citations(entry.sources)}
              </div>)}</details>}
            </section>}
            {tab === 'Case graph' && <section>
              <h2>Entities and event relationships</h2>
              {result ? <>
                {result.graph.events.length > 0 && <CaseGraphViewer graph={graphView(result)} />}
                <div className="td-entities">{result.graph.entities.map((item, index) => <article className="td-panel" key={index}><small>{item.kind}</small><h3>{item.name}</h3>{citations(item.sources)}</article>)}</div>
                {result.graph.events.map((item, index) => <article className="td-panel" key={index}><small>{item.when}</small><h3>{item.event}</h3><p>{item.entities.join(' · ')}</p>{citations(item.sources)}</article>)}
              </> : <p>Run analysis to extract the case graph.</p>}
            </section>}
            {tab === 'Contradictions' && <section>
              <h2>Flagged contradictions</h2>
              {result?.contradictions.length ? result.contradictions.map((item, index) => <article className="td-panel td-conflict" key={index}>
                <h3>{item.issue}</h3><div className="td-accounts"><div><h4>Account A</h4><p>{item.account_a}</p>{citations(item.sources_a)}</div><div><h4>Account B</h4><p>{item.account_b}</p>{citations(item.sources_b)}</div></div>
              </article>) : <p>{result ? 'No cited cross-document contradictions were returned.' : 'Run analysis to compare accounts.'}</p>}
            </section>}
            {tab === 'Hypotheses' && <section>
              <h2>Evidence assessments</h2>
              {result?.hypotheses.length ? result.hypotheses.map((item, index) => <article className="td-panel" key={index}>
                <div className="td-hypothesis"><h3>{item.explanation}</h3><strong>{item.score}</strong></div>
                <p>Support {item.support} · Conflict {item.conflict} · Corroboration {item.corroboration} · Penalty {item.penalty}</p>
                {item.claims.map((claim, claimIndex) => <div className="td-claim" key={claimIndex}><h4>{claim.claim}</h4>
                  {claim.support.length > 0 && <><small>Supporting sources</small>{citations(claim.support)}</>}
                  {claim.conflict.length > 0 && <><small>Conflicting sources</small>{citations(claim.conflict)}</>}
                </div>)}
                {item.unresolved && <p><strong>Open question</strong> · {item.unresolved}</p>}
              </article>) : <p>{result ? 'No hypotheses were returned.' : 'Run analysis to assess possible explanations.'}</p>}
            </section>}
            {tab === 'Report' && (result?.report ? <InvestigationReport
              caseName={active.name} documents={active.documents} report={result.report} findings={result}
              downloadUrl={`${base}/cases/${selected}/report`} blocked={blocked}
              onGenerate={generateReport} onSource={setSource}
            /> : <section className="td-empty">
              <BookOpen size={25} />
              <h2>Investigation report</h2>
              <p>{result ? 'Generate a cited report from the saved case analysis.' : 'Run analysis to generate a report.'}</p>
              {result && <button className="td-primary" type="button" disabled={blocked} onClick={generateReport}>Generate report</button>}
            </section>)}
            {result && <footer className="td-models">Extraction {result.models.extraction} · Analysis {result.models.analysis} · Embeddings {result.models.embedding}</footer>}
          </>}
        </main>
        <aside className="td-sidebar" id="td-case-documents">
          <h2><FolderOpen size={18} /> Evidence files {active && <span>{active.documents.length}</span>}</h2>
          <ul className="td-evidence-register">
            {active?.documents.map((document) => <li key={document.id}><button type="button" className="td-document"
              onClick={() => setOpenDocument(document)} aria-label={`View ${document.name}`}>
              <span className="td-file-tag" aria-hidden="true">{document.name.split('.').pop()?.toUpperCase()}</span>
              <span><strong>{document.name}</strong><small>{document.passages} indexed {document.passages === 1 ? 'passage' : 'passages'}</small></span>
              <ArrowUpRight size={14} className="td-document-open" />
            </button></li>)}
          </ul>
          {active && <>
            <label className="td-upload">
              <UploadCloud size={21} />
              <strong>{files.length ? `${files.length} files selected` : 'Choose case files'}</strong>
              <small>PDF, Word, images, and text</small>
              <input aria-label="Choose evidence files" type="file" multiple disabled={blocked}
                accept={'.pdf,.docx,.png,.jpg,.jpeg,.webp,.txt,.log,.csv,.json,.md' + (workspace?.provider === 'OpenAI' ? ',.gif' : '')}
                onChange={(event) => { setFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
            </label>
            {files.length > 0 && <button className="td-secondary td-wide" disabled={blocked} onClick={upload}>Index selected files</button>}
            {workspace?.provider === 'Gemini' && <p className="td-upload-note">Use fictional or redacted files on the Gemini free tier. <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">Data terms</a></p>}
          </>}
        </aside>
        </div>
      </div>}
      {source && <aside className="td-source" aria-label="Source passage">
        <div><p className="td-overline">{source.locator}</p><button className="td-secondary" onClick={() => setSource(undefined)}>Close</button></div>
        <h2>{source.document}</h2>
        {sourceUrl && /\.(png|jpe?g|webp|gif)$/i.test(source.document) && <img className="td-original" src={sourceUrl} alt="Original case evidence" />}
        {sourceUrl && <button className="td-secondary td-source-open" type="button" onClick={() =>
          setOpenDocument({ id: source.documentId, name: source.document, locator: source.locator })}>
          <FileText size={15} /> View document
        </button>}
        <pre>{source.text}</pre>
      </aside>}
      {openDocument && selected && <DocumentViewer key={openDocument.id} document={openDocument}
        url={`${base}/cases/${selected}/documents/${openDocument.id}`}
        onClose={() => setOpenDocument(undefined)} />}
    </div>
  );
}

