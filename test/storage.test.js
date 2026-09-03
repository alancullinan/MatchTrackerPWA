/**
 * Storage-layer tests: the silent data-loss path and the one-time migration.
 *
 * These exist because the app used to keep TWO independent stores. It wrote
 * localStorage-first with an IndexedDB fallback, but read localStorage-first and
 * returned immediately if anything was there. Once localStorage filled up, new
 * saves diverted to IndexedDB while every subsequent launch kept returning the
 * older localStorage copy - so recently recorded matches vanished from the UI
 * despite having been saved successfully. Nothing surfaced it to the user.
 *
 * The fix was to stop using two stores. What is pinned here:
 *   1. a save still survives a reload when localStorage cannot be written
 *      (the original bug - verified by reverting the fix and watching it fail)
 *   2. the one-time localStorage -> IndexedDB migration moves all three keys
 *   3. migration is idempotent - a second launch does not re-run or duplicate
 *   4. a migration whose verification fails leaves localStorage INTACT
 *
 * Case 4 matters most: losing data during the fix for data loss would be the
 * worst possible outcome, and migration runs exactly once per device, which
 * makes it both easy to get wrong and hard to re-test by hand.
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
const PORT = 8200;

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

/** Copy the app's runtime files into a scratch dir we can safely mutate. */
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

/**
 * The service worker would serve a cached script.js across the reloads these
 * tests perform, masking what the storage layer actually does. Strip the
 * registration: this suite is about persistence, not caching (sw-upgrade.test.js
 * covers that).
 */
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

/** Wait for the app to have booted (init() has rendered the home view). */
async function waitForBoot(page) {
  await page.waitForFunction(() => !!document.getElementById('home-matches-btn'),
                             { timeout: 10000 }).catch(() => {});
  await sleep(500); // let the async loadAppState/migration settle
}

/** Read a key straight out of IndexedDB, bypassing the app's own code. */
function readIdbRaw(page, key) {
  return page.evaluate(async (k) => {
    return await new Promise((resolve) => {
      let req;
      try { req = indexedDB.open('MatchTrackerDB', 1); }
      catch { return resolve(null); }
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('matches')) return resolve(null);
        const tx = db.transaction(['matches'], 'readonly');
        const get = tx.objectStore('matches').get(k);
        get.onsuccess = () => resolve(get.result ? get.result.data : null);
        get.onerror = () => resolve(null);
      };
    });
  }, key);
}

/** A minimal but realistic match, enough for the list view to render it. */
function sampleMatch(id, team1) {
  return {
    id, team1Name: team1, team2Name: 'Away', competition: 'Test Cup',
    matchType: 'football', date: '2026-01-01', venue: '', referee: '',
    currentPeriod: 'notStarted', timeElapsed: 0, isRunning: false,
    events: [], team1Players: [], team2Players: [],
  };
}

/** Wipe all origin storage between cases so each starts from a clean device. */
async function clearOrigin(page) {
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('MatchTrackerDB');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
}

// ------------------------------------------------------------------- tests

/**
 * THE ORIGINAL BUG, reproduced exactly.
 *
 * The failure needed BOTH stores to hold data and disagree. An old localStorage
 * copy is already on the device (written before the quota filled); the quota
 * then fills, so a newly recorded match diverts to IndexedDB; and the next
 * launch reads localStorage first, finds the OLD copy, and returns it - so the
 * new match is silently absent even though it saved successfully.
 *
 * Seeding only an empty localStorage would not reproduce it: with nothing
 * stored, the old read path fell through to IndexedDB and appeared to work.
 */
async function testNewerSaveWinsOverStaleLocalStorage(browser) {
  console.log('\n  a save is not masked by an older localStorage copy');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);

  // The device already holds one match from before the quota filled.
  await page.evaluate((m) => {
    localStorage.setItem('matches', JSON.stringify([m]));
  }, sampleMatch('m-old-1', 'Old FC'));

  // Now localStorage is full: every write throws, as it does at quota.
  await page.evaluateOnNewDocument(() => {
    const proto = Object.getPrototypeOf(localStorage);
    const realSet = proto.setItem;
    proto.setItem = function (k) {
      // Let the harness seed freely; only the app's own keys hit the ceiling.
      if (k === 'matches' || k === 'playerPanels' || k === 'lastSelectedPanels') {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      return realSet.apply(this, arguments);
    };
  });

  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  // Record a second match. The write cannot reach localStorage.
  await page.evaluate(async (a, b) => {
    await window.__mtTest.saveData('matches', [a, b]);
  }, sampleMatch('m-old-1', 'Old FC'), sampleMatch('m-new-2', 'New FC')).catch(() => {});

  await sleep(300);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const loaded = await page.evaluate(async () => {
    const m = await window.__mtTest.loadData('matches');
    return Array.isArray(m) ? m.map((x) => x.id) : [];
  }).catch(() => []);

  check('both matches survive the reload', loaded.length, 2);
  check('the newly recorded match is not lost', loaded.includes('m-new-2'), true);
  await page.close();
}

