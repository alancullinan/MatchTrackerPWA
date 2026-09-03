/**
 * Backup/export tests.
 *
 * The export path is the only thing that protects against a lost, wiped or
 * replaced phone - on-device storage, however durable, does not. It is also the
 * path that is hardest to verify by hand, because its real target is an
 * installed iOS PWA where a synthetic `<a download>` click can silently produce
 * nothing at all.
 *
 * What is pinned here:
 *   1. a completed share records lastBackupAt, and hands over ONE .json file
 *      whose contents actually round-trip
 *   2. a DISMISSED share does not record a backup - the sheet rejects with
 *      AbortError, and treating that as success would make the staleness
 *      indicator claim a backup that never left the device
 *   3. a browser without share support still exports (download fallback) and
 *      still records the backup
 *   4. lastBackupAt survives a reload, since a timestamp that resets on relaunch
 *      would be worse than none
 *
 * Case 2 is the subtle one and the reason this file exists.
 *
 * Safety: serves a TEMP COPY of the repo, never the working tree.
 *
 * Run with:  npm test
 */

const puppeteer = require('puppeteer');
const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const PORT = 8201;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
};

// ---------------------------------------------------------------- utilities

let failures = 0;
let passes = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { passes++; console.log(`    PASS  ${label}`); }
  else { failures++; console.log(`    FAIL  ${label}\n            expected: ${expected}\n            actual:   ${actual}`); }
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(state) {
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.join(state.dir, rel);
    if (!file.startsWith(state.dir)) { res.writeHead(403).end(); return; }
    try {
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function materialise(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const roots = ['index.html', 'script.js', 'styles.css', 'tailwind-minimal.css',
                 'sw.js', 'manifest.json'];
  for (const f of roots) {
    await fsp.copyFile(path.join(REPO, f), path.join(dir, f));
  }
  for (const d of ['icons', 'fonts']) {
    await fsp.cp(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
}

/** Keep the service worker out of it; this suite is about the export path. */
async function disableServiceWorker(dir) {
  const idxPath = path.join(dir, 'index.html');
  let idx = await fsp.readFile(idxPath, 'utf8');
  idx = idx.replace(/navigator\.serviceWorker\.register/g, 'window.__swDisabled');
  await fsp.writeFile(idxPath, idx);
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  return page;
}

const url = () => `http://localhost:${PORT}/`;

async function waitForBoot(page) {
  await page.waitForFunction(() => !!document.getElementById('home-matches-btn'),
                             { timeout: 10000 }).catch(() => {});
  await sleep(500);
}

async function clearOrigin(page) {
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('MatchTrackerDB');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
}

/**
 * Install a fake Web Share API before any app code runs.
 *
 * `outcome: 'ok'` resolves (a completed share); 'abort' rejects with AbortError
 * exactly as a dismissed sheet does. The shared file is captured - including its
 * text - so the test can assert what would actually have left the device.
 */
function stubShare(page, outcome) {
  return page.evaluateOnNewDocument((mode) => {
    window.__shared = [];
    navigator.canShare = () => true;
    navigator.share = async (data) => {
      const files = data.files || [];
      const captured = [];
      for (const f of files) {
        captured.push({ name: f.name, type: f.type, text: await f.text() });
      }
      window.__shared.push({ title: data.title, text: data.text, files: captured });
      if (mode === 'abort') {
        const e = new Error('Share canceled');
        e.name = 'AbortError';
        throw e;
      }
    };
  }, outcome);
}

/** Remove Web Share entirely, to exercise the download fallback. */
function stubNoShare(page) {
  return page.evaluateOnNewDocument(() => {
    delete navigator.share;
    delete navigator.canShare;
    // Neutralise the actual download so the run does not litter the disk.
    const realClick = HTMLAnchorElement.prototype.click;
    window.__downloads = [];
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__downloads.push(this.download); return; }
      return realClick.apply(this, arguments);
    };
  });
}

/** Put one real match into state so an export has something to carry. */
async function seedMatch(page) {
  await page.evaluate(async () => {
    await window.__mtTest.saveData('matches', [{
      id: 'bk-1',
      team1: { id: 't1', name: 'Home', players: [] },
      team2: { id: 't2', name: 'Away', players: [] },
      competition: 'Backup Cup', matchType: 'football',
      events: [], currentPeriod: 'notStarted', elapsedTime: 0, isPaused: true,
    }]);
  });
}

// ------------------------------------------------------------------- tests

/** A completed share hands over a usable file and records the backup. */
async function testCompletedShareRecordsBackup(browser) {
  console.log('\n  a completed share exports the data and records the backup');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await stubShare(page, 'ok');
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);
  await seedMatch(page);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const before = await page.evaluate(() => window.__mtTest.lastBackupAt());
  check('no backup recorded before exporting', before, null);

  const result = await page.evaluate(async () => {
    const r = await window.__mtTest.exportData();
    return { r, shared: window.__shared, after: window.__mtTest.lastBackupAt() };
  });

  check('export reports success', result.r.success, true);
  check('exactly one file was shared', result.shared.length === 1 && result.shared[0].files.length === 1, true);

  const file = result.shared[0].files[0];
  check('the file is JSON', file.type, 'application/json');
  // Timestamped to the minute, so two exports in one day cannot collide.
  check('filename is timestamped to the minute',
        /^match-tracker-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(file.name), true);
  // The share text is what identifies a backup found in a chat months later.
  check('share text names the payload', /1 match/.test(result.shared[0].text), true);

  // The payload must actually contain the data, not just be well-named.
  let parsed = null;
  try { parsed = JSON.parse(file.text); } catch { /* leave null */ }
  check('payload parses as JSON', parsed !== null, true);
  check('payload carries the match', parsed && parsed.matches.length === 1 && parsed.matches[0].id === 'bk-1', true);
  check('payload carries all three state keys',
        !!(parsed && parsed.matches && parsed.playerPanels && parsed.lastSelectedPanels !== undefined), true);

  check('a backup timestamp was recorded', typeof result.after === 'string' && result.after.length > 0, true);
  await page.close();
}

/**
 * THE ONE THAT MATTERS. Dismissing the share sheet must NOT count as a backup:
 * nothing left the device, so claiming otherwise would make the staleness
 * indicator actively misleading at the moment it matters most.
 */
async function testDismissedShareRecordsNothing(browser) {
  console.log('\n  dismissing the share sheet does not record a backup');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await stubShare(page, 'abort');
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);
  await seedMatch(page);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const result = await page.evaluate(async () => {
    const r = await window.__mtTest.exportData();
    return { r, after: window.__mtTest.lastBackupAt() };
  });

  check('export reports failure', result.r.success, false);
  check('and is flagged as cancelled, not an error', result.r.cancelled, true);
  check('no backup timestamp was recorded', result.after, null);

  // And it must stay unrecorded across a reload.
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);
  const persisted = await page.evaluate(() => window.__mtTest.lastBackupAt());
  check('still no backup after reload', persisted, null);
  await page.close();
}

