import { spawn } from 'node:child_process';
import { readWordText } from './ingestion.mjs';

export const imageTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

function runPdfTool(program, args, content) {
  return new Promise((resolve, reject) => {
    const process = spawn(program, args, { windowsHide: true, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    process.stderr.resume();
    process.stdin.on('error', () => {});
    process.once('error', reject);
    process.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 12 * 1024 * 1024) chunks.push(chunk);
      else process.kill();
    });
    process.once('close', (code) => {
      if (code !== 0 || !size) reject(new Error('The PDF page could not be rendered.'));
      else resolve(Buffer.concat(chunks));
    });
    process.stdin.end(content);
  });
}

export async function describePreview(file) {
  if (imageTypes[file.type]) return { kind: 'image' };
  if (file.type === '.pdf') {
    try {
      const info = await runPdfTool('pdfinfo', ['-'], file.content);
      const pages = Number(/^Pages:\s+(\d+)/m.exec(info.toString())?.[1]);
      if (pages > 0) return { kind: 'pdf', pages };
    } catch { /* The browser can open the original PDF when local rendering is unavailable. */ }
    return { kind: 'pdf', pages: null };
  }
  if (file.type === '.docx') return { kind: 'word', text: await readWordText(file.content) };
  return { kind: 'text', text: new TextDecoder().decode(file.content) };
}

export function renderPdfPage(content, page) {
  return runPdfTool('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1500', '-png', '-'], content);
}
