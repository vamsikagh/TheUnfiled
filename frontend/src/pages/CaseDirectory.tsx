import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, CheckCircle2, FileText, FolderClosed, LayoutGrid, List, Plus, Search, Trash2, X } from 'lucide-react';

export type CaseEntry = {
  id: string;
  name: string;
  created: string;
  state: string;
  analyzed: number;
  documentCount: number;
};

export function caseStatus(item: CaseEntry) {
  if (item.state === 'failed') return { label: 'Needs attention', tone: 'attention' };
  if (['indexing', 'analyzing', 'reporting'].includes(item.state)) return { label: 'In progress', tone: 'progress' };
  if (item.analyzed) return { label: 'Analyzed', tone: 'analyzed' };
  if (item.documentCount) return { label: 'Ready for analysis', tone: 'ready' };
  return { label: 'Awaiting evidence', tone: 'empty' };
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const filters = ['All cases', 'Analyzed', 'Needs attention'] as const;

type DirectoryProps = {
  cases: CaseEntry[];
  loading: boolean;
  pending: boolean;
  error: string;
  onOpen: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
};

export function CaseDirectory({ cases, loading, pending, error, onOpen, onCreate, onDelete }: DirectoryProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<typeof filters[number]>('All cases');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<CaseEntry>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const matching = cases.filter((item) => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
    (filter === 'All cases' || caseStatus(item).label === filter));

  async function create(event: FormEvent) {
    event.preventDefault();
    if (await onCreate(name.trim())) {
      dialog.current?.close();
      setName('');
    }
  }

  async function confirmDelete(event: FormEvent) {
    event.preventDefault();
    if (!target || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await onDelete(target.id);
      setAnnouncement(`Deleted ${target.name}.`);
      deleteDialog.current?.close();
    } catch (failure) {
      setDeleteError(failure instanceof Error ? failure.message : 'The case could not be deleted.');
    } finally {
      setDeleting(false);
    }
  }

  return <main className="td-directory">
    <section className="td-directory-hero" aria-labelledby="td-directory-title">
      <div className="td-hero-art" aria-hidden="true"><i /><i /><i /><em /><em /><b /><b /><b /></div>
      <div className="td-directory-intro">
        <h1 id="td-directory-title">Case directory</h1>
        <p>Open a case to review its evidence, trace events, and write findings.</p>
        <button className="td-new-case" type="button" disabled={loading || pending} onClick={() => { dialog.current?.showModal(); setCreating(true); }}><Plus size={18} /> New case</button>
      </div>
      <dl className="td-directory-stats">
        <div><dt><FolderClosed size={15} /> Cases</dt><dd>{cases.length}</dd></div>
        <div><dt><FileText size={15} /> Documents</dt><dd>{cases.reduce((total, item) => total + item.documentCount, 0)}</dd></div>
        <div><dt><CheckCircle2 size={15} /> Analyzed</dt><dd>{cases.filter((item) => caseStatus(item).tone === 'analyzed').length}</dd></div>
      </dl>
    </section>

    {error && !creating && <div className="td-alert" role="alert">{error}</div>}
    <p className="sr-only" role="status">{announcement}</p>
    <section aria-labelledby="td-investigations-title" className="td-directory-body">
      <div className="td-directory-heading">
        <h2 id="td-investigations-title">Investigations <span>{matching.length}</span></h2>
        <div className="td-directory-actions">
          <label className="td-directory-search"><Search size={17} /><input type="search" aria-label="Search cases" placeholder="Search by case name" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="td-view-toggle" role="group" aria-label="Case directory layout">
            <button type="button" aria-label="Grid view" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><LayoutGrid size={16} /></button>
            <button type="button" aria-label="List view" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={18} /></button>
          </div>
        </div>
      </div>
      <div className="td-directory-filters" role="group" aria-label="Filter cases">
        {filters.map((item) => <button key={item} type="button" aria-pressed={item === filter} onClick={() => setFilter(item)}>{item}</button>)}
      </div>
      {loading ? <div className="td-empty" role="status">Loading cases…</div> : matching.length ? (
        <ul className={`td-case-list td-case-list-${layout}`}>
          {matching.map((item) => {
            const status = caseStatus(item);
            return <li key={item.id} className="td-case-entry">
              <button type="button" className="td-case-card" onClick={() => onOpen(item.id)}>
                <span className="td-card-top"><span className="td-folder-icon"><FolderClosed size={21} /></span><span className={`td-case-status td-tone-${status.tone}`}>{status.label}</span></span>
                <strong>{item.name}</strong>
                <span className="td-card-meta"><span><FileText size={14} /> {item.documentCount} {item.documentCount === 1 ? 'document' : 'documents'}</span><time dateTime={item.created}>{dateFormat.format(new Date(item.created))}</time></span>
                <span className="td-card-open">Open case <ArrowUpRight size={16} /></span>
              </button>
              <button type="button" className="td-case-delete" aria-label={`Delete ${item.name}`}
                title={status.tone === 'progress' ? 'Wait for the case job to finish' : 'Delete case'}
                disabled={pending || status.tone === 'progress'} onClick={() => {
                  setTarget(item);
                  setDeleteError('');
                  deleteDialog.current?.showModal();
                }}><Trash2 size={16} /></button>
            </li>;
          })}
        </ul>
      ) : <div className="td-empty"><FolderClosed size={26} /><p>{cases.length ? 'No cases match your search.' : 'No cases yet. Create one to start adding evidence.'}</p>
        {cases.length > 0 && <button type="button" className="td-link" onClick={() => { setQuery(''); setFilter('All cases'); }}>Clear filters <ArrowRight size={14} /></button>}
      </div>}
    </section>

    <dialog className="td-create-dialog" ref={dialog} onClose={() => setCreating(false)} aria-labelledby="td-create-title">
      <form onSubmit={create}>
        <div className="td-create-heading"><h2 id="td-create-title">New case</h2><button type="button" aria-label="Close" disabled={pending} onClick={() => dialog.current?.close()}><X size={20} /></button></div>
        <label htmlFor="td-case-name">Case name</label>
        <input id="td-case-name" autoFocus required maxLength={160} placeholder="e.g. Room 214 investigation" value={name} onChange={(event) => setName(event.target.value)} />
        {error && <p className="td-alert" role="alert">{error}</p>}
        <button type="submit" className="td-primary" disabled={!name.trim() || pending}><Plus size={16} /> {pending ? 'Creating…' : 'Create case'}</button>
      </form>
    </dialog>
    <dialog className="td-create-dialog" ref={deleteDialog} aria-labelledby="td-delete-title" aria-describedby="td-delete-description"
      onCancel={(event) => { if (deleting) event.preventDefault(); }} onClose={() => setTarget(undefined)}>
      <form onSubmit={confirmDelete}>
        <div className="td-create-heading"><h2 id="td-delete-title">Delete case?</h2></div>
        <p id="td-delete-description">Permanently delete <strong>{target?.name}</strong>, its uploaded evidence, and its saved analysis and report from this workspace?</p>
        {deleteError && <p className="td-alert" role="alert">{deleteError}</p>}
        <div className="td-delete-actions">
          <button type="button" className="td-secondary" autoFocus disabled={deleting} onClick={() => deleteDialog.current?.close()}>Cancel</button>
          <button type="submit" className="td-primary td-danger" disabled={deleting || !target}><Trash2 size={16} /> {deleting ? 'Deleting…' : 'Delete case'}</button>
        </div>
      </form>
    </dialog>
  </main>;
}