/** No Web Share support: the download fallback must still work and count. */
async function testDownloadFallbackRecordsBackup(browser) {
  console.log('\n  the download fallback still exports and records the backup');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await stubNoShare(page);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);
  await seedMatch(page);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const result = await page.evaluate(async () => {
    const r = await window.__mtTest.exportData();
    return { r, downloads: window.__downloads, after: window.__mtTest.lastBackupAt() };
  });

  check('export reports success', result.r.success, true);
  check('a download was triggered', result.downloads.length, 1);
  check('the download is timestamped',
        /^match-tracker-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(result.downloads[0] || ''), true);
  check('a backup timestamp was recorded', typeof result.after === 'string', true);
  await page.close();
}

/** The timestamp is only useful if it outlives the session that set it. */
async function testBackupTimestampSurvivesReload(browser) {
  console.log('\n  the backup timestamp survives a relaunch');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await stubShare(page, 'ok');
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);
  await seedMatch(page);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const recorded = await page.evaluate(async () => {
    await window.__mtTest.exportData();
    return window.__mtTest.lastBackupAt();
  });

  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const after = await page.evaluate(() => ({
    stamp: window.__mtTest.lastBackupAt(),
    days: window.__mtTest.daysSinceBackup(),
  }));

  check('the timestamp is unchanged after reload', after.stamp, recorded);
  check('and reads as a fresh backup', after.days, 0);
  await page.close();
}

// -------------------------------------------------------------------- main

(async () => {
  const state = { dir: await fsp.mkdtemp(path.join(os.tmpdir(), 'mt-backuptest-')) };
  let server, browser;
  try {
    await materialise(state.dir);
    await disableServiceWorker(state.dir);
    server = await startServer(state);
    browser = await puppeteer.launch({ headless: 'new' });

    console.log(`backup/export tests  (serving a copy at :${PORT})`);
    await testCompletedShareRecordsBackup(browser);
    await testDismissedShareRecordsNothing(browser);
    await testDownloadFallbackRecordsBackup(browser);
    await testBackupTimestampSurvivesReload(browser);
  } catch (err) {
    failures++;
    console.error('\n  harness error:', err && err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
    await fsp.rm(state.dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
