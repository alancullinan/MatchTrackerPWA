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
 * The import half covers the mirror-image problem: a backup used to be unable to
 * REPAIR a match, because importData merged by id and skipped anything already
 * present - while reporting success. Those cases pin conflict detection, both
 * resolutions, and that identical data is a silent no-op rather than a prompt.
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
      window.__shared.push({ keys: Object.keys(data).sort(), files: captured });
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
  // `files` must be the ONLY key. iOS "Save to Files" materialises any string
  // field (title AND text) as its own document, so the user gets a stray file
  // named "Text" beside every backup. Asserting the whole key set rather than
  // named fields - checking them one at a time is what let `title` through
  // after `text` was removed. Both shipped; confirmed on a real device.
  check('share passes files and nothing else',
        JSON.stringify(result.shared[0].keys), JSON.stringify(['files']));

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


// ------------------------------------------------------------ import tests

/**
 * Build a backup file in the page and hand it to the import path as a real
 * File, the way the picker would. Returns the analysis, so a test can assert
 * what an import WOULD do before anything is written.
 */
function analyzeBackup(page, payload) {
  return page.evaluate(async (data) => {
    const file = new File([JSON.stringify(data)], 'backup.json', { type: 'application/json' });
    const analysis = await window.__mtTest.analyzeImport(file);
    // Structured-clone safe summary plus the analysis itself for a follow-up apply.
    window.__lastAnalysis = analysis;
    return {
      newMatches: analysis.newMatches.map((m) => m.id),
      identical: analysis.identicalMatches.map((m) => m.id),
      conflicts: analysis.conflicts.map((c) => c.id),
      panelConflicts: analysis.panelConflicts.map((c) => c.id),
      newPanels: analysis.newPanels.map((p) => p.id),
    };
  }, payload);
}

/** Apply the analysis captured by analyzeBackup, with the given resolutions. */
function applyLast(page, resolutions) {
  return page.evaluate(async (res) => {
    const r = await window.__mtTest.applyImport(window.__lastAnalysis, res);
    return { message: r.message, success: r.success, changed: r.changed };
  }, resolutions);
}

/** A match with a controllable number of events, so two copies can differ. */
function matchWithEvents(id, name, eventCount) {
  const events = [];
  for (let i = 0; i < eventCount; i++) {
    events.push({ id: `${id}-e${i}`, type: 'shot', teamId: 't1', period: 'firstHalf', timeElapsed: i * 10 });
  }
  return {
    id,
    team1: { id: 't1', name: name, players: [] },
    team2: { id: 't2', name: 'Away', players: [] },
    competition: 'Test Cup', matchType: 'football',
    dateTime: '2026-08-12T15:00:00.000Z',
    events, currentPeriod: 'notStarted', elapsedTime: 0, isPaused: true,
  };
}

const backupOf = (matches, panels) => ({
  version: '1.0.0', exportDate: new Date().toISOString(),
  matches, matchCount: matches.length,
  playerPanels: panels || [], panelCount: (panels || []).length,
  lastSelectedPanels: {},
});

/** Seed the device with the given matches, through the real storage layer. */
async function seedMatches(page, matches) {
  await page.evaluate(async (ms) => {
    await window.__mtTest.saveData('matches', ms);
  }, matches);
}

/**
 * THE BUG. A match already present but DIFFERENT used to be lumped in with
 * duplicates and silently dropped, so a backup could never repair a corrupted
 * match - while the app reported success.
 */
async function testConflictIsDetected(browser) {
  console.log('\n  a differing match is reported as a conflict, not skipped');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  // Device holds a damaged copy (2 events); the backup holds the good one (9).
  await seedMatches(page, [matchWithEvents('m1', 'Cork', 2)]);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const a = await analyzeBackup(page, backupOf([matchWithEvents('m1', 'Cork', 9)]));
  check('the differing match is a conflict', JSON.stringify(a.conflicts), JSON.stringify(['m1']));
  check('and is not treated as new', a.newMatches.length, 0);
  check('and is not treated as identical', a.identical.length, 0);
  await page.close();
}

/** Keeping mine must leave the device copy exactly as it was. */
async function testKeepMineChangesNothing(browser) {
  console.log('\n  "keep mine" leaves the device copy untouched');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);
  await seedMatches(page, [matchWithEvents('m1', 'Cork', 2)]);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  await analyzeBackup(page, backupOf([matchWithEvents('m1', 'Cork', 9)]));
  const r = await applyLast(page, { m1: 'mine' });
  check('reports keeping it unchanged', /kept 1 unchanged/i.test(r.message), true);
  check('event count is still the device copy', await page.evaluate(() => window.__mtTest.eventCount('m1')), 2);

  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);
  check('and still is after a reload', await page.evaluate(() => window.__mtTest.eventCount('m1')), 2);
  await page.close();
}

