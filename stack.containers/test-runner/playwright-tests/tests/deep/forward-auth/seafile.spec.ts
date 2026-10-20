import { test, type Page, type Frame } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import { inflateRawSync } from 'zlib';
import {
  authenticatedSessionState, readSeafileOnlyOfficeFixture, screenshotRoot, testForwardAuthService,
} from '../shared/forward-auth';
import { serviceUrl } from '../../../utils/stack-urls';

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message); // Never include API bodies, URLs/tokens or document contents.
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded OOXML verification, not ZIP extraction or an editor appearance check. */
export function docxText(archive: Buffer): string {
  requireCondition(archive.length >= 22 && archive.length <= 4 * 1024 * 1024, 'Invalid DOCX archive size');
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50 && i + 22 + archive.readUInt16LE(i + 20) === archive.length) { end = i; break; }
  }
  requireCondition(end >= 0, 'DOCX central directory missing');
  requireCondition(archive.readUInt16LE(end + 4) === 0 && archive.readUInt16LE(end + 6) === 0, 'Multidisk DOCX rejected');
  const count = archive.readUInt16LE(end + 10);
  requireCondition(count > 0 && count < 4096 && archive.readUInt16LE(end + 8) === count, 'DOCX entry count rejected');
  let cursor = archive.readUInt32LE(end + 16);
  const directoryEnd = cursor + archive.readUInt32LE(end + 12);
  requireCondition(directoryEnd === end, 'DOCX directory bounds mismatch');
  let xml: Buffer | undefined;
  for (let i = 0; i < count; i++) {
    requireCondition(cursor + 46 <= directoryEnd && archive.readUInt32LE(cursor) === 0x02014b50, 'Invalid DOCX directory entry');
    const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10);
    const packed = archive.readUInt32LE(cursor + 20), size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28), extra = archive.readUInt16LE(cursor + 30), comment = archive.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extra + comment;
    requireCondition(next <= directoryEnd && !(flags & 1) && archive.readUInt16LE(cursor + 34) === 0, 'Encrypted/malformed DOCX entry');
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === 'word/document.xml') {
      requireCondition(!xml && size <= 2 * 1024 * 1024 && packed <= 4 * 1024 * 1024 && (method === 0 || method === 8), 'Invalid/duplicate DOCX document entry');
      const offset = archive.readUInt32LE(cursor + 42);
      requireCondition(offset + 30 <= archive.readUInt32LE(end + 16) && archive.readUInt32LE(offset) === 0x04034b50, 'DOCX local header missing');
      requireCondition(archive.readUInt16LE(offset + 6) === flags && archive.readUInt16LE(offset + 8) === method, 'DOCX local header mismatch');
      const localNameLength = archive.readUInt16LE(offset + 26);
      const begin = offset + 30 + localNameLength + archive.readUInt16LE(offset + 28);
      requireCondition(archive.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') === name
        && begin + packed <= archive.readUInt32LE(end + 16), 'DOCX content bounds mismatch');
      const data = archive.subarray(begin, begin + packed);
      xml = method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: 2 * 1024 * 1024 });
      requireCondition(xml.length === size && crc32(xml) === archive.readUInt32LE(cursor + 16), 'DOCX content integrity mismatch');
    }
    cursor = next;
  }
  requireCondition(cursor === directoryEnd && xml, 'DOCX document XML missing');
  const rawText = xml.toString('utf8');
  requireCondition(!/<!DOCTYPE|<!ENTITY/i.test(rawText) && /<w:document\b/.test(rawText), 'Unsupported DOCX XML');
  const text = rawText.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  return Array.from(text.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g), (match) => match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')).join('');
}

function transferPath(raw: unknown, base: string, prefix: string): string {
  requireCondition(typeof raw === 'string', 'Seafile transfer link missing');
  const target = new URL(raw, base), origin = new URL(base);
  requireCondition(target.protocol === 'https:' && target.origin === origin.origin && !target.username && !target.password
    && !target.hash && target.pathname.startsWith(prefix) && !/%|\\/.test(target.pathname), 'Seafile transfer escaped owned HTTPS route');
  return target.toString(); // Never log this transient capability URL.
}

