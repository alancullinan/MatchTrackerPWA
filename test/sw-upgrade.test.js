/**
 * Service worker upgrade-path tests.
 *
 * These exist because every serious bug in this app's caching layer has been an
 * UPGRADE bug, not a fresh-install bug: the app worked perfectly on a clean
 * install and served a stale version forever to anyone who already had it.
 * Testing a fresh load would have caught none of them.
 *
 * Each case installs an "old" release, deploys a "new" one, and asserts the
 * client actually ends up running the new code.
 *
 * Safety: the server serves a TEMP COPY of the repo, never the working tree, so
 * an interrupted run can never leave your files modified.
 *
 * Run with:  npm test
 */

const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const PORT = 8199;

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

/** Serve `dir`, which the caller swaps under us to simulate a deploy. */
function startServer(state) {
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.join(state.dir, rel);
    // Keep the server inside the served directory.
    if (!file.startsWith(state.dir)) { res.writeHead(403).end(); return; }
    try {
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        // No HTTP caching: we are testing the service worker's behaviour, and
        // browser HTTP cache would confound which layer served a response.
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
 * Rewrite the version markers to fabricate a DIFFERENT release from the same
 * source. Using the real files (rather than a checked-out old commit) keeps the
 * test meaningful as the app evolves - it always tests the CURRENT caching
 * logic, not whatever shipped months ago.
 */
async function setVersion(dir, cacheName, assetVer) {
  const swPath = path.join(dir, 'sw.js');
  let sw = await fsp.readFile(swPath, 'utf8');
  sw = sw.replace(/const CACHE_NAME = '[^']+';/, `const CACHE_NAME = '${cacheName}';`);
  await fsp.writeFile(swPath, sw);

  const idxPath = path.join(dir, 'index.html');
  let idx = await fsp.readFile(idxPath, 'utf8');
  idx = idx.replace(/(script\.js|styles\.css|tailwind-minimal\.css)\?v=[0-9.]+/g,
                    `$1?v=${assetVer}`);
  // A marker the test can read back to identify which release is live.
  idx = idx.replace(/<title>[^<]*<\/title>/, `<title>MT ${assetVer}</title>`);
  await fsp.writeFile(idxPath, idx);
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  return page;
}

/**
 * What release is this page actually running?
 *
 * Retries because the app deliberately reloads itself when it detects a new
 * service worker, which destroys the execution context mid-evaluate. That is
 * correct behaviour, so the test tolerates it rather than fighting it.
 */
async function readRelease(page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await page.evaluate(() => {
        const tag = [...document.querySelectorAll('script[src]')]
          .map((s) => s.getAttribute('src'))
          .find((src) => src && src.includes('script.js'));
        return { title: document.title, script: tag || null };
      });
    } catch (err) {
      if (!/context was destroyed|Target closed|detached/i.test(err.message)) throw err;
      await sleep(700); // a reload is in flight; let it land
    }
  }
  return { title: '(unreadable)', script: null };
}

/**
 * page.evaluate, but tolerant of the app reloading itself when it picks up a new
 * service worker. Every read in these tests can race that reload.
 */
async function evalStable(page, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await page.evaluate(fn); }
    catch (err) {
      if (!/context was destroyed|Target closed|detached/i.test(err.message)) throw err;
      await sleep(700);
    }
  }
  throw new Error('page kept reloading; could not read state');
}

/** Wait until the SW has installed and taken control. */
async function waitForController(page) {
  await evalStable(page, () => navigator.serviceWorker.ready).catch(() => {});
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 10000 })
    .catch(() => {});
}

// ------------------------------------------------------------------- tests

/**
 * The regression that shipped: navigations were served cache-first, so the
 * stale index.html kept naming stale ?v= URLs and the app could never update.
 */
async function testUpgradeReachesClient(browser, state) {
  console.log('\n  upgrade reaches an already-installed client');
  await setVersion(state.dir, 'match-tracker-test-v1', '1.0.0');

  const page = await newPage(browser);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await waitForController(page);
  await sleep(1200);

  const before = await readRelease(page);
  check('installed the old release', before.title, 'MT 1.0.0');

  // Deploy.
  await setVersion(state.dir, 'match-tracker-test-v2', '2.0.0');

  // Relaunch a few times, as a user would. Allow time for the new worker to be
  // fetched, activate, and any recovery reload to settle.
  // Poll until BOTH markers agree. Reading a single time races the recovery
  // reload the app performs when it picks up the new worker, which intermittently
  // yields a half-updated page (new title, script tag not yet readable).
  let after = before;
  for (let i = 0; i < 6; i++) {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
    await sleep(2000);
    after = await readRelease(page).catch(() => after);
    if (after.title === 'MT 2.0.0' && after.script === 'script.js?v=2.0.0') break;
  }

  check('client ends up on the new release', after.title, 'MT 2.0.0');
  check('and requests the new asset URLs', after.script, 'script.js?v=2.0.0');

  // Poll rather than read once. The old cache is deleted in the new worker's
  // activate handler, which runs asynchronously after the client is already on
  // the new release - so a single immediate read races it and fails
  // intermittently on a slow run. Polling still fails a worker that never
  // cleans up; it only tolerates one that is slightly slower to get there.
  let cacheNames = [];
  for (let i = 0; i < 10; i++) {
    cacheNames = await evalStable(page, () => window.caches.keys());
    if (!cacheNames.includes('match-tracker-test-v1')) break;
    await sleep(500);
  }
  check('old cache was cleaned up', cacheNames.includes('match-tracker-test-v1'), false);
  await page.close();
}