/** The whole point: choosing the backup actually replaces the match. */
async function testUseBackupReplaces(browser) {
  console.log('\n  "use backup" replaces the match, and it sticks');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);
  await seedMatches(page, [matchWithEvents('m1', 'Cork', 2)]);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  await analyzeBackup(page, backupOf([matchWithEvents('m1', 'Cork', 9)]));
  const r = await applyLast(page, { m1: 'theirs' });
  check('reports the replacement', /replaced 1/i.test(r.message), true);
  check('event count is now the backup copy', await page.evaluate(() => window.__mtTest.eventCount('m1')), 9);

  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);
  check('and survives a reload', await page.evaluate(() => window.__mtTest.eventCount('m1')), 9);
  // Replaced, not duplicated.
  check('the match was replaced, not added alongside',
        (await page.evaluate(() => window.__mtTest.matchIds())).length, 1);
  await page.close();
}

/**
 * Cancelling must write NOTHING - not even the non-conflicting matches that
 * came in the same file. A partial write on cancel would be its own trap.
 */
async function testCancelWritesNothing(browser) {
  console.log('\n  cancelling imports nothing at all');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);
  await seedMatches(page, [matchWithEvents('m1', 'Cork', 2)]);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  // A file with one conflict AND one genuinely new match.
  await analyzeBackup(page, backupOf([
    matchWithEvents('m1', 'Cork', 9),
    matchWithEvents('m2', 'Clare', 5),
  ]));
  // Cancelling means applyImport is never called at all - assert that state is
  // untouched, which is what the UI guarantees by returning null.
  const ids = await page.evaluate(() => window.__mtTest.matchIds());
  check('no new match was added by analysis alone', JSON.stringify(ids), JSON.stringify(['m1']));
  check('and the existing match is untouched', await page.evaluate(() => window.__mtTest.eventCount('m1')), 2);
  await page.close();
}

/** Re-importing the same backup must be a silent no-op, not a prompt. */
async function testIdenticalIsNotAConflict(browser) {
  console.log('\n  re-importing the same backup is a no-op, not a conflict');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const match = matchWithEvents('m1', 'Cork', 4);
  await seedMatches(page, [match]);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const a = await analyzeBackup(page, backupOf([match]));
  check('no conflict is raised', a.conflicts.length, 0);
  check('it is recognised as identical', JSON.stringify(a.identical), JSON.stringify(['m1']));

  const r = await applyLast(page, {});
  check('and reports that nothing changed', r.changed, false);
  check('with an honest message', /nothing to import/i.test(r.message), true);
  await page.close();
}

/** Genuinely new matches still import, unchanged from before. */
async function testNewMatchesStillImport(browser) {
  console.log('\n  new matches still import normally');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);
  await seedMatches(page, [matchWithEvents('m1', 'Cork', 2)]);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const a = await analyzeBackup(page, backupOf([matchWithEvents('m2', 'Clare', 3)]));
  check('the unseen match is new', JSON.stringify(a.newMatches), JSON.stringify(['m2']));
  check('and raises no conflict', a.conflicts.length, 0);

  const r = await applyLast(page, {});
  check('it is imported', /imported 1 new match/i.test(r.message), true);
  check('both matches are now present',
        (await page.evaluate(() => window.__mtTest.matchIds())).length, 2);
  await page.close();
}

/** Panels carry the same skip-by-id bug and get the same treatment. */
async function testPanelConflicts(browser) {
  console.log('\n  panels conflict the same way matches do');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const mkPanel = (id, name, filled) => ({
    id, name,
    players: Array.from({ length: 30 }, (_, i) => ({
      id: `${id}-p${i}`, name: i < filled ? `Player ${i}` : '', jerseyNumber: i + 1,
    })),
  });

  await page.evaluate(async (p) => {
    await window.__mtTest.saveData('playerPanels', [p]);
  }, mkPanel('pan1', 'Seniors', 3));
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const a = await analyzeBackup(page, backupOf([], [mkPanel('pan1', 'Seniors', 20)]));
  check('the differing panel is a conflict', JSON.stringify(a.panelConflicts), JSON.stringify(['pan1']));
  check('and is not added as a new panel', a.newPanels.length, 0);

  await applyLast(page, { pan1: 'theirs' });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);
  check('the panel was replaced, not duplicated',
        await page.evaluate(() => window.__mtTest.panelCount()), 1);
  await page.close();
}