/** The one-time migration must move all three persisted keys. */
async function testMigrationMovesAllKeys(browser) {
  console.log('\n  migration moves all three keys out of localStorage');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);

  // Seed a pre-migration device: data in localStorage, IndexedDB empty.
  await page.evaluate((m) => {
    localStorage.setItem('matches', JSON.stringify([m]));
    localStorage.setItem('playerPanels', JSON.stringify([{ id: 'p1', name: 'Panel A', players: [] }]));
    localStorage.setItem('lastSelectedPanels', JSON.stringify({ 'm-mig-1-team1': 'p1' }));
  }, sampleMatch('m-mig-1', 'Legacy FC'));

  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const matches = await readIdbRaw(page, 'matches');
  const panels = await readIdbRaw(page, 'playerPanels');
  const lastSel = await readIdbRaw(page, 'lastSelectedPanels');

  check('matches arrived in IndexedDB', Array.isArray(matches) && matches.length === 1, true);
  check('the match kept its identity', Array.isArray(matches) ? matches[0].id : null, 'm-mig-1');
  check('playerPanels arrived in IndexedDB', Array.isArray(panels) && panels.length === 1, true);
  check('lastSelectedPanels arrived in IndexedDB',
        lastSel ? lastSel['m-mig-1-team1'] : null, 'p1');

  // Only after a verified read-back should the old copies be dropped.
  const lsAfter = await page.evaluate(() => ({
    matches: localStorage.getItem('matches'),
    panels: localStorage.getItem('playerPanels'),
    lastSel: localStorage.getItem('lastSelectedPanels'),
  }));
  check('localStorage copy of matches removed', lsAfter.matches, null);
  check('localStorage copy of playerPanels removed', lsAfter.panels, null);
  check('localStorage copy of lastSelectedPanels removed', lsAfter.lastSel, null);

  // And the app is actually showing the migrated data, not just storing it.
  const inApp = await page.evaluate(() => window.__mtTest.matchCount());
  check('the app sees the migrated match', inApp, 1);
  await page.close();
}

/**
 * Migration runs exactly once. A second launch must not re-run it, resurrect
 * deleted matches, or duplicate anything.
 */
async function testMigrationIsIdempotent(browser) {
  console.log('\n  migration does not re-run or duplicate on later launches');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);

  await page.evaluate((m) => {
    localStorage.setItem('matches', JSON.stringify([m]));
  }, sampleMatch('m-idem-1', 'Once FC'));

  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  // Simulate the user deleting that match after migrating.
  await page.evaluate(async () => { await window.__mtTest.saveData('matches', []); });
  await sleep(300);

  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const after = await readIdbRaw(page, 'matches');
  check('a second launch does not resurrect migrated data',
        Array.isArray(after) ? after.length : -1, 0);
  await page.close();
}

/**
 * THE CASE THAT MATTERS MOST. If the migration cannot verify what it wrote, it
 * must leave localStorage completely intact - never delete an unverified copy.
 */
async function testFailedMigrationKeepsLocalStorage(browser) {
  console.log('\n  a migration that cannot verify leaves localStorage intact');
  const page = await newPage(browser);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await clearOrigin(page);

  await page.evaluate((m) => {
    localStorage.setItem('matches', JSON.stringify([m]));
    localStorage.setItem('playerPanels', JSON.stringify([]));
    localStorage.setItem('lastSelectedPanels', JSON.stringify({}));
  }, sampleMatch('m-fail-1', 'Fragile FC'));

  // Break IndexedDB entirely, so the migration's write/verify cannot succeed.
  await page.evaluateOnNewDocument(() => {
    indexedDB.open = function () { throw new Error('IndexedDB unavailable'); };
  });

  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitForBoot(page);

  const kept = await page.evaluate(() => localStorage.getItem('matches'));
  check('localStorage was not deleted after a failed migration',
        typeof kept === 'string' && kept.includes('m-fail-1'), true);
  await page.close();
}

// -------------------------------------------------------------------- main

(async () => {
  const state = { dir: await fsp.mkdtemp(path.join(os.tmpdir(), 'mt-storetest-')) };
  let server, browser;
  try {
    await materialise(state.dir);
    await disableServiceWorker(state.dir);
    server = await startServer(state);
    browser = await puppeteer.launch({ headless: 'new' });

    console.log(`storage tests  (serving a copy at :${PORT})`);
    await testNewerSaveWinsOverStaleLocalStorage(browser);
    await testMigrationMovesAllKeys(browser);
    await testMigrationIsIdempotent(browser);
    await testFailedMigrationKeepsLocalStorage(browser);
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
