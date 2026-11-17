import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { inputText, list, models, provider, record, string, structured } from './models.mjs';

const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const plain = new Set(['.txt', '.log', '.csv', '.json', '.md']);
const MAX_TEXT = 180_000;
export const visualLocator = 'Visual observations';

export async function inspectImage(content, type) {
  const attachment = { type: 'input_image', image_url: `data:${images[type]};base64,${Buffer.from(content).toString('base64')}`, detail: 'high' };
  return structured(models.extraction, 'image_evidence',
    'Read this image as evidence. Put readable characters in transcript, or return an empty transcript when there are no words. Independently write visual observations even when the image has no text. Describe visible objects, colors, count, position, and actions, or explain what is obscured. Use concrete searchable nouns. Do not guess identity, time, location, or the contents of closed objects. For a document screenshot, describe only relevant visual features.',
    [inputText('Extract the visible text and describe the visual evidence.'), attachment],
    record({ transcript: string, observations: string }));
}

export async function readWordText(content) {
  const directory = await mkdtemp(join(tmpdir(), 'text-detective-word-'));
  const path = join(directory, 'document.docx');
  try {
    await writeFile(path, content);
    return await readWordArchive(path);
  } finally {
    await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
}

function readWordArchive(path) {
  return new Promise((resolve, reject) => {
    const archive = spawn('tar', ['-xOf', path, 'word/document.xml'], {
      windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const xml = [];
    let size = 0;
    archive.stderr.resume();
    archive.once('error', () => reject(new Error('Install bsdtar to extract Word documents locally.')));
    archive.stdout.on('data', (part) => {
      size += part.length;
      if (size <= 4_000_000) xml.push(part);
      else archive.kill();
    });
    archive.once('close', (code) => {
      if (code !== 0) {
        reject(new Error('Could not read the Word document. Save it as a standard DOCX file and retry.'));
        return;
      }
      const source = Buffer.concat(xml).toString('utf8');
      const entities = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
      const paragraphs = [...source.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(([paragraph]) =>
        [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)].map(([, text, control]) => {
          if (control) return control === 'tab' ? '\t' : '\n';
          return text.replace(/&(amp|lt|gt|apos|quot|#x[0-9a-f]+|#\d+);/gi, (entity, value) => {
            if (!value.startsWith('#')) return entities[value] ?? entity;
            const point = value[1].toLowerCase() === 'x' ? Number.parseInt(value.slice(2), 16) : Number(value.slice(1));
            return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
          });
        }).join(''),
      ).filter((paragraph) => paragraph.trim());
      resolve(paragraphs.join('\n'));
    });
  });
}

export function validateFile(file) {
  const name = basename(file.name.replaceAll('\\', '/')).trim();
  const type = extname(name).toLowerCase();
  if (!plain.has(type) && !images[type] && type !== '.pdf' && type !== '.docx') {
    throw new Error('Choose a PDF, DOCX, supported image, or text file.');
  }
  if (file.size === 0 || file.size > 15 * 1024 * 1024) {
    throw new Error('Each file must contain data and be 15 MB or smaller.');
  }
  if (provider === 'Gemini' && type === '.gif') throw new Error('For Gemini, save the image as PNG, JPEG, or WebP.');
  if (provider === 'Gemini' && (images[type] || type === '.pdf') && file.size > 14 * 1024 * 1024) {
    throw new Error('Gemini image and PDF uploads must be 14 MB or smaller.');
  }
  return { name, type };
}

export async function extractDocument(file) {
  const { name, type } = validateFile(file);
  const content = Buffer.from(await file.arrayBuffer());
  const hash = createHash('sha256').update(content).digest('hex');
  let sections;
  if (plain.has(type)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content).trim();
    sections = [{ locator: 'Text', text }];
  } else if (type === '.docx') {
    sections = [{ locator: 'Document text', text: await readWordText(content) }];
  } else if (images[type]) {
    const { transcript, observations } = await inspectImage(content, type);
    sections = [{ locator: 'Image text', text: transcript }, { locator: visualLocator, text: observations }];
  } else {
    const base64 = content.toString('base64');
    const attachment = { type: 'input_file', filename: name, file_data: `data:application/pdf;base64,${base64}` };
    const extracted = await structured(models.extraction, 'document_transcription',
      'Transcribe evidence in reading order, retaining names, timestamps, and identifiers verbatim. Mark uncertain characters [unclear]. Label each unit with its PDF page position. Return full source text. Never guess missing text.',
      [inputText('Transcribe the attached case file.'), attachment],
      record({ sections: list(record({ locator: string, text: string })) }));
    sections = extracted.sections;
  }
  if (sections.reduce((size, section) => size + section.text.length, 0) > MAX_TEXT) {
    throw new Error('Extracted text is too long for one file. Split it into smaller files and retry.');
  }
  const chunks = [];
  for (const section of sections) {
    let start = 0;
    while (start < section.text.length) {
      let end = Math.min(start + 2200, section.text.length);
      if (end < section.text.length) {
        const boundary = section.text.lastIndexOf('\n', end);
        if (boundary > start + 1500) end = boundary;
      }
      const text = section.text.slice(start, end).trim();
      if (text) chunks.push({ id: randomUUID(), locator: section.locator, text });
      if (end === section.text.length) break;
      start = end - 200;
    }
  }
  if (!chunks.length) throw new Error('No readable evidence was extracted.');
  return { id: randomUUID(), name, hash, type, chunks, content };
}
