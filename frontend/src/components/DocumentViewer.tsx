import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';

export type DocumentSelection = { id: string; name: string; locator?: string };
type Preview =
  | { kind: 'image' }
  | { kind: 'pdf'; pages: number | null }
  | { kind: 'text' | 'word'; text: string };

export function DocumentViewer({ document, url, onClose }: {
  document: DocumentSelection;
  url: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [browserPdf, setBrowserPdf] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(url + '/preview', { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'This file could not be previewed.');
        if (controller.signal.aborted) return;
        const citedPage = Number(/\bpage\s+(\d+)\b/i.exec(document.locator || '')?.[1]) || 1;
        if (data.kind === 'pdf' && data.pages) setPage(Math.min(data.pages, citedPage));
        setPreview(data);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [url, document.locator]);

  const original = url + '/original';
  const displayPdfInBrowser = preview?.kind === 'pdf' && (!preview.pages || browserPdf);

  return (
    <dialog
      ref={dialog}
      className="td-viewer"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="td-viewer-shell">
        <header className="td-viewer-header">
          <div>
            <h2 id={titleId}>{document.name}</h2>
            {preview?.kind === 'word' && <p>Word body text preview · Download for the original layout</p>}
          </div>
          <div className="td-viewer-actions">
            <a className="td-secondary" href={original + '?download=1'} download><Download size={15} /> Download</a>
            <button className="td-secondary td-viewer-close" type="button" onClick={onClose} aria-label="Close document viewer" autoFocus><X size={19} /></button>
          </div>
        </header>
        {preview?.kind === 'pdf' && preview.pages && !browserPdf && (
          <div className="td-viewer-pages" aria-label="PDF page controls">
            <button className="td-secondary" disabled={page === 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft size={17} /></button>
            <span aria-live="polite">Page {page} of {preview.pages}</span>
            <button className="td-secondary" disabled={page === preview.pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight size={17} /></button>
          </div>
        )}
        <div className="td-viewer-content">
          {error && <p className="td-alert" role="alert">{error}</p>}
          {!preview && !error && <p role="status">Opening document…</p>}
          {preview?.kind === 'image' && !error && <img src={original} alt={document.name}
            onError={() => setError('This image could not be displayed. You can download the original.')} />}
          {preview?.kind === 'pdf' && !displayPdfInBrowser && <img key={page} src={url + '/page?number=' + page} alt={`${document.name}, page ${page}`}
            onError={() => setBrowserPdf(true)} />}
          {displayPdfInBrowser && <iframe title={document.name} src={original + '?inline=1#page=' + page} />}
          {preview?.kind === 'word' && <div className="td-viewer-paper">{preview.text.split('\n').map((line, index) => <p key={index}>{line}</p>)}</div>}
          {preview?.kind === 'text' && <pre>{preview.text}</pre>}
        </div>
      </div>
    </dialog>
  );
}