/**
 * The Data Management modal must STAY OPEN after an import.
 *
 * It used to close itself two seconds after a successful import. That was
 * tolerable when the message was a simple count, but the result can now report
 * destructive work ("replaced 1, kept 2 unchanged") and there is no way to see
 * that summary again once the modal is gone.
 *
 * Drives the real DOM - the picker, the buttons - because this is UI behaviour
 * the data-layer tests above cannot see.
 */
async function testModalStaysOpenAfterImport(browser) {
  console.log('\n  the import modal stays open so the summary can be read');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  await seedMatches(page, [matchWithEvents('m1', 'Cork', 2)]);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  await page.evaluate(() => document.getElementById('home-data-management-btn').click());
  await sleep(300);

  // A purely additive import, so no conflict modal interrupts the flow.
  const payload = backupOf([matchWithEvents('m2', 'Clare', 4)]);
  const tmp = path.join(os.tmpdir(), 'mt-modal-import.json');
  await fsp.writeFile(tmp, JSON.stringify(payload));
  const input = await page.$('#import-file-input');
  await input.uploadFile(tmp);
  await sleep(300);
  await page.evaluate(() => document.getElementById('import-data-btn').click());
  await sleep(700);

  const read = () => page.evaluate(() => ({
    open: document.getElementById('data-management-modal').classList.contains('flex'),
    status: document.getElementById('import-status').textContent,
    selectBtn: document.getElementById('select-import-file-btn').textContent,
  }));

  const justAfter = await read();
  check('the import reports what it did', /imported 1 new match/i.test(justAfter.status), true);
  check('the modal is open immediately after', justAfter.open, true);

  // The old behaviour closed at 2000ms; wait well past that.
  await sleep(3500);
  const later = await read();
  check('and is STILL open after the old 2s auto-close', later.open, true);
  check('with the summary still readable', later.status, justAfter.status);
  // The picker is reset so another import can be started without reopening.
  check('the file picker was reset', later.selectBtn, 'Select Import File');

  await fsp.rm(tmp, { force: true }).catch(() => {});
  await page.close();
}


/**
 * The export result must name everything the file carries, not just matches.
 *
 * Reporting only the match count meant a user with panels could not tell whether
 * they were in the backup, and a panels-only export read as "Exported 0
 * matches" - which looks like a failure when it is nothing of the kind.
 */
async function testExportReportsPanelsToo(browser) {
  console.log('\n  the export result names panels as well as matches');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);
  await stubShare(page, 'ok');
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const panel = (id, name) => ({
    id, name,
    players: Array.from({ length: 30 }, (_, i) => ({
      id: `${id}-p${i}`, name: i < 5 ? `Player ${i}` : '', jerseyNumber: i + 1,
    })),
  });

  // Matches AND panels.
  await page.evaluate(async (p) => {
    await window.__mtTest.saveData('playerPanels', [p[0], p[1]]);
  }, [panel('pan1', 'Seniors'), panel('pan2', 'U21')]);
  await seedMatch(page);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const both = await page.evaluate(async () => (await window.__mtTest.exportData()).message);
  check('reports both counts', both, 'Exported 1 match and 2 panels');

  // Panels only - the case that used to read as "Exported 0 matches".
  await page.evaluate(async () => { await window.__mtTest.saveData('matches', []); });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);
  const panelsOnly = await page.evaluate(async () => (await window.__mtTest.exportData()).message);
  check('still names the panels with no matches', panelsOnly, 'Exported 0 matches and 2 panels');

  // No panels - the message must not gain an empty clause.
  await page.evaluate(async () => {
    await window.__mtTest.saveData('playerPanels', []);
    await window.__mtTest.saveData('matches', []);
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForBoot(page);
  const neither = await page.evaluate(async () => (await window.__mtTest.exportData()).message);
  check('omits panels entirely when there are none', neither, 'Exported 0 matches');

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
    await testExportReportsPanelsToo(browser);
    await testConflictIsDetected(browser);
    await testKeepMineChangesNothing(browser);
    await testUseBackupReplaces(browser);
    await testCancelWritesNothing(browser);
    await testIdenticalIsNotAConflict(browser);
    await testNewMatchesStillImport(browser);
    await testPanelConflicts(browser);
    await testModalStaysOpenAfterImport(browser);
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