/** Existing scoped browser account only. Does not discover credentials or select old libraries. */
export async function seafileOnlyOfficeWorkflow(page: Page, options: {
  base: string; officeBase: string; fixture: Buffer; screenshots: string; runId?: string;
}): Promise<void> {
  const runId = options.runId ?? randomUUID();
  requireCondition(/^[a-zA-Z0-9-]{1,64}$/.test(runId), 'Invalid synthetic workflow ID');
  const base = new URL(options.base), office = new URL(options.officeBase);
  requireCondition(base.protocol === 'https:' && office.protocol === 'https:' && !base.username && !base.password
    && !office.username && !office.password && base.pathname === '/' && office.pathname === '/'
    && !base.search && !base.hash && !office.search && !office.hash, 'Canonical workflow HTTPS origins required');
  const libraryName = `retained-onlyoffice-${runId}`, docName = `proof-${runId}.docx`;
  const marker = `retained-editor-${runId}-saved`;
  requireCondition(!docxText(options.fixture).includes(marker), 'Synthetic edit marker already in source fixture');
  const workDeadline = Date.now() + 240000;
  const timeout = (cap = 15000) => {
    const remaining = workDeadline - Date.now();
    requireCondition(remaining > 0, 'Seafile workflow deadline exceeded');
    return Math.min(cap, remaining);
  };
  const api = (suffix: string) => new URL(suffix, base).toString();
  let repoId: string | undefined, editorPage: Page | undefined;
  let createdButUnbound = false;
  let primaryFailed = false;
  let primaryMessage = '';
  let stage = 'create-library';
  const boundedClose = async (target: Page, milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([target.close({ runBeforeUnload: false }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned editor close deadline exceeded')), milliseconds);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    // A timed-out browser RPC is not claimed cancelled; it is an explicit failed
    // cleanup, and only this disposable context/library is eligible for teardown.
  };
  const closeEditor = async () => {
    if (!editorPage) return;
    if (editorPage !== page) await boundedClose(editorPage, timeout());
    else await page.goto(api('/'), { waitUntil: 'domcontentloaded', timeout: timeout() });
    editorPage = undefined;
  };
  const openEditor = async (): Promise<Frame> => {
    await page.goto(api(`/library/${repoId}/${encodeURIComponent(libraryName)}/`), { waitUntil: 'domcontentloaded', timeout: timeout() });
    const doc = page.getByRole('link', { name: docName, exact: true });
    await doc.waitFor({ state: 'visible', timeout: timeout(30000) });
    const popup = page.context().waitForEvent('page', { timeout: timeout(3000) }).catch(() => null);
    await doc.dblclick({ timeout: timeout() });
    editorPage = (await popup) ?? page;
    while (true) {
      const frames = editorPage.frames().filter((frame) => {
        const url = new URL(frame.url() || 'about:blank');
        return url.origin === office.origin && /\/web-apps\/apps\/documenteditor\//.test(url.pathname);
      });
      requireCondition(frames.length <= 1, 'Ambiguous OnlyOffice document editor');
      if (frames.length === 1 && await frames[0].locator('#editor_sdk').isVisible()) return frames[0];
      await page.waitForTimeout(Math.min(250, timeout()));
    }
  };
  const download = async (): Promise<Buffer> => {
    const response = await page.request.get(api(`/api2/repos/${repoId}/file/?p=/${encodeURIComponent(docName)}&reuse=0`),
      { timeout: timeout(), maxRedirects: 0 });
    requireCondition(response.status() === 200, 'Seafile download-link request failed');
    const target = transferPath(await response.json(), base.origin, '/seafhttp/files/');
    const body = await page.request.get(target, { timeout: timeout(), maxRedirects: 0 });
    requireCondition(body.status() === 200, 'Seafile document download failed');
    return body.body();
  };
  const waitForSavedMarker = async () => {
    while (true) {
      const text = docxText(await download());
      if (text.includes(marker)) return;
      await page.waitForTimeout(Math.min(500, timeout()));
    }
  };
  try {
    createdButUnbound = true; // Lost create response may still have allocated a library.
    const created = await page.request.post(api('/api2/repos/'), {
      form: { name: libraryName, desc: 'Disposable synthetic OnlyOffice edit/save acceptance' },
      headers: { Referer: base.origin }, timeout: timeout(), maxRedirects: 0,
    });
    if ([400, 401, 403, 404, 422].includes(created.status())) createdButUnbound = false;
    requireCondition(created.status() === 200 || created.status() === 201, 'Synthetic Seafile library creation failed; no existing-library fallback');
    const model = await created.json();
    const candidate = model.repo_id ?? model.id;
    requireCondition(typeof candidate === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(candidate)
      && (model.repo_name ?? model.name) === libraryName, 'New Seafile library identity mismatch; requires owned cleanup review');
    repoId = candidate;
    createdButUnbound = false;
    stage = 'upload-synthetic-docx';
    const uploadLink = await page.request.get(api(`/api2/repos/${repoId}/upload-link/?p=/`), { timeout: timeout(), maxRedirects: 0 });
    requireCondition(uploadLink.status() === 200, 'Seafile upload-link request failed');
    const target = transferPath(await uploadLink.json(), base.origin, '/seafhttp/upload-api/');
    const uploaded = await page.request.post(target, {
      multipart: { parent_dir: '/', replace: '0', file: { name: docName,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: options.fixture } },
      timeout: timeout(), maxRedirects: 0,
    });
    requireCondition(uploaded.status() === 200, 'Synthetic DOCX upload failed');
    requireCondition((await download()).equals(options.fixture), 'Uploaded DOCX bytes did not round-trip');
    stage = 'edit-real-onlyoffice-document';
    const frame = await openEditor();
    const canvas = frame.locator('#editor_sdk');
    await canvas.click({ position: { x: 240, y: 180 }, timeout: timeout() });
    await editorPage!.keyboard.press('Control+End');
    await editorPage!.keyboard.press('Enter');
    await editorPage!.keyboard.insertText(marker);
    await editorPage!.keyboard.press('Control+s');
    // Close real editing session so OnlyOffice's supported save callback flushes
    // into Seafile. The download, NOT toolbar/iframe visibility, proves save.
    stage = 'flush-save-callback-and-verify-downloaded-content';
    await closeEditor();
    await waitForSavedMarker();
    const persisted = await download();
    requireCondition(!persisted.equals(options.fixture), 'OnlyOffice edit did not change source document');
    stage = 'reopen-and-find-persisted-content';
    const reopened = await openEditor();
    // Ctrl+f uses the actual OnlyOffice search UI to verify the persisted document
    // has loaded into a fresh editor, rather than merely reopening its iframe.
    await reopened.locator('#editor_sdk').click({ position: { x: 240, y: 180 }, timeout: timeout() });
    await editorPage!.keyboard.press('Control+f');
    const search = reopened.locator('#search-input');
    await search.waitFor({ state: 'visible', timeout: timeout() });
    await search.fill(marker, { timeout: timeout() });
    await search.press('Enter', { timeout: timeout() });
    // Download verification remains authoritative; this native UI selector must
    // be checked against pinned OnlyOffice8.3.3 in the isolated installed run.
    const result = reopened.locator('#search-label');
    while (true) {
      const label = (await result.innerText({ timeout: timeout() })).trim();
      if (/^1\s*(?:of|\/)\s*1$/i.test(label)) break;
      await page.waitForTimeout(Math.min(250, timeout()));
    }
    await editorPage!.keyboard.press('Escape');
    requireCondition(docxText(await download()).includes(marker), 'Reopened Seafile document lost saved content');
    fs.mkdirSync(options.screenshots, { recursive: true });
    const screenshot = await editorPage!.screenshot({ path: path.join(options.screenshots, `onlyoffice-${runId}.png`),
      fullPage: true, type: 'png', timeout: timeout() });
    // Generic provenance only: no capability URLs, body dumps or document contents.
    test.info().annotations.push({ type: 'retained-onlyoffice-save-reopen',
      description: `synthetic-run=${runId}; docx-sha256=${createHash('sha256').update(persisted).digest('hex')}; screenshot-sha256=${createHash('sha256').update(screenshot).digest('hex')}; review-required` });
  } catch {
    primaryFailed = true;
    primaryMessage = `Seafile/OnlyOffice synthetic stage ${stage} failed (private details withheld)`;
  } finally {
    const cleanupDeadline = Date.now() + 30000;
    const cleanupTimeout = () => {
      const left = cleanupDeadline - Date.now();
      requireCondition(left > 0, 'Owned Seafile cleanup deadline exceeded');
      return Math.min(10000, left);
    };
    let cleanupFailed = createdButUnbound;
    try {
      if (editorPage && editorPage !== page) await boundedClose(editorPage, cleanupTimeout());
      else if (editorPage) await page.goto(api('/'), { waitUntil: 'domcontentloaded', timeout: cleanupTimeout() });
    } catch { cleanupFailed = true; }
    if (repoId) {
      try {
        const deleted = await page.request.delete(api(`/api2/repos/${repoId}/`), { timeout: cleanupTimeout(), maxRedirects: 0 });
        requireCondition([200, 204, 404].includes(deleted.status()), 'Owned Seafile library delete failed');
        const absent = await page.request.get(api(`/api2/repos/${repoId}/`), { timeout: cleanupTimeout(), maxRedirects: 0 });
        requireCondition(absent.status() === 404, 'Owned Seafile library still exists after cleanup');
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new Error(`Seafile owned cleanup incomplete; review synthetic-run=${runId} before retry (details withheld)`);
  }
  if (primaryFailed) throw new Error(primaryMessage);
}

test.use({ storageState: authenticatedSessionState });
test('Seafile - Access with forward auth', async ({ page }) => {
  test.setTimeout(300000);
  await testForwardAuthService(page, 'Seafile', serviceUrl('seafile'), /Seafile|Libraries|My Libraries/i, {
    waitForSelectorVisible: 'text=/Libraries|My Libraries|Shared with me|Favorites/i', waitForSelectorTimeoutMs: 30000,
    onAfterLoad: async (authenticatedPage: Page) => seafileOnlyOfficeWorkflow(authenticatedPage, {
      base: serviceUrl('seafile'), officeBase: serviceUrl('onlyoffice'), fixture: readSeafileOnlyOfficeFixture(),
      screenshots: path.join(screenshotRoot, 'seafile'),
    }),
  });
});