/**
 * ignoreSearch is load-bearing for assets (the precache stores them bare while
 * the HTML requests ?v=), but must not be allowed to serve a STALE asset after
 * an upgrade. This pins that distinction.
 */
async function testVersionedAssetsResolve(browser, state) {
  console.log('\n  versioned asset URLs resolve against the precache');
  await setVersion(state.dir, 'match-tracker-test-v3', '3.0.0');

  const page = await newPage(browser);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await waitForController(page);
  await sleep(1500);

  // Assert the SERVICE WORKER serves these from cache, not merely that the Cache
  // API can find them: probing with `caches.match(..., {ignoreSearch:true})`
  // directly tests the browser, and passes even if the SW has dropped the option.
  // Verified by removing ignoreSearch from sw.js and watching this fail.
  //
  // The signal is whether the request reached the network: delete the file from
  // the server, then ask for it. A cache hit still succeeds; a miss 404s.
  await fsp.rm(path.join(state.dir, 'script.js'));
  await fsp.rm(path.join(state.dir, 'styles.css'));

  const probe = await evalStable(page, async () => {
    const ok = async (u) => { try { return (await fetch(u)).ok; } catch { return false; } };
    return {
      script: await ok('/script.js?v=3.0.0'),
      styles: await ok('/styles.css?v=3.0.0'),
    };
  });
  check('script.js?v= served from cache, not network', probe.script, true);
  check('styles.css?v= served from cache, not network', probe.styles, true);

  // Put them back for the tests that follow.
  await fsp.copyFile(path.join(REPO, 'script.js'), path.join(state.dir, 'script.js'));
  await fsp.copyFile(path.join(REPO, 'styles.css'), path.join(state.dir, 'styles.css'));
  await setVersion(state.dir, 'match-tracker-test-v3', '3.0.0');
  await page.close();
}

/**
 * Navigations must be served network-first.
 *
 * This is tested directly rather than end-to-end because the app ALSO recovers
 * via registration.update() + a controllerchange reload. That recovery masks a
 * cache-first navigation bug in any whole-journey test - verified by
 * reintroducing the original bug and watching the end-to-end assertions still
 * pass. So this asserts the strategy itself: with a fresh index.html on the
 * server and the SW in control, a navigation must return the NEW html, not the
 * cached copy.
 */
async function testNavigationsAreNetworkFirst(browser, state) {
  console.log('\n  navigations are served network-first');
  await setVersion(state.dir, 'match-tracker-test-v5', '5.0.0');

  const page = await newPage(browser);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await waitForController(page);
  await sleep(1500);

  // Change ONLY the html, leaving CACHE_NAME alone. A new worker would confound
  // the result: we want to know what the EXISTING worker does with a navigation.
  const idxPath = path.join(state.dir, 'index.html');
  let idx = await fsp.readFile(idxPath, 'utf8');
  idx = idx.replace(/<title>[^<]*<\/title>/, '<title>MT FRESH</title>');
  await fsp.writeFile(idxPath, idx);

  // Must be a REAL navigation: the SW branches on `event.request.mode ===
  // 'navigate'`, and a plain fetch('/') has mode 'cors', so it would take the
  // asset path and wrongly look like a cache-first bug.
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(800);
  const served = await evalStable(page, () => document.title);

  check('navigation returns fresh html, not the cached copy', served, 'MT FRESH');
  await page.close();
}

/** Offline must still boot - that was the original point of the cache. */
async function testOfflineStillWorks(browser, state) {
  console.log('\n  app still launches offline');
  await setVersion(state.dir, 'match-tracker-test-v4', '4.0.0');

  const page = await newPage(browser);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await waitForController(page);
  await sleep(1500);

  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });

  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForFunction(
    () => !!document.getElementById('home-matches-btn'), { timeout: 10000 }
  ).catch(() => {});

  const state2 = await evalStable(page, () => ({
    homeRendered: !!document.getElementById('home-matches-btn'),
    // The dark ground must be painted even with no network.
    bg: getComputedStyle(document.documentElement).backgroundColor,
  })).catch(() => ({ homeRendered: false, bg: null }));

  check('home view renders with no network', state2.homeRendered, true);
  check('background is painted (no white flash)', state2.bg, 'rgb(11, 31, 20)');
  await page.close();
}

// -------------------------------------------------------------------- main

(async () => {
  const state = { dir: await fsp.mkdtemp(path.join(os.tmpdir(), 'mt-swtest-')) };
  let server, browser;
  try {
    await materialise(state.dir);
    server = await startServer(state);
    browser = await puppeteer.launch({ headless: 'new' });

    console.log(`service worker upgrade tests  (serving a copy at :${PORT})`);
    await testUpgradeReachesClient(browser, state);
    await testVersionedAssetsResolve(browser, state);
    await testNavigationsAreNetworkFirst(browser, state);
    await testOfflineStillWorks(browser, state);
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
