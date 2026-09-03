/*
 * Match Tracker Web App Logic
 *
 * This script implements a simplified yet feature‑rich match tracker inspired
 * by an iOS application. It supports managing multiple matches,
 * automatically generating players for teams, running a match timer with
 * period control, recording various event types (shot, foul, card,
 * kickout, substitution, note), computing scores and persisting data
 * in IndexedDB. The UI is designed to work well on mobile devices.
 */

(() => {
  // Enumeration definitions matching the original iOS app
  const MatchPeriod = {
    NOT_STARTED: 'Not Started',
    FIRST_HALF: '1st Half',
    HALF_TIME: 'Half Time',
    SECOND_HALF: '2nd Half',
    FULL_TIME: 'Full Time',
    EXTRA_FIRST: 'Extra Time 1st Half',
    EXTRA_HALF: 'Extra Time Half Time',
    EXTRA_SECOND: 'Extra Time 2nd Half',
    MATCH_OVER: 'Match Over'
  };

  const EventType = {
    // Event types mirror the Swift enums from the original iOS app.  A foul
    // denotes a foul conceded, matching `.foulConceded` in Swift.  Using
    // meaningful keys makes it trivial to extend later (e.g. periodStart).
    SHOT: 'shot',
    SUBSTITUTION: 'substitution',
    KICKOUT: 'kickout',
    CARD: 'card',
    FOUL_CONCEDED: 'foulConceded',
    NOTE: 'note',
    PERIOD_END: 'periodEnd'
  };

  const ShotOutcome = {
    GOAL: 'goal',
    POINT: 'point',
    TWO_POINTER: 'twoPointer',
    WIDE: 'wide',
    SAVED: 'saved',
    DROPPED_SHORT: 'droppedShort',
    OFF_POST: 'offPost'
  };

  /**
   * Determine whether a period is an active playing period during which
   * events may be recorded.  Only the first half, second half and
   * extra‑time halves count as playing periods.  Half‑time, extra
   * half‑time, full time and not started periods are considered
   * non‑playing.
   *
   * @param {string} period - The current match period.
   * @returns {boolean} True if it is a playing period, false otherwise.
   */
  function isPlayingPeriod(period) {
    return (
      period === MatchPeriod.FIRST_HALF ||
      period === MatchPeriod.SECOND_HALF ||
      period === MatchPeriod.EXTRA_FIRST ||
      period === MatchPeriod.EXTRA_SECOND
    );
  }

  /**
   * Enable or disable the event input buttons according to whether
   * the match is currently in a playing period.  When the match is
   * outside a playing period, scoring and event buttons are disabled
   * and visually dimmed to indicate they cannot be used.
   *
   * @param {object} match - The current match object.
   */
  function updateEventButtons(match) {
    const allow = isPlayingPeriod(match.currentPeriod);
    // Buttons for goal and point events
    // Include two‑pointer buttons as well.  The two pointer button only appears for football matches but
    // should respect the same enabled/disabled state as the other scoring buttons.
    document.querySelectorAll('.team-goal-btn, .team-point-btn, .team-two-pointer-btn, .team-event-btn').forEach((btn) => {
      if (allow) {
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'pointer-events-none');
      } else {
        btn.disabled = true;
        // Add opacity and prevent pointer events to signal disabled state
        btn.classList.add('opacity-50', 'pointer-events-none');
      }
    });
  }

  const ShotType = {
    FROM_PLAY: 'fromPlay',
    FREE: 'free',
    PENALTY: 'penalty',
    FORTY_FIVE: 'fortyFive',
    SIXTY_FIVE: 'sixtyFive',
    SIDELINE: 'sideline',
    MARK: 'mark'
  };

  const CardType = {
    YELLOW: 'yellow',
    RED: 'red',
    BLACK: 'black'
  };

  const FoulOutcome = {
    FREE: 'free',
    PENALTY: 'penalty'
  };

  // Application state persisted in IndexedDB via StorageManager
  const appState = {
    matches: [], // array of match objects
    currentMatchId: null,
    timerInterval: null,
    editingEventId: null, // currently edited event id
    editingMatchId: null, // holds ID of match being edited via the form
    playerPanels: [], // array of player panel objects
    lastSelectedPanels: {}, // stores last selected panel for each team (matchId-teamKey)
    lastBackupAt: null // ISO timestamp of the last successful export, or null
  };

  /* Enhanced Storage System with IndexedDB fallback */
  
  const StorageManager = {
    DB_NAME: 'MatchTrackerDB',
    DB_VERSION: 1,
    STORE_NAME: 'matches',
    
    // Initialize IndexedDB
    async initDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(this.STORE_NAME)) {
            const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'key' });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
      });
    },
    
    // The keys that could exist in the OLD localStorage store, for the
    // migration below. Deliberately not "every key the app persists":
    // lastBackupAt postdates the migration and never lived in localStorage, so
    // adding it here would make the migration look for something never written.
    KEYS: ['matches', 'playerPanels', 'lastSelectedPanels'],

    // Marks the localStorage -> IndexedDB migration as done, so it runs at most
    // once per device. Deliberately kept IN localStorage: it must survive
    // alongside the old copies it guards, and it is a single short string.
    MIGRATED_FLAG: 'storageMigratedToIDB',

    /**
     * Save one key. IndexedDB only.
     *
     * This used to write localStorage first and fall back to IndexedDB, while
     * loadData() read localStorage first - two independent stores that silently
     * diverged once localStorage hit quota, stranding newly recorded matches in
     * IndexedDB where nothing ever read them. A single store cannot have that
     * bug: there is no second copy to disagree with.
     *
     * @returns {Promise<boolean>} true if the data is durably stored. Callers
     *   that care can react; previously this swallowed every error and returned
     *   undefined, so failure was indistinguishable from success.
     */
    async saveData(key, data) {
      try {
        const db = await this.initDB();
        const transaction = db.transaction([this.STORE_NAME], 'readwrite');
        transaction.objectStore(this.STORE_NAME).put({
          key: key,
          data: data,
          timestamp: Date.now()
        });
        await new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        return true;
      } catch (indexedDBError) {
        console.error(`Failed to save ${key}:`, indexedDBError);
        this.showStorageWarning();
        return false;
      }
    },

    // Load one key. IndexedDB only - see saveData for why there is no fallback.
    async loadData(key) {
      try {
        const db = await this.initDB();
        const transaction = db.transaction([this.STORE_NAME], 'readonly');
        const request = transaction.objectStore(this.STORE_NAME).get(key);

        return await new Promise((resolve, reject) => {
          request.onsuccess = () => {
            const result = request.result;
            resolve(result ? result.data : null);
          };
          request.onerror = () => reject(request.error);
        });
      } catch (indexedDBError) {
        console.error(`Failed to load ${key}:`, indexedDBError);
        return null;
      }
    },

    /**
     * One-time move of existing data from localStorage into IndexedDB.
     *
     * Runs before the first load on an upgraded device. The ordering is the
     * whole point: write everything, read it all back and verify it, and only
     * then remove the localStorage originals. If anything fails or fails to
     * verify, localStorage is left completely untouched - a device that cannot
     * migrate keeps working off the old copy rather than losing it.
     *
     * Never delete an unverified copy: losing data during the fix for data loss
     * would be the worst possible outcome.
     */
    async migrateFromLocalStorage() {
      let pending;
      try {
        if (localStorage.getItem(this.MIGRATED_FLAG)) return; // already done
        // Collect whatever the old build left behind.
        pending = this.KEYS
          .map((key) => ({ key, raw: localStorage.getItem(key) }))
          .filter((entry) => entry.raw !== null)
          .map((entry) => ({ key: entry.key, value: JSON.parse(entry.raw) }));
      } catch (err) {
        // Unreadable or unparseable localStorage: nothing safe to migrate, and
        // nothing to delete either.
        console.warn('Skipping storage migration:', err);
        return;
      }

      if (pending.length === 0) {
        // A fresh install has nothing to move. Still flag it, so this never
        // runs again and cannot later pick up stray keys.
        try { localStorage.setItem(this.MIGRATED_FLAG, '1'); } catch (err) { /* non-fatal */ }
        return;
      }

      try {
        for (const entry of pending) {
          const saved = await this.saveData(entry.key, entry.value);
          if (!saved) throw new Error(`write failed for ${entry.key}`);
        }

        // Verify by reading back through the real load path, not by trusting
        // the write. A write that reports success but reads back empty is
        // exactly the kind of failure this guard exists for.
        for (const entry of pending) {
          const readBack = await this.loadData(entry.key);
          if (JSON.stringify(readBack) !== JSON.stringify(entry.value)) {
            throw new Error(`verification failed for ${entry.key}`);
          }
        }
      } catch (err) {
        console.error('Storage migration failed; keeping localStorage copy.', err);
        this.showStorageWarning();
        return; // localStorage untouched
      }

      // Verified. Only now is it safe to drop the originals.
      try {
        for (const entry of pending) localStorage.removeItem(entry.key);
        localStorage.setItem(this.MIGRATED_FLAG, '1');
        console.log(`Migrated ${pending.length} key(s) to IndexedDB.`);
      } catch (err) {
        // The data is safely in IndexedDB; failing to tidy up is harmless, and
        // re-running the migration next launch is idempotent.
        console.warn('Migrated, but could not clear localStorage:', err);
      }
    },

    /**
     * Ask the browser not to evict this origin's storage.
     *
     * The app had never called this, so storage was "best-effort" and could be
     * cleared - on iOS, after roughly a week of disuse. Chrome usually grants it
     * for installed PWAs; Safari is less predictable and may refuse, which is
     * not an error. This reduces eviction risk but cannot eliminate it: only an
     * off-device backup survives a cleared or replaced device.
     */
    async requestPersistence() {
      try {
        if (!navigator.storage || !navigator.storage.persist) return false;
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      } catch (err) {
        return false; // unsupported or refused - carry on regardless
      }
    },
    
    /**
     * Report real storage usage.
     *
     * This used to count localStorage CHARACTERS (not bytes) against a guessed
     * 10MB cap, and pair it with a hardcoded 50MB "IndexedDB space" that
     * measured nothing at all. navigator.storage.estimate() is the only honest
     * source now the real limit is a share of free disk rather than a fixed
     * number. It is absent on older Safari, hence `measured`: callers must be
     * able to tell "not measurable" from "zero".
     */
    async getStorageInfo() {
      const info = { available: false, measured: false, used: 0, quota: 0, persisted: false };

      if (!('indexedDB' in window)) return info;

      try {
        await this.initDB();
        info.available = true;
      } catch (e) {
        console.warn('IndexedDB not available:', e);
        return info;
      }

      try {
        if (navigator.storage && navigator.storage.estimate) {
          const estimate = await navigator.storage.estimate();
          info.used = estimate.usage || 0;
          info.quota = estimate.quota || 0;
          info.measured = info.quota > 0;
        }
        if (navigator.storage && navigator.storage.persisted) {
          info.persisted = await navigator.storage.persisted();
        }
      } catch (e) {
        console.warn('Storage estimate unavailable:', e);
      }

      return info;
    },
    
    // Show storage warning to user
    showStorageWarning() {
      const warning = document.createElement('div');
      warning.className = 'fixed top-4 left-4 right-4 bg-yellow-600 text-white p-3 rounded-lg z-50';
      warning.innerHTML = `
        <div class="flex items-center space-x-2">
          <span>⚠️</span>
          <div>
            <div class="font-semibold">Storage Warning</div>
            <div class="text-sm">Unable to save data. Please free up space or backup your matches.</div>
          </div>
        </div>
      `;
      document.body.appendChild(warning);
      
      // Auto-remove after 5 seconds
      setTimeout(() => {
        if (warning.parentNode) {
          warning.parentNode.removeChild(warning);
        }
      }, 5000);
    }
  };

  /* Data Export/Import System */
  
  const DataManager = {
    /**
     * Export everything the app persists as a single JSON file.
     *
     * Prefers the native share sheet. The old synthetic `<a download>` click is
     * the least reliable way to produce a file in an INSTALLED iOS PWA, which is
     * exactly where this app runs - it can silently produce nothing. The share
     * sheet reliably yields a file and lets the user route it to Files, iCloud
     * Drive, AirDrop or a chat. Same capability-check-then-fall-back shape the
     * app already uses for sharing event images.
     *
     * Only a genuinely completed share or download sets `lastBackupAt`:
     * navigator.share() rejects with AbortError when the sheet is dismissed, and
     * recording a cancelled share as a backup would make staleness tracking lie.
     */
    async exportData() {
      try {
        const payload = {
          version: '1.0.0',
          exportDate: new Date().toISOString(),
          matches: appState.matches,
          matchCount: appState.matches.length,
          playerPanels: appState.playerPanels,
          panelCount: appState.playerPanels.length,
          lastSelectedPanels: appState.lastSelectedPanels
        };

        const jsonString = JSON.stringify(payload, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        // Timestamped: the old name was date-only, so two exports on one day
        // collided - the second would overwrite or be renamed by the target.
        const filename = `match-tracker-backup-${this.backupTimestamp()}.json`;
        const count = payload.matchCount;

        const file = new File([blob], filename, { type: 'application/json' });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            // Files ONLY - deliberately no `text`. iOS "Save to Files" writes any
            // accompanying text as a SECOND file, so the user gets a stray .txt
            // alongside every backup. The timestamped filename already identifies
            // the payload, which is what the text was there for.
            await navigator.share({
              title: 'MatchTracker backup',
              files: [file]
            });
            await this.recordBackup();
            return { success: true, message: `Exported ${count} matches` };
          } catch (shareError) {
            // Dismissing the sheet is a normal user action, not a failure.
            if (shareError && shareError.name === 'AbortError') {
              return { success: false, message: 'Export cancelled', cancelled: true };
            }
            // Anything else: fall through to the download path rather than
            // leaving the user with no way to get their data out.
            console.warn('Share failed, falling back to download:', shareError);
          }
        }

        // Fallback: direct download (desktop, and older browsers).
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        await this.recordBackup();
        return { success: true, message: `Exported ${count} matches` };
      } catch (error) {
        console.error('Export failed:', error);
        return { success: false, message: `Export failed: ${error.message}` };
      }
    },

    // Filename-safe local timestamp, to the minute: 2026-09-03-1432.
    // Local rather than ISO/UTC so the name matches the day the user thinks it is.
    backupTimestamp() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    },

    // Remember when data last left the device. This is the only thing that makes
    // "your backup is stale" answerable - the app previously had no idea whether
    // a backup had ever been taken.
    async recordBackup() {
      appState.lastBackupAt = new Date().toISOString();
      await StorageManager.saveData('lastBackupAt', appState.lastBackupAt);
    },

    // Whole days since the last backup, or null if there has never been one.
    daysSinceBackup() {
      if (!appState.lastBackupAt) return null;
      const then = new Date(appState.lastBackupAt).getTime();
      if (Number.isNaN(then)) return null;
      return Math.floor((Date.now() - then) / 86400000);
    },
    
    // Import match data from JSON file
    async importData(file) {
      try {
        const text = await this.readFileAsText(file);
        const importData = JSON.parse(text);
        
        // Validate import data structure
        if (!importData.matches || !Array.isArray(importData.matches)) {
          throw new Error('Invalid backup file format');
        }
        
        // Validate match structure (basic validation)
        for (const match of importData.matches) {
          if (!match.id || !match.team1 || !match.team2) {
            throw new Error('Invalid match data in backup file');
          }
        }
        
        // Merge with existing matches (avoid duplicates by ID)
        const existingIds = new Set(appState.matches.map(m => m.id));
        const newMatches = importData.matches.filter(m => !existingIds.has(m.id));
        
        appState.matches.push(...newMatches);
        
        // Import player panels if they exist
        let newPanelsCount = 0;
        if (importData.playerPanels && Array.isArray(importData.playerPanels)) {
          // Merge with existing panels (avoid duplicates by ID)
          const existingPanelIds = new Set(appState.playerPanels.map(p => p.id));
          const newPanels = importData.playerPanels.filter(p => !existingPanelIds.has(p.id));

          // Backups may predate jersey numbers; migrate before they enter state.
          newPanels.forEach(normalizePanel);
          appState.playerPanels.push(...newPanels);
          newPanelsCount = newPanels.length;
        }
        
        // Import last selected panels if they exist
        if (importData.lastSelectedPanels && typeof importData.lastSelectedPanels === 'object') {
          // Merge with existing last selected panels (imported ones take precedence)
          appState.lastSelectedPanels = { ...appState.lastSelectedPanels, ...importData.lastSelectedPanels };
        }
        
        await saveAppState();
        renderMatchList();
        
        let message = `Imported ${newMatches.length} new matches (${importData.matches.length - newMatches.length} duplicates skipped)`;
        if (newPanelsCount > 0) {
          message += ` and ${newPanelsCount} new player panels`;
        }
        
        return { 
          success: true, 
          message: message
        };
      } catch (error) {
        console.error('Import failed:', error);
        return { success: false, message: `Import failed: ${error.message}` };
      }
    },
    
    // Helper to read file as text
    readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(new Error('Failed to read file'));
        reader.readAsText(file);
      });
    },
    
    // Format storage info for display
    async formatStorageInfo() {
      const info = await StorageManager.getStorageInfo();
      const formatBytes = (bytes) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
      };
      
      if (!info.available) {
        return '<div class="text-yellow-400">⚠️ No storage available</div>';
      }

      let html = '';

      if (info.measured) {
        const usedPercent = ((info.used / info.quota) * 100).toFixed(1);
        html += `<div>Used: ${formatBytes(info.used)} of ${formatBytes(info.quota)} (${usedPercent}%)</div>`;
        // Long-tail now that the ceiling is disk-sized rather than ~5MB, but
        // still worth flagging before it becomes a problem.
        if (info.used / info.quota > 0.8) {
          html += '<div class="text-yellow-400">⚠️ Storage is nearly full — export a backup.</div>';
        }
      } else {
        // Older Safari has no estimate(); say so rather than inventing a number.
        html += '<div>Storage available (usage not reported by this browser)</div>';
      }

      html += info.persisted
        ? '<div class="text-green-400">Storage is persistent</div>'
        : '<div>Storage is best-effort — the browser may clear it if unused. Export backups.</div>';

      return html;
    }
  };

  /* Player Panels Management Functions */
  
  // Show home view
  function showHomeView() {
    showView('home-view');
  }

  // Show matches view
  function showMatchesView() {
    showView('match-list-view');
    // Clear the filter input when showing matches view
    const filterInput = document.getElementById('match-filter-input');
    if (filterInput) {
      filterInput.value = '';
    }
    renderMatchList();
  }

  // Show player panels main view
  function showPlayerPanelsView() {
    showView('player-panels-view');
    renderPlayerPanelsList();
  }
  
  // Render the list of all player panels
  function renderPlayerPanelsList(filterText = '') {
    const container = document.getElementById('player-panels-list');
    if (!container) return;

    const query = filterText.trim().toLowerCase();
    const filtered = query
      ? appState.playerPanels.filter(p => p.name.toLowerCase().includes(query))
      : appState.playerPanels;

    if (appState.playerPanels.length === 0) {
      container.innerHTML = `
        <div class="text-center text-gray-400 py-8">
          <p class="text-lg mb-2">No player panels yet</p>
          <p class="text-sm">Create a panel to store player names for quick selection during matches.</p>
        </div>
      `;
      return;
    }

    if (filtered.length === 0) {
      container.innerHTML = `<div class="text-center text-gray-400 py-8"><p class="text-lg">No panels match "${filterText}"</p></div>`;
      return;
    }

    // Clear container and create panel cards using the same method as match cards
    container.innerHTML = '';

    filtered.forEach((panel, idx) => {
      // Create panel card using exact same method as match cards
      const card = document.createElement('div');
      card.className =
        'match-card relative bg-gray-800 border border-gray-700 rounded-lg p-4 cursor-pointer hover:bg-gray-700 flex flex-col space-y-1 text-left';
      card.style.setProperty('--i', idx);
      card.addEventListener('click', () => showPanelEditor(panel.id));

      // Panel name line (same as competition line in match cards)
      const nameEl = document.createElement('div');
      nameEl.className = 'text-gray-100 font-semibold text-lg';
      nameEl.textContent = panel.name;
      card.appendChild(nameEl);

      // Players count line (same as teams line in match cards)
      const playersEl = document.createElement('div');
      playersEl.className = 'text-gray-400 text-sm';
      // Slots are fixed at PANEL_SIZE, so count the ones actually filled.
      const filled = countPanelPlayers(panel);
      playersEl.textContent = `${filled} ${filled === 1 ? 'player' : 'players'}`;
      card.appendChild(playersEl);

      // Add delete button using exact same method as match cards
      const del = document.createElement('button');
      del.title = 'Delete panel';
      del.className = 'absolute bottom-2 right-2 text-gray-300 hover:text-gray-100';
      del.innerHTML = '<img src="icons/delete.svg" alt="Delete Panel" class="w-8 h-8" />';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this panel?')) {
          deletePanelWithConfirm(panel.id);
        }
      });
      card.appendChild(del);

      container.appendChild(card);
    });
  }
  
  // Show panel editor (for new or existing panel)
  function showPanelEditor(panelId = null) {
    showView('panel-editor-view');
    
    const isEditing = panelId !== null;
    const title = document.getElementById('panel-editor-title');
    const nameInput = document.getElementById('panel-name');
    
    if (isEditing) {
      const panel = appState.playerPanels.find(p => p.id === panelId);
      if (!panel) return;

      // Migrate before snapshotting, otherwise Cancel would restore the
      // pre-migration array and undo the numbering.
      normalizePanel(panel);

      title.textContent = 'Edit Panel';
      nameInput.value = panel.name;
      appState.editingPanelId = panelId;

      // Create backup of original panel state for cancel functionality
      appState.originalPanelState = {
        name: panel.name,
        players: JSON.parse(JSON.stringify(panel.players)) // Deep copy of players array
      };
    } else {
      title.textContent = 'New Panel';
      nameInput.value = '';
      appState.editingPanelId = null;
      appState.originalPanelState = null;
      // A new panel starts as a full sheet of empty numbered slots.
      window.tempPanelPlayers = Array.from({ length: PANEL_SIZE }, (_, i) => ({
        id: generateId(),
        name: '',
        jerseyNumber: i + 1
      }));
    }
    
    renderPanelPlayersList();
    // nameInput.focus(); // Removed to prevent keyboard popup on mobile
  }
  
  // Update the "N / 30 PLAYERS" caption above the panel slot list.
  function updatePanelPlayersCount(players) {
    const countEl = document.getElementById('panel-players-count');
    if (!countEl) return;
    const filled = players.filter(p => p && (p.name || '').trim() !== '').length;
    countEl.textContent = `${filled} / ${PANEL_SIZE} Players`;
  }

  // Render the panel editor as a fixed team-sheet: one row per jersey, always
  // all PANEL_SIZE of them. Mirrors the Edit Players row vocabulary.
  function renderPanelPlayersList() {
    const container = document.getElementById('panel-players-list');
    if (!container) return;

    const panelId = appState.editingPanelId;
    let players = [];

    if (panelId) {
      const panel = appState.playerPanels.find(p => p.id === panelId);
      if (panel) {
        normalizePanel(panel);
        players = panel.players;
      }
    } else {
      // For new panels, use temporary players
      players = window.tempPanelPlayers || [];
    }

    // Reset content before re-rendering.
    container.innerHTML = '';

    updatePanelPlayersCount(players);

    players.forEach((player, index) => {
      const row = document.createElement('div');
      row.className = 'panel-player-row';
      // --i drives the staggered reveal animation in styles.css.
      row.style.setProperty('--i', index);
      row.dataset.slotIndex = index;

      // Jersey number badge — same scoreboard digit as the Edit Players rows.
      const chip = document.createElement('span');
      chip.className = 'jersey-chip';
      chip.textContent = player.jerseyNumber;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'panel-player-name';
      input.value = player.name || '';
      input.placeholder = 'Empty';
      input.dataset.slotIndex = index;
      input.addEventListener('change', (e) => {
        updatePanelPlayerName(index, e.target.value);
        updatePanelPlayersCount(players);
      });

      // Tapping a row while swap mode is on selects it instead of editing.
      row.addEventListener('click', (e) => handleSwapRowTap(container, row, e));

      row.appendChild(chip);
      row.appendChild(input);
      container.appendChild(row);
    });
  }
  
  // Update a player's name in the current panel being edited
  function updatePanelPlayerName(index, newName) {
    const panelId = appState.editingPanelId;
    
    if (panelId) {
      const panel = appState.playerPanels.find(p => p.id === panelId);
      if (!panel) return;
      
      panel.players[index].name = newName;
    } else {
      if (window.tempPanelPlayers) {
        window.tempPanelPlayers[index].name = newName;
      }
    }
  }
  
  // Save the current panel being edited
  function savePanelEditor() {
    // Leave swap mode before navigating away so no stale highlight lingers.
    setSwapMode(false, 'panel-players-list');

    const nameInput = document.getElementById('panel-name');
    const panelName = nameInput.value.trim();

    if (!panelName) {
      alert('Please enter a panel name.');
      // nameInput.focus(); // Removed to prevent keyboard popup on mobile
      return;
    }

    const panelId = appState.editingPanelId;

    // Names round-trip verbatim into match rosters, so trim them here.
    const trimNames = (players) => {
      players.forEach(p => { p.name = (p.name || '').trim(); });
      return players;
    };

    if (panelId) {
      // Editing existing panel. Slots are fixed, so keep every one of them —
      // empty slots are meaningful and order is jersey order, never alphabetical.
      const panel = appState.playerPanels.find(p => p.id === panelId);
      if (!panel) return;

      panel.name = panelName;
      trimNames(panel.players);
      normalizePanel(panel);
    } else {
      // Creating new panel
      const newPanel = {
        id: generateId(),
        name: panelName,
        players: trimNames(window.tempPanelPlayers || []),
        createdDate: new Date().toISOString()
      };
      normalizePanel(newPanel);

      appState.playerPanels.push(newPanel);
      window.tempPanelPlayers = null;
    }

    appState.editingPanelId = null;
    saveAppState();
    showPlayerPanelsView();
  }
  
  // Cancel panel editing
  function cancelPanelEditor() {
    // Leave swap mode before navigating away so no stale highlight lingers.
    setSwapMode(false, 'panel-players-list');
    const panelId = appState.editingPanelId;

    if (panelId && appState.originalPanelState) {
      // Restore original panel state for existing panels
      const panel = appState.playerPanels.find(p => p.id === panelId);
      if (panel) {
        panel.name = appState.originalPanelState.name;
        panel.players = JSON.parse(JSON.stringify(appState.originalPanelState.players)); // Deep copy back
      }
    }
    
    // Clean up temporary state
    appState.editingPanelId = null;
    appState.originalPanelState = null;
    window.tempPanelPlayers = null;
    showPlayerPanelsView();
  }
  
  // Delete a panel with confirmation
  function deletePanelWithConfirm(panelId) {
    const panel = appState.playerPanels.find(p => p.id === panelId);
    if (!panel) return;
    
    if (confirm(`Delete "${panel.name}" panel? This cannot be undone.`)) {
      const index = appState.playerPanels.findIndex(p => p.id === panelId);
      if (index >= 0) {
        appState.playerPanels.splice(index, 1);
        saveAppState();
        renderPlayerPanelsList();
      }
    }
  }
  
  // Make panel functions globally accessible
  window.showPanelEditor = showPanelEditor;
  window.deletePanelWithConfirm = deletePanelWithConfirm;
  window.updatePanelPlayerName = updatePanelPlayerName;

  /* Data Management UI Functions */
  
  function showDataManagementModal() {
    const modal = document.getElementById('data-management-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    
    // Load storage info
    loadStorageInfo();
    updateBackupStatus();
  }
  
  function hideDataManagementModal() {
    const modal = document.getElementById('data-management-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    
    // Reset import state
    resetImportState();
  }
  
  async function loadStorageInfo() {
    const storageInfoDiv = document.getElementById('storage-info');
    storageInfoDiv.innerHTML = await DataManager.formatStorageInfo();
  }
  
  async function exportData() {
    const statusDiv = document.getElementById('export-status');
    const btn = document.getElementById('export-data-btn');

    // The share sheet is modal and can sit open for a while; stop a second tap
    // building a second copy of the whole state in the meantime.
    if (btn) btn.disabled = true;
    statusDiv.textContent = 'Preparing backup…';
    statusDiv.className = 'text-sm text-gray-400';

    try {
      const result = await DataManager.exportData();

      statusDiv.textContent = result.message;
      // A dismissed share sheet is a normal choice, not an error - say so in
      // neutral grey rather than alarming red.
      statusDiv.className = result.success
        ? 'text-sm text-green-400'
        : (result.cancelled ? 'text-sm text-gray-400' : 'text-sm text-red-400');

      if (result.success) updateBackupStatus();
    } finally {
      if (btn) btn.disabled = false;
    }

    // Clear status after 3 seconds
    setTimeout(() => {
      statusDiv.textContent = '';
      statusDiv.className = 'text-sm text-gray-400';
    }, 3000);
  }

  // Show when data last left the device, in the Data Management modal.
  function updateBackupStatus() {
    const el = document.getElementById('backup-status');
    if (!el) return;

    const days = DataManager.daysSinceBackup();
    if (days === null) {
      el.textContent = 'No backup taken yet on this device.';
      el.className = 'text-sm text-yellow-400 mb-3';
      return;
    }

    const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    el.textContent = `Last backup: ${when}.`;
    // 30 days: routine risk is already covered by persistent on-device storage,
    // so this only needs to catch a genuinely long gap.
    el.className = days > 30 ? 'text-sm text-yellow-400 mb-3' : 'text-sm text-gray-400 mb-3';
  }
  
  let selectedImportFile = null;
  
  function handleFileSelect(event) {
    const file = event.target.files[0];
    const selectBtn = document.getElementById('select-import-file-btn');
    const importBtn = document.getElementById('import-data-btn');
    const statusDiv = document.getElementById('import-status');
    
    if (file) {
      selectedImportFile = file;
      selectBtn.textContent = `Selected: ${file.name}`;
      importBtn.classList.remove('hidden');
      statusDiv.textContent = 'File ready to import';
      statusDiv.className = 'text-sm text-blue-400';
    } else {
      resetImportState();
    }
  }
  
  async function importData() {
    if (!selectedImportFile) return;
    
    const importBtn = document.getElementById('import-data-btn');
    const statusDiv = document.getElementById('import-status');
    
    // Show loading state
    importBtn.textContent = 'Importing...';
    importBtn.disabled = true;
    statusDiv.textContent = 'Processing import file...';
    statusDiv.className = 'text-sm text-blue-400';
    
    try {
      const result = await DataManager.importData(selectedImportFile);
      
      statusDiv.textContent = result.message;
      statusDiv.className = result.success ? 'text-sm text-green-400' : 'text-sm text-red-400';
      
      if (result.success) {
        // Clear after successful import
        setTimeout(() => {
          hideDataManagementModal();
        }, 2000);
      }
    } finally {
      // Reset button state
      importBtn.textContent = 'Import Matches';
      importBtn.disabled = false;
    }
  }
  
  function resetImportState() {
    selectedImportFile = null;
    const selectBtn = document.getElementById('select-import-file-btn');
    const importBtn = document.getElementById('import-data-btn');
    const statusDiv = document.getElementById('import-status');
    const fileInput = document.getElementById('import-file-input');
    
    selectBtn.textContent = 'Select Import File';
    importBtn.classList.add('hidden');
    statusDiv.textContent = '';
    statusDiv.className = 'text-sm text-gray-400';
    if (fileInput) fileInput.value = '';
  }

  /* Match Statistics System */
  
  const StatsCalculator = {
    // Calculate comprehensive match statistics
    calculateMatchStats(match) {
      const stats = {
        match: {
          id: match.id,
          competition: match.competition,
          date: match.dateTime,
          venue: match.venue,
          matchType: match.matchType,
          duration: this.formatMatchDuration(match),
          final: match.period === MatchPeriod.MATCH_OVER
        },
        teams: {
          [match.team1.name]: this.calculateTeamStats(match, 'team1'),
          [match.team2.name]: this.calculateTeamStats(match, 'team2')
        },
        summary: this.calculateMatchSummary(match)
      };
      
      return stats;
    },
    
    // Calculate statistics for a specific team
    calculateTeamStats(match, teamKey) {
      const teamEvents = match.events.filter(e => e.teamId === match[teamKey].id);
      const team = match[teamKey];
      
      const shots = teamEvents.filter(e => e.type === EventType.SHOT);
      const fouls = teamEvents.filter(e => e.type === EventType.FOUL_CONCEDED);
      const cards = teamEvents.filter(e => e.type === EventType.CARD);
      const subs = teamEvents.filter(e => e.type === EventType.SUBSTITUTION);
      
      // Shooting stats
      const goals = shots.filter(s => s.shotOutcome === ShotOutcome.GOAL).length;
      const points = shots.filter(s => s.shotOutcome === ShotOutcome.POINT).length;
      const twoPointers = shots.filter(s => s.shotOutcome === ShotOutcome.TWO_POINTER).length;
      const wides = shots.filter(s => s.shotOutcome === ShotOutcome.WIDE).length;
      const saved = shots.filter(s => s.shotOutcome === ShotOutcome.SAVED).length;
      const blocked = shots.filter(s => s.shotOutcome === ShotOutcome.DROPPED_SHORT || s.shotOutcome === ShotOutcome.OFF_POST).length;
      
      const totalShots = shots.length;
      const successfulShots = goals + points + twoPointers;
      const shootingAccuracy = totalShots > 0 ? ((successfulShots / totalShots) * 100).toFixed(1) : '0.0';
      
      // Score calculation
      let totalScore = goals * 3 + points;
      if (match.matchType === 'football' || match.matchType === 'ladiesFootball') {
        totalScore += twoPointers * 2;
      }
      
      // Card stats
      const yellowCards = cards.filter(c => c.cardType === CardType.YELLOW).length;
      const redCards = cards.filter(c => c.cardType === CardType.RED).length;
      const blackCards = cards.filter(c => c.cardType === CardType.BLACK).length;
      
      // Player stats
      const playerStats = this.calculatePlayerStats(teamEvents, team.players);
      
      return {
        name: team.name,
        score: {
          goals,
          points,
          twoPointers,
          total: totalScore,
          display: match.matchType === 'football' || match.matchType === 'ladiesFootball' 
            ? `${goals}-${(points + twoPointers * 2).toString().padStart(2, '0')}` 
            : `${goals}-${points.toString().padStart(2, '0')}`
        },
        shooting: {
          total: totalShots,
          successful: successfulShots,
          accuracy: `${shootingAccuracy}%`,
          breakdown: { goals, points, twoPointers, wides, saved, blocked }
        },
        fouls: fouls.length,
        cards: { yellow: yellowCards, red: redCards, black: blackCards, total: yellowCards + redCards + blackCards },
        substitutions: subs.length,
        topScorers: this.getTopScorers(playerStats),
        periods: this.calculatePeriodStats(teamEvents)
      };
    },
    
    // Calculate player-specific statistics
    calculatePlayerStats(teamEvents, players) {
      const playerMap = {};
      
      // Initialize all players
      players.forEach(player => {
        playerMap[player.id] = {
          id: player.id,
          name: player.name,
          jerseyNumber: player.jerseyNumber,
          goals: 0,
          points: 0,
          twoPointers: 0,
          totalScore: 0,
          shots: 0,
          fouls: 0,
          cards: 0,
          events: []
        };
      });
      
      // Process events
      teamEvents.forEach(event => {
        if (!event.playerId || !playerMap[event.playerId]) return;
        
        const player = playerMap[event.playerId];
        player.events.push(event);
        
        if (event.type === EventType.SHOT) {
          player.shots++;
          if (event.outcome === ShotOutcome.GOAL) {
            player.goals++;
            player.totalScore += 3;
          } else if (event.outcome === ShotOutcome.POINT) {
            player.points++;
            player.totalScore += 1;
          } else if (event.outcome === ShotOutcome.TWO_POINTER) {
            player.twoPointers++;
            player.totalScore += 2;
          }
        } else if (event.type === EventType.FOUL_CONCEDED) {
          player.fouls++;
        } else if (event.type === EventType.CARD) {
          player.cards++;
        }
      });
      
      return Object.values(playerMap).filter(p => p.shots > 0 || p.fouls > 0 || p.cards > 0);
    },
    
    // Get top scorers for a team
    getTopScorers(playerStats) {
      return playerStats
        .filter(p => p.totalScore > 0)
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, 5)
        .map(p => ({
          name: p.name,
          jerseyNumber: p.jerseyNumber,
          goals: p.goals,
          points: p.points,
          twoPointers: p.twoPointers,
          totalScore: p.totalScore
        }));
    },
    
    // Calculate statistics by match period
    calculatePeriodStats(teamEvents) {
      const periods = {};
      
      teamEvents.forEach(event => {
        const period = event.period || 'Unknown';
        if (!periods[period]) {
          periods[period] = { shots: 0, goals: 0, points: 0, fouls: 0 };
        }
        
        if (event.type === EventType.SHOT) {
          periods[period].shots++;
          if (event.outcome === ShotOutcome.GOAL) periods[period].goals++;
          else if (event.outcome === ShotOutcome.POINT) periods[period].points++;
        } else if (event.type === EventType.FOUL_CONCEDED) {
          periods[period].fouls++;
        }
      });
      
      return periods;
    },
    
    // Calculate match summary statistics
    calculateMatchSummary(match) {
      const team1Stats = this.calculateTeamStats(match, 'team1');
      const team2Stats = this.calculateTeamStats(match, 'team2');
      
      return {
        totalShots: team1Stats.shooting.total + team2Stats.shooting.total,
        totalFouls: team1Stats.fouls + team2Stats.fouls,
        totalCards: team1Stats.cards.total + team2Stats.cards.total,
        winner: team1Stats.score.total > team2Stats.score.total ? team1Stats.name : 
                team2Stats.score.total > team1Stats.score.total ? team2Stats.name : 'Draw',
        margin: Math.abs(team1Stats.score.total - team2Stats.score.total)
      };
    },
    
    // Format match duration for display
    formatMatchDuration(match) {
      if (!match.elapsedTime) return 'Not started';
      
      const minutes = Math.floor(match.elapsedTime / 60);
      const seconds = match.elapsedTime % 60;
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    },
    
    // Generate shareable text summary
    generateShareableStats(stats) {
      const { match, teams, summary } = stats;
      const teamNames = Object.keys(teams);
      const team1 = teams[teamNames[0]];
      const team2 = teams[teamNames[1]];
      
      let shareText = `🏈 ${match.competition || 'Match'} Results\n\n`;
      shareText += `${team1.name} ${team1.score.display} - ${team2.score.display} ${team2.name}\n\n`;
      
      if (summary.winner !== 'Draw') {
        shareText += `🏆 Winner: ${summary.winner} (by ${summary.margin})\n\n`;
      } else {
        shareText += `🤝 Match ended in a draw\n\n`;
      }
      
      shareText += `📊 Match Stats:\n`;
      shareText += `• Total Shots: ${summary.totalShots}\n`;
      shareText += `• Total Fouls: ${summary.totalFouls}\n`;
      if (summary.totalCards > 0) {
        shareText += `• Cards: ${summary.totalCards}\n`;
      }
      shareText += `• Duration: ${match.duration}\n\n`;
      
      // Top scorers
      const allScorers = [...team1.topScorers, ...team2.topScorers]
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, 3);
      
      if (allScorers.length > 0) {
        shareText += `⭐ Top Scorers:\n`;
        allScorers.forEach((scorer, i) => {
          shareText += `${i + 1}. ${scorer.name} (${scorer.totalScore} pts)\n`;
        });
      }
      
      shareText += `\n📱 Tracked with Match Tracker PWA`;
      
      return shareText;
    }
  };

  /* Statistics UI Functions */
  
  let currentMatchStats = null;
  
  function showMatchStats() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      console.error('No match found for stats');
      return;
    }
    
    try {
      currentMatchStats = StatsCalculator.calculateMatchStats(match);
      renderMatchStats(currentMatchStats);
      
      const modal = document.getElementById('match-stats-modal');
      if (!modal) {
        console.error('Stats modal element not found');
        return;
      }
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    } catch (error) {
      console.error('Error showing match stats:', error);
    }
  }
  
  function hideMatchStats() {
    const modal = document.getElementById('match-stats-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    currentMatchStats = null;
  }
  
  function renderMatchStats(stats) {
    // Render scorers cards
    renderScorersCards(stats);
    
    // Render shooting accuracy cards
    renderShootingAccuracyCards(stats);
  }
  
  function renderScorersCards(stats) {
    const container = document.getElementById('stats-scorers-cards');
    if (!container) {
      console.error('Stats scorers cards container not found');
      return;
    }
    
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      console.error('No match found for scorers cards');
      return;
    }
    
    const teamNames = Object.keys(stats.teams);
    const isFootball = stats.match.matchType === 'football' || stats.match.matchType === 'ladiesFootball';
    console.log('Rendering scorers cards for teams:', teamNames, 'isFootball:', isFootball);
    
    container.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        ${teamNames.map(teamName => {
          const team = stats.teams[teamName];
          const scorers = calculatePlayerScorers(match, teamName, isFootball);
          
          return `
            <div class="bg-gray-700 rounded-lg p-3">
              <div class="flex justify-between items-center px-3">
                <h3 class="text-lg font-bold">${team.name}</h3>
                <button class="text-blue-400 hover:text-blue-300 p-3 flex items-center justify-center" onclick="shareTeamCard('${teamName}')" title="Share">
                  <img src="icons/share.svg" alt="Share" class="w-8 h-8" />
                </button>
              </div>
              
              <div class="text-center">
                <div class="text-3xl font-bold text-blue-400 leading-none">${team.score.display}</div>
                <div class="text-sm text-gray-400 -mt-1 mb-1">(${team.score.total})</div>
              </div>
              
              ${scorers.length > 0 ? `
                <div class="px-3">
                  <h4 class="text-sm font-semibold text-green-400 mb-2">Scorers</h4>
                  ${scorers.map((scorer, index) => {
                    const breakdowns = [];
                    if (scorer.freeBreakdown) {
                      breakdowns.push(`${formatScoreDisplay(scorer.freeBreakdown, isFootball)} f`);
                    }
                    if (scorer.penaltyBreakdown) {
                      breakdowns.push(`${formatScoreDisplay(scorer.penaltyBreakdown, isFootball)} p`);
                    }
                    if (isFootball && scorer.total.twoPointers > 0) {
                      breakdowns.push(`<span style="color: #f97316">2p</span>:${scorer.total.twoPointers}`);
                    }
                    const breakdownText = breakdowns.length > 0 ? `(${breakdowns.join(', ')})` : '';
                    const isLast = index === scorers.length - 1;
                    
                    return `
                      <div class="flex justify-between items-center text-sm py-2" style="border-bottom: ${isLast ? 'none' : '1px solid #9ca3af'};">
                        <span class="font-medium">${scorer.name}</span>
                        <div class="text-right">
                          <span class="font-bold">${formatScoreDisplay(scorer.total, isFootball)}</span>
                          ${breakdownText ? `<div class="text-xs text-gray-400">${breakdownText}</div>` : ''}
                        </div>
                      </div>
                    `;
                  }).join('')}
                </div>
              ` : `
                <div class="text-center text-gray-400 text-sm py-4">
                  No scorers yet
                </div>
              `}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }
  
  // Calculate player scorers with shot type breakdown
  function calculatePlayerScorers(match, teamName, isFootball) {
    const team = match.team1.name === teamName ? match.team1 : match.team2;
    const teamId = team.id;
    
    // Get all scoring events for this team
    const scoringEvents = match.events.filter(event => 
      event.type === EventType.SHOT && 
      event.teamId === teamId && 
      (event.shotOutcome === ShotOutcome.GOAL || 
       event.shotOutcome === ShotOutcome.POINT || 
       event.shotOutcome === ShotOutcome.TWO_POINTER)
    );
    
    // Group by player
    const playerStats = {};
    
    scoringEvents.forEach(event => {
      let player;
      let playerId;
      
      if (!event.player1Id) {
        // Handle events without player assignment
        playerId = 'unknown';
        player = { id: 'unknown', name: 'unknown', jerseyNumber: '?' };
      } else {
        player = team.players.find(p => p.id === event.player1Id);
        playerId = event.player1Id;
        
        if (!player) {
          // Handle case where player ID exists but player not found
          playerId = 'unknown';
          player = { id: 'unknown', name: 'unknown', jerseyNumber: '?' };
        }
      }
      
      if (!playerStats[playerId]) {
        playerStats[playerId] = {
          name: player.name,
          jerseyNumber: player.jerseyNumber,
          total: { goals: 0, points: 0, twoPointers: 0 },
          free: { goals: 0, points: 0, twoPointers: 0 },
          penalty: { goals: 0, points: 0, twoPointers: 0 }
        };
      }
      
      const stats = playerStats[playerId];
      const isFree = event.shotType === ShotType.FREE;
      const isPenalty = event.shotType === ShotType.PENALTY;
      
      // Add to totals
      if (event.shotOutcome === ShotOutcome.GOAL) {
        stats.total.goals++;
        if (isFree) stats.free.goals++;
        if (isPenalty) stats.penalty.goals++;
      } else if (event.shotOutcome === ShotOutcome.POINT) {
        stats.total.points++;
        if (isFree) stats.free.points++;
        if (isPenalty) stats.penalty.points++;
      } else if (event.shotOutcome === ShotOutcome.TWO_POINTER && isFootball) {
        stats.total.twoPointers++;
        if (isFree) stats.free.twoPointers++;
        if (isPenalty) stats.penalty.twoPointers++;
      }
    });
    
    // Convert to array and calculate scores
    const scorers = Object.values(playerStats).map(player => {
      const totalScore = player.total.goals * 3 + player.total.points + (isFootball ? player.total.twoPointers * 2 : 0);
      const freeScore = player.free.goals * 3 + player.free.points + (isFootball ? player.free.twoPointers * 2 : 0);
      const penaltyScore = player.penalty.goals * 3 + player.penalty.points + (isFootball ? player.penalty.twoPointers * 2 : 0);
      
      return {
        name: player.name,
        jerseyNumber: player.jerseyNumber,
        total: player.total,
        totalScore: totalScore,
        freeBreakdown: freeScore > 0 ? player.free : null,
        penaltyBreakdown: penaltyScore > 0 ? player.penalty : null
      };
    });
    
    // Sort by total score (descending), then by name
    scorers.sort((a, b) => {
      if (a.totalScore !== b.totalScore) {
        return b.totalScore - a.totalScore;
      }
      return a.name.localeCompare(b.name);
    });
    
    return scorers;
  }
  
  // Calculate team shooting comparison data
  function calculateTeamShootingComparison(match) {
    const team1Name = match.team1.name;
    const team2Name = match.team2.name;
    
    // Get all shot events for each team
    const team1Shots = match.events.filter(e => 
      e.type === EventType.SHOT && e.teamId === match.team1.id
    );
    const team2Shots = match.events.filter(e => 
      e.type === EventType.SHOT && e.teamId === match.team2.id
    );
    
    // Calculate successful shots for each team
    const team1Successful = team1Shots.filter(s => 
      s.shotOutcome === ShotOutcome.GOAL || 
      s.shotOutcome === ShotOutcome.POINT || 
      s.shotOutcome === ShotOutcome.TWO_POINTER
    ).length;
    
    const team2Successful = team2Shots.filter(s => 
      s.shotOutcome === ShotOutcome.GOAL || 
      s.shotOutcome === ShotOutcome.POINT || 
      s.shotOutcome === ShotOutcome.TWO_POINTER
    ).length;
    
    // Calculate accuracy percentages
    const team1Accuracy = team1Shots.length > 0 ? 
      Math.round((team1Successful / team1Shots.length) * 100) : 0;
    const team2Accuracy = team2Shots.length > 0 ? 
      Math.round((team2Successful / team2Shots.length) * 100) : 0;
    
    return {
      team1: {
        name: team1Name,
        accuracy: team1Accuracy,
        successful: team1Successful,
        total: team1Shots.length
      },
      team2: {
        name: team2Name,
        accuracy: team2Accuracy,
        successful: team2Successful,
        total: team2Shots.length
      }
    };
  }
  
  // Calculate individual player shooting stats for a team
  function calculatePlayerShootingStats(match, teamName) {
    const team = match.team1.name === teamName ? match.team1 : match.team2;
    const teamId = team.id;
    
    // Get all shot events for this team
    const allShots = match.events.filter(event => 
      event.type === EventType.SHOT && event.teamId === teamId
    );
    
    // Group by player
    const playerStats = {};
    
    allShots.forEach(event => {
      let player;
      let playerId;
      
      if (!event.player1Id) {
        playerId = 'unknown';
        player = { id: 'unknown', name: 'Unknown Player', jerseyNumber: '?' };
      } else {
        player = team.players.find(p => p.id === event.player1Id);
        playerId = event.player1Id;
        
        if (!player) {
          playerId = 'unknown';
          player = { id: 'unknown', name: 'Unknown Player', jerseyNumber: '?' };
        }
      }
      
      if (!playerStats[playerId]) {
        playerStats[playerId] = {
          name: player.name,
          jerseyNumber: player.jerseyNumber,
          totalShots: 0,
          successfulShots: 0,
          breakdown: {
            goals: 0,
            points: 0,
            twoPointers: 0,
            wide: 0,
            saved: 0,
            droppedShort: 0,
            offPost: 0
          }
        };
      }
      
      const stats = playerStats[playerId];
      stats.totalShots++;
      
      // Categorize the shot outcome
      if (event.shotOutcome === ShotOutcome.GOAL) {
        stats.successfulShots++;
        stats.breakdown.goals++;
      } else if (event.shotOutcome === ShotOutcome.POINT) {
        stats.successfulShots++;
        stats.breakdown.points++;
      } else if (event.shotOutcome === ShotOutcome.TWO_POINTER) {
        stats.successfulShots++;
        stats.breakdown.twoPointers++;
      } else if (event.shotOutcome === ShotOutcome.WIDE) {
        stats.breakdown.wide++;
      } else if (event.shotOutcome === ShotOutcome.SAVED) {
        stats.breakdown.saved++;
      } else if (event.shotOutcome === ShotOutcome.DROPPED_SHORT) {
        stats.breakdown.droppedShort++;
      } else if (event.shotOutcome === ShotOutcome.OFF_POST) {
        stats.breakdown.offPost++;
      }
    });
    
    // Convert to array and calculate accuracy
    const playerArray = Object.values(playerStats).map(player => ({
      ...player,
      accuracy: player.totalShots > 0 ? Math.round((player.successfulShots / player.totalShots) * 100) : 0
    }));
    
    // Sort by total shots attempted (most active shooters first)
    return playerArray.sort((a, b) => {
      if (b.totalShots !== a.totalShots) {
        return b.totalShots - a.totalShots;
      }
      return a.name.localeCompare(b.name);
    });
  }
  
  // Format score display based on match type
  function formatScoreDisplay(score, isFootball) {
    if (isFootball) {
      // For football, combine points and two-pointers in the points total
      const totalPoints = score.points + (score.twoPointers || 0);
      return `${score.goals}-${totalPoints.toString().padStart(2, '0')}`;
    } else {
      return `${score.goals}-${score.points.toString().padStart(2, '0')}`;
    }
  }
  
  // Main function to render all shooting accuracy cards
  function renderShootingAccuracyCards(stats) {
    const container = document.getElementById('stats-accuracy-cards');
    if (!container) {
      console.error('Stats accuracy cards container not found');
      return;
    }
    
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      console.error('No match found for accuracy cards');
      return;
    }
    
    // Calculate data for all cards
    const comparisonStats = calculateTeamShootingComparison(match);
    const team1PlayerStats = calculatePlayerShootingStats(match, match.team1.name);
    const team2PlayerStats = calculatePlayerShootingStats(match, match.team2.name);
    
    // Render all three cards
    const comparisonCard = renderTeamComparisonCard(comparisonStats);
    const team1PlayerCard = renderPlayerShootingCard(match.team1.name, comparisonStats.team1, team1PlayerStats);
    const team2PlayerCard = renderPlayerShootingCard(match.team2.name, comparisonStats.team2, team2PlayerStats);
    
    container.innerHTML = comparisonCard + team1PlayerCard + team2PlayerCard;
  }
  
  // Render team comparison accuracy card
  function renderTeamComparisonCard(comparisonStats) {
    const { team1, team2 } = comparisonStats;
    
    // Color coding based on accuracy
    const getAccuracyColor = (accuracy) => {
      if (accuracy >= 70) return 'text-green-400';
      if (accuracy >= 50) return 'text-yellow-400';
      return 'text-red-400';
    };
    
    return `
      <div class="bg-gray-700 rounded-lg p-3 mb-4">
        <div class="flex justify-between items-center px-3 mb-3">
          <h3 class="text-lg font-bold">Team Shooting Accuracy</h3>
          <button class="text-blue-400 hover:text-blue-300 p-3 flex items-center justify-center" onclick="shareComparisonCard()" title="Share">
            <img src="icons/share.svg" alt="Share" class="w-8 h-8" />
          </button>
        </div>
        
        <div class="grid grid-cols-2 gap-4">
          <!-- Team 1 -->
          <div class="text-center">
            <div class="text-lg font-bold text-gray-200 mb-1">${team1.name}</div>
            <div class="text-4xl font-bold ${getAccuracyColor(team1.accuracy)} leading-none">${team1.accuracy}%</div>
            <div class="text-sm text-gray-400 mt-1">${team1.successful}/${team1.total} shots</div>
          </div>
          
          <!-- Divider -->
          <div class="text-center">
            <div class="text-lg font-bold text-gray-200 mb-1">${team2.name}</div>
            <div class="text-4xl font-bold ${getAccuracyColor(team2.accuracy)} leading-none">${team2.accuracy}%</div>
            <div class="text-sm text-gray-400 mt-1">${team2.successful}/${team2.total} shots</div>
          </div>
        </div>
      </div>
    `;
  }
  
  // Render individual team player shooting card
  function renderPlayerShootingCard(teamName, teamStats, playerStats) {
    const formatShotBreakdown = (breakdown) => {
      const parts = [];
      if (breakdown.goals > 0) parts.push(`${breakdown.goals}G`);
      if (breakdown.points > 0) parts.push(`${breakdown.points}P`);
      if (breakdown.twoPointers > 0) parts.push(`${breakdown.twoPointers}×2P`);
      
      const successText = parts.length > 0 ? parts.join(' ') : '';
      
      const missParts = [];
      if (breakdown.wide > 0) missParts.push(`${breakdown.wide}W`);
      if (breakdown.saved > 0) missParts.push(`${breakdown.saved}S`);
      if (breakdown.droppedShort > 0) missParts.push(`${breakdown.droppedShort}DS`);
      if (breakdown.offPost > 0) missParts.push(`${breakdown.offPost}OP`);
      
      const missText = missParts.length > 0 ? `(${missParts.join(' ')})` : '';
      
      return `${successText} ${missText}`.trim();
    };
    
    return `
      <div class="bg-gray-700 rounded-lg p-3 mb-4">
        <div class="flex justify-between items-center px-3">
          <h3 class="text-lg font-bold">${teamName} Shooting</h3>
          <button class="text-blue-400 hover:text-blue-300 p-3 flex items-center justify-center" onclick="sharePlayerShootingCard('${teamName}')" title="Share">
            <img src="icons/share.svg" alt="Share" class="w-8 h-8" />
          </button>
        </div>
        
        <div class="text-center mb-3">
          <div class="text-2xl font-bold text-blue-400 leading-none">${teamStats.accuracy}%</div>
          <div class="text-sm text-gray-400 -mt-1">${teamStats.successful}/${teamStats.total} shots</div>
        </div>
        
        <!-- Legend -->
        <div class="text-center text-xs text-gray-500 mb-3 px-3">
          <div>Legend: G=Goals, P=Points, 2P=Two-Pointers, W=Wide, S=Saved, DS=Dropped Short, OP=Off Post</div>
        </div>
        
        ${playerStats.length > 0 ? `
          <div class="px-3">
            <h4 class="text-sm font-semibold text-green-400 mb-2">Player Shooting</h4>
            ${playerStats.map((player, index) => {
              const isLast = index === playerStats.length - 1;
              const shotBreakdownText = formatShotBreakdown(player.breakdown);
              
              return `
                <div class="flex justify-between items-center text-sm py-2" style="border-bottom: ${isLast ? 'none' : '1px solid #9ca3af'};">
                  <span class="font-medium">${player.name}</span>
                  <div class="text-right">
                    <span class="font-bold">${player.accuracy}% (${player.successfulShots}/${player.totalShots})</span>
                    ${shotBreakdownText ? `<div class="text-xs text-gray-400">${shotBreakdownText}</div>` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        ` : `
          <div class="text-center text-gray-400 text-sm py-4">
            No shots taken yet
          </div>
        `}
      </div>
    `;
  }
  
  // Share individual team card
  async function shareTeamCard(teamName) {
    console.log('shareTeamCard called with teamName:', teamName);
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      console.error('No match found');
      return;
    }
    
    const stats = StatsCalculator.calculateMatchStats(match);
    console.log('Stats calculated:', stats);
    const teamStats = stats.teams[teamName];
    if (!teamStats) {
      console.error('Team stats not found for:', teamName);
      return;
    }
    
    const isFootball = stats.match.matchType === 'football' || stats.match.matchType === 'ladiesFootball';
    const scorers = calculatePlayerScorers(match, teamName, isFootball);
    console.log('Scorers calculated:', scorers);
    
    try {
      // Generate scorer card image
      const imageBlob = await generateScorerCardImage(match, teamName, teamStats, scorers);
      
      // Try using Web Share API first (mobile)
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([imageBlob], 'scorer-card.png', { type: 'image/png' })] })) {
        const file = new File([imageBlob], `${teamName.replace(/\s+/g, '-')}-scorers.png`, { type: 'image/png' });
        await navigator.share({
          title: `${teamName} Scorers`,
          text: `${teamName} scoring statistics`,
          files: [file]
        });
        return;
      }
      
      // Fallback: Create download link
      const url = URL.createObjectURL(imageBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${teamName.replace(/\s+/g, '-')}-scorers.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
    } catch (error) {
      console.error('Error sharing scorer card:', error);
      alert('Unable to share scorer card. Please try again.');
    }
  }
  
  // Make shareTeamCard globally accessible for onclick handlers
  window.shareTeamCard = shareTeamCard;
  
  // Share team comparison accuracy card
  async function shareComparisonCard() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      console.error('No match found');
      return;
    }
    
    const comparisonStats = calculateTeamShootingComparison(match);
    
    try {
      // Generate comparison card image
      const imageBlob = await generateComparisonCardImage(match, comparisonStats);
      
      // Try using Web Share API first (mobile)
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([imageBlob], 'accuracy-comparison.png', { type: 'image/png' })] })) {
        const file = new File([imageBlob], 'accuracy-comparison.png', { type: 'image/png' });
        await navigator.share({
          title: 'Team Shooting Accuracy',
          text: `${match.team1.name} vs ${match.team2.name} shooting accuracy`,
          files: [file]
        });
        return;
      }
      
      // Fallback: Create download link
      const url = URL.createObjectURL(imageBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'team-accuracy-comparison.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      showShareSuccessMessage('Accuracy comparison downloaded to your device!');
      
    } catch (error) {
      console.error('Error sharing comparison card:', error);
      showShareSuccessMessage('Unable to share comparison card. Please try again.');
    }
  }
  
  // Share individual team player shooting card
  async function sharePlayerShootingCard(teamName) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      console.error('No match found');
      return;
    }
    
    const comparisonStats = calculateTeamShootingComparison(match);
    const teamStats = teamName === match.team1.name ? comparisonStats.team1 : comparisonStats.team2;
    const playerStats = calculatePlayerShootingStats(match, teamName);
    
    try {
      // Generate player shooting card image
      const imageBlob = await generatePlayerShootingCardImage(match, teamName, teamStats, playerStats);
      
      // Try using Web Share API first (mobile)
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([imageBlob], 'player-shooting.png', { type: 'image/png' })] })) {
        const file = new File([imageBlob], `${teamName.replace(/\s+/g, '-')}-shooting.png`, { type: 'image/png' });
        await navigator.share({
          title: `${teamName} Shooting Stats`,
          text: `${teamName} player shooting statistics`,
          files: [file]
        });
        return;
      }
      
      // Fallback: Create download link
      const url = URL.createObjectURL(imageBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${teamName.replace(/\s+/g, '-')}-shooting-stats.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      showShareSuccessMessage(`${teamName} shooting stats downloaded to your device!`);
      
    } catch (error) {
      console.error('Error sharing player shooting card:', error);
      showShareSuccessMessage('Unable to share shooting stats. Please try again.');
    }
  }
  
  // Make sharing functions globally accessible for onclick handlers
  window.shareComparisonCard = shareComparisonCard;
  window.sharePlayerShootingCard = sharePlayerShootingCard;

  // ===== Shared share-card primitives =====
  // Preload grass image once; reused across all share-card generators.
  let _grassImage = null;
  let _grassImageReady = false;
  let _grassImagePromise = null;
  function loadGrassImage() {
    if (_grassImagePromise) return _grassImagePromise;
    _grassImagePromise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { _grassImage = img; _grassImageReady = true; resolve(); };
      img.onerror = () => { _grassImageReady = false; resolve(); };
      img.src = 'icons/grassbackground.jpg';
    });
    return _grassImagePromise;
  }
  // Kick off preload at module init
  loadGrassImage();

  const SHARE_FONT = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';

  function drawShareBackground(ctx, w, h) {
    if (_grassImageReady && _grassImage) {
      // Cover: scale image to fully cover canvas, centered
      const ir = _grassImage.width / _grassImage.height;
      const cr = w / h;
      let dw, dh, dx, dy;
      if (ir > cr) {
        dh = h; dw = h * ir; dx = (w - dw) / 2; dy = 0;
      } else {
        dw = w; dh = w / ir; dx = 0; dy = (h - dh) / 2;
      }
      ctx.drawImage(_grassImage, dx, dy, dw, dh);
      // Dark overlay for legibility
      const overlay = ctx.createLinearGradient(0, 0, 0, h);
      overlay.addColorStop(0, 'rgba(0,0,0,0.55)');
      overlay.addColorStop(0.5, 'rgba(0,0,0,0.35)');
      overlay.addColorStop(1, 'rgba(0,0,0,0.6)');
      ctx.fillStyle = overlay;
      ctx.fillRect(0, 0, w, h);
    } else {
      // Fallback: existing flat gradient
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, '#1f2937');
      gradient.addColorStop(1, '#111827');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    }
  }

  function getMatchTypeLabel(matchType) {
    const map = {
      football: 'FOOTBALL',
      hurling: 'HURLING',
      ladiesFootball: 'LADIES FOOTBALL',
      camogie: 'CAMOGIE'
    };
    return map[matchType] || '';
  }

  // Tracked uppercase subtitle — emulates letter-spacing by drawing chars with manual advance.
  function drawTrackedText(ctx, text, x, y, trackingPx) {
    const chars = text.split('');
    const widths = chars.map((c) => ctx.measureText(c).width);
    let total = widths.reduce((s, w) => s + w, 0) + trackingPx * (chars.length - 1);
    let cx = x - total / 2;
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], cx, y);
      cx += widths[i] + trackingPx;
    }
  }

  function drawShareHeader(ctx, w, competition, matchType) {
    // Competition title
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 44px ${SHARE_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let title = competition || 'Match Update';
    // Ellipsis if too wide
    const maxTitleWidth = w - 120;
    if (ctx.measureText(title).width > maxTitleWidth) {
      while (title.length > 1 && ctx.measureText(title + '…').width > maxTitleWidth) {
        title = title.slice(0, -1);
      }
      title += '…';
    }
    ctx.fillText(title, w / 2, 100);

    // Tracked uppercase subtitle
    const subtitle = getMatchTypeLabel(matchType);
    if (subtitle) {
      ctx.fillStyle = '#d1d5db';
      ctx.font = `600 22px ${SHARE_FONT}`;
      ctx.textAlign = 'left';
      drawTrackedText(ctx, subtitle, w / 2, 145, 4);
    }
    ctx.textAlign = 'center';
  }

  function drawPinIcon(ctx, x, y, size, color) {
    // x,y is the top-left of the icon bounding box; size = full height
    ctx.save();
    ctx.fillStyle = color;
    const w = size * 0.7;
    const cx = x + w / 2;
    const headR = size * 0.32;
    const headCy = y + headR;
    // Teardrop body (head + downward triangle)
    ctx.beginPath();
    ctx.arc(cx, headCy, headR, Math.PI, 0, false);
    ctx.lineTo(cx, y + size);
    ctx.closePath();
    ctx.fill();
    // Inner hole
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(cx, headCy, headR * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPill(ctx, cx, cy, text, bgColor, textColor) {
    ctx.font = `bold 26px ${SHARE_FONT}`;
    const padX = 32;
    const h = 64;
    const textW = ctx.measureText(text).width;
    const w = textW + padX * 2;
    const x = cx - w / 2;
    const y = cy - h / 2;
    const r = h / 2;
    // Shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Text
    ctx.fillStyle = textColor;
    ctx.font = `bold 26px ${SHARE_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 1);
    ctx.textBaseline = 'alphabetic';
  }

  function formatShareDate(dateTime) {
    if (!dateTime) return '';
    const d = new Date(dateTime);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function drawShareFooter(ctx, w, y, venue, dateText) {
    // Centered group: [pin] venue · date  (any element may be absent)
    const parts = [];
    if (venue) parts.push({ kind: 'venue', text: venue });
    if (dateText) parts.push({ kind: 'date', text: dateText });
    if (parts.length === 0) return;

    ctx.font = `500 24px ${SHARE_FONT}`;
    const dotSep = '  ·  ';
    const dotW = ctx.measureText(dotSep).width;
    const pinSize = 22;
    const pinGap = 10;

    let totalW = 0;
    if (parts[0].kind === 'venue') totalW += pinSize + pinGap;
    parts.forEach((p, i) => {
      totalW += ctx.measureText(p.text).width;
      if (i < parts.length - 1) totalW += dotW;
    });

    let cx = (w - totalW) / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#d1d5db';

    parts.forEach((p, i) => {
      if (p.kind === 'venue') {
        // pin baseline-aligned to text
        drawPinIcon(ctx, cx, y - pinSize + 4, pinSize, '#d1d5db');
        cx += pinSize + pinGap;
      }
      ctx.fillStyle = '#d1d5db';
      ctx.font = `500 24px ${SHARE_FONT}`;
      ctx.fillText(p.text, cx, y);
      cx += ctx.measureText(p.text).width;
      if (i < parts.length - 1) {
        ctx.fillText(dotSep, cx, y);
        cx += dotW;
      }
    });
    ctx.textAlign = 'center';
  }

  // Generate match share image using Canvas
  function generateMatchShareImage(match, team1Score, team2Score) {
    return loadGrassImage().then(() => new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const W = 800, H = 800;
      canvas.width = W;
      canvas.height = H;

      drawShareBackground(ctx, W, H);
      drawShareHeader(ctx, W, match.competition, match.matchType);

      // Team rows
      const team1Y = 340;
      const team2Y = 500;
      drawTeamRow(ctx, W, match.team1.name, team1Score, team1Y);
      drawVsDivider(ctx, W, 420);
      drawTeamRow(ctx, W, match.team2.name, team2Score, team2Y);

      // Time/period pill
      const period = (match.currentPeriod || '').toUpperCase();
      const pillText = `${formatTimeForSharing(match.elapsedTime)}  ·  ${period}`;
      drawPill(ctx, W / 2, 645, pillText, '#22c55e', '#ffffff');

      // Footer: pin + venue · date
      drawShareFooter(ctx, W, 740, match.venue || '', formatShareDate(match.dateTime));

      canvas.toBlob((blob) => resolve(blob), 'image/png', 0.92);
    }));
  }

  // Draw a single team row: name left, score G-PP right with muted (total) suffix.
  function drawTeamRow(ctx, w, teamName, score, y) {
    const rightEdge = w - 70;
    const leftEdge = 70;

    // Score `(NN)` (drawn first so we know its width to right-align)
    ctx.fillStyle = '#cbd5e1';
    ctx.font = `500 36px ${SHARE_FONT}`;
    const totalText = `(${score.total})`;
    const totalW = ctx.measureText(totalText).width;

    // Main score
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 80px ${SHARE_FONT}`;
    ctx.textAlign = 'right';
    const mainScore = `${score.goals}-${score.points.toString().padStart(2, '0')}`;
    const mainScoreX = rightEdge - totalW - 16;
    ctx.fillText(mainScore, mainScoreX, y);

    // (Total) — baseline-aligned to main score
    ctx.fillStyle = '#cbd5e1';
    ctx.font = `500 36px ${SHARE_FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(totalText, mainScoreX + 16, y);

    // Team name (auto-shrink if it would collide with score)
    let nameSize = 52;
    ctx.font = `bold ${nameSize}px ${SHARE_FONT}`;
    const maxNameW = mainScoreX - ctx.measureText(mainScore).width - leftEdge - 30;
    while (nameSize > 32 && ctx.measureText(teamName).width > maxNameW) {
      nameSize -= 2;
      ctx.font = `bold ${nameSize}px ${SHARE_FONT}`;
    }
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(teamName, leftEdge, y);

    ctx.textAlign = 'center';
  }

  function drawVsDivider(ctx, w, y) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(70, y);
    ctx.lineTo(370, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(430, y);
    ctx.lineTo(730, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `italic 28px ${SHARE_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('vs', w / 2, y);
    ctx.textBaseline = 'alphabetic';
  }

  // Generate team scorer card share image using Canvas
  function generateScorerCardImage(match, teamName, teamStats, scorers) {
    return loadGrassImage().then(() => new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      canvas.width = 800;
      const maxScorers = Math.min(scorers.length, 10);
      const teamsHeaderEnd = 470;        // y where teams block ends
      const scorerStartY = 470;          // first scorer row top — closer to match score
      const rowHeight = 82;              // tighter padding per row
      const footerHeight = 110;
      const extraHeight = scorers.length > maxScorers ? 40 : 0;
      const noScorersFill = scorers.length === 0 ? 100 : 0;

      canvas.height = Math.max(
        880,
        scorerStartY + (maxScorers * rowHeight) + extraHeight + footerHeight + noScorersFill
      );

      drawShareBackground(ctx, canvas.width, canvas.height);

      // ===== Header =====
      // Competition title
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold 44px ${SHARE_FONT}`;
      ctx.textAlign = 'center';
      let title = match.competition || 'Match Update';
      const maxTitleWidth = canvas.width - 120;
      if (ctx.measureText(title).width > maxTitleWidth) {
        while (title.length > 1 && ctx.measureText(title + '…').width > maxTitleWidth) {
          title = title.slice(0, -1);
        }
        title += '…';
      }
      ctx.fillText(title, canvas.width / 2, 100);

      // Subtitle: "{team}  -  SCORERS" (tracked, muted) — team name keeps its original case
      ctx.fillStyle = '#d1d5db';
      ctx.font = `600 22px ${SHARE_FONT}`;
      drawTrackedText(ctx, `${teamName}  -  SCORERS`, canvas.width / 2, 150, 4);

      // ===== Teams block (featured vs opponent) =====
      const isTeam1Featured = match.team1.name === teamName;
      const featuredKey = isTeam1Featured ? 'team1' : 'team2';
      const opponentKey = isTeam1Featured ? 'team2' : 'team1';
      const opponentName = match[opponentKey].name;
      const featuredScore = computeTeamScore(match, featuredKey);
      const opponentScore = computeTeamScore(match, opponentKey);

      const featuredX = canvas.width * 0.28;
      const opponentX = canvas.width * 0.72;
      const teamNameY = 260;
      const teamScoreY = 340;
      const teamTotalY = 395;

      // Featured team name
      ctx.fillStyle = '#ffffff';
      let fNameSize = 34;
      ctx.font = `bold ${fNameSize}px ${SHARE_FONT}`;
      while (fNameSize > 22 && ctx.measureText(teamName).width > 320) {
        fNameSize -= 2;
        ctx.font = `bold ${fNameSize}px ${SHARE_FONT}`;
      }
      ctx.fillText(teamName, featuredX, teamNameY);

      // Featured team score
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold 72px ${SHARE_FONT}`;
      const fScoreText = `${featuredScore.goals}-${featuredScore.points.toString().padStart(2, '0')}`;
      ctx.fillText(fScoreText, featuredX, teamScoreY);

      // Featured (total)
      ctx.fillStyle = '#cbd5e1';
      ctx.font = `500 26px ${SHARE_FONT}`;
      ctx.fillText(`(${featuredScore.total})`, featuredX, teamTotalY);

      // Opponent team name (muted)
      ctx.fillStyle = 'rgba(229,231,235,0.55)';
      let oNameSize = 34;
      ctx.font = `500 ${oNameSize}px ${SHARE_FONT}`;
      while (oNameSize > 22 && ctx.measureText(opponentName).width > 320) {
        oNameSize -= 2;
        ctx.font = `500 ${oNameSize}px ${SHARE_FONT}`;
      }
      ctx.fillText(opponentName, opponentX, teamNameY);

      // Opponent team score (muted)
      ctx.fillStyle = 'rgba(229,231,235,0.55)';
      ctx.font = `bold 72px ${SHARE_FONT}`;
      const oScoreText = `${opponentScore.goals}-${opponentScore.points.toString().padStart(2, '0')}`;
      ctx.fillText(oScoreText, opponentX, teamScoreY);

      // Opponent (total)
      ctx.fillStyle = 'rgba(203,213,225,0.55)';
      ctx.font = `500 26px ${SHARE_FONT}`;
      ctx.fillText(`(${opponentScore.total})`, opponentX, teamTotalY);

      // "vs" centered between the team scores
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = `26px ${SHARE_FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText('vs', canvas.width / 2, teamScoreY - 12);
      ctx.textBaseline = 'alphabetic';

      // (No darker band — the existing background overlay carries through uniformly.)

      // ===== Scorer rows =====
      if (scorers.length > 0) {
        const isFootball = match.matchType === 'football' || match.matchType === 'ladiesFootball';
        let currentY = scorerStartY;

        for (let i = 0; i < maxScorers; i++) {
          const scorer = scorers[i];
          const mainY = currentY + rowHeight / 2 - 2;
          const breakdownY = currentY + rowHeight / 2 + 24;

          // Player name (left)
          ctx.fillStyle = '#ffffff';
          ctx.font = `500 32px ${SHARE_FONT}`;
          ctx.textAlign = 'left';
          ctx.fillText(scorer.name, 70, mainY);

          // Score (right, bold)
          const scoreDisplay = formatScoreDisplay(scorer.total, isFootball);
          ctx.fillStyle = '#ffffff';
          ctx.font = `bold 32px ${SHARE_FONT}`;
          ctx.textAlign = 'right';
          ctx.fillText(scoreDisplay, canvas.width - 70, mainY);

          // Breakdown (frees / penalties / two-pointers) below score
          const breakdowns = [];
          if (scorer.freeBreakdown) {
            breakdowns.push(`${formatScoreDisplay(scorer.freeBreakdown, isFootball)} f`);
          }
          if (scorer.penaltyBreakdown) {
            breakdowns.push(`${formatScoreDisplay(scorer.penaltyBreakdown, isFootball)} p`);
          }
          if (isFootball && scorer.total.twoPointers > 0) {
            breakdowns.push(`2p:${scorer.total.twoPointers}`);
          }
          if (breakdowns.length > 0) {
            ctx.fillStyle = '#e5e7eb';
            ctx.font = `500 22px ${SHARE_FONT}`;
            ctx.textAlign = 'right';
            ctx.fillText(`(${breakdowns.join(', ')})`, canvas.width - 70, breakdownY);
          }

          // Hairline divider
          if (i < maxScorers - 1) {
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(70, currentY + rowHeight);
            ctx.lineTo(canvas.width - 70, currentY + rowHeight);
            ctx.stroke();
          }

          currentY += rowHeight;
        }

        if (scorers.length > maxScorers) {
          ctx.fillStyle = 'rgba(203,213,225,0.8)';
          ctx.font = `20px ${SHARE_FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(`…and ${scorers.length - maxScorers} more`, canvas.width / 2, currentY + 10);
        }
      } else {
        ctx.fillStyle = 'rgba(203,213,225,0.85)';
        ctx.font = `26px ${SHARE_FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('No scorers yet', canvas.width / 2, scorerStartY + 60);
      }

      // ===== Footer (no pin, to match mockup) =====
      const dateText = formatShareDate(match.dateTime);
      const venueText = match.venue || '';
      const footerY = canvas.height - 50;
      ctx.fillStyle = '#d1d5db';
      ctx.font = `500 24px ${SHARE_FONT}`;
      ctx.textAlign = 'center';
      let footerText = '';
      if (venueText && dateText) footerText = `${venueText}  ·  ${dateText}`;
      else footerText = venueText || dateText;
      if (footerText) ctx.fillText(footerText, canvas.width / 2, footerY);

      canvas.toBlob((blob) => resolve(blob), 'image/png', 0.92);
    }));
  }

  // Generate team comparison card share image using Canvas
  function generateComparisonCardImage(match, comparisonStats) {
    return loadGrassImage().then(() => new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 800;
      canvas.height = 700;

      drawShareBackground(ctx, canvas.width, canvas.height);
      drawShareHeader(ctx, canvas.width, match.competition || 'Shooting Accuracy', match.matchType);

      // Subheading
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold 32px ${SHARE_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('Shooting Accuracy', canvas.width / 2, 230);

      // Team comparison
      const team1X = canvas.width * 0.25;
      const team2X = canvas.width * 0.75;
      const statsY = 340;

      const drawTeam = (x, stats) => {
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 30px ${SHARE_FONT}`;
        ctx.textAlign = 'center';
        // Auto-shrink long team names
        let nameSize = 30;
        const maxW = canvas.width / 2 - 60;
        while (nameSize > 20 && ctx.measureText(stats.name).width > maxW) {
          nameSize -= 2;
          ctx.font = `bold ${nameSize}px ${SHARE_FONT}`;
        }
        ctx.fillText(stats.name, x, statsY);

        const color = stats.accuracy >= 70 ? '#22c55e' :
                      stats.accuracy >= 50 ? '#eab308' : '#ef4444';
        ctx.fillStyle = color;
        ctx.font = `bold 72px ${SHARE_FONT}`;
        ctx.fillText(`${stats.accuracy}%`, x, statsY + 90);

        ctx.fillStyle = '#cbd5e1';
        ctx.font = `500 24px ${SHARE_FONT}`;
        ctx.fillText(`${stats.successful}/${stats.total} shots`, x, statsY + 130);
      };

      drawTeam(team1X, comparisonStats.team1);
      drawTeam(team2X, comparisonStats.team2);

      // Center divider
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(canvas.width / 2, statsY - 30);
      ctx.lineTo(canvas.width / 2, statsY + 140);
      ctx.stroke();

      // Footer
      drawShareFooter(ctx, canvas.width, canvas.height - 40, match.venue || '', formatShareDate(match.dateTime));

      canvas.toBlob((blob) => resolve(blob), 'image/png', 0.92);
    }));
  }

  // Generate team player shooting card share image using Canvas
  function generatePlayerShootingCardImage(match, teamName, teamStats, playerStats) {
    return loadGrassImage().then(() => new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      canvas.width = 800;
      const maxPlayers = Math.min(playerStats.length, 10);
      const headerHeight = 360;
      const rowHeight = 90;
      const playersHeight = maxPlayers * rowHeight;
      const footerHeight = 160;
      const extraHeight = playerStats.length > maxPlayers ? 40 : 0;

      canvas.height = Math.max(720, headerHeight + playersHeight + footerHeight + extraHeight);

      drawShareBackground(ctx, canvas.width, canvas.height);
      drawShareHeader(ctx, canvas.width, teamName, match.matchType);

      // Team accuracy
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold 64px ${SHARE_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${teamStats.accuracy}%`, canvas.width / 2, 230);

      ctx.fillStyle = '#cbd5e1';
      ctx.font = `500 26px ${SHARE_FONT}`;
      ctx.fillText(`${teamStats.successful}/${teamStats.total} shots`, canvas.width / 2, 270);

      // Players section
      if (playerStats.length > 0) {
        ctx.fillStyle = '#22c55e';
        ctx.font = `bold 28px ${SHARE_FONT}`;
        ctx.textAlign = 'left';
        ctx.fillText('Player Shooting', 70, 330);

        const displayPlayers = playerStats.slice(0, maxPlayers);
        displayPlayers.forEach((player, index) => {
          const top = 360 + (index * rowHeight);
          const mainY = top + rowHeight / 2 + 4;

          ctx.fillStyle = '#ffffff';
          ctx.font = `bold 26px ${SHARE_FONT}`;
          ctx.textAlign = 'left';
          const playerName = player.name || `Player ${player.jerseyNumber}`;
          ctx.fillText(playerName, 70, mainY);

          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'right';
          ctx.fillText(`${player.accuracy}% (${player.successfulShots}/${player.totalShots})`, canvas.width - 70, mainY);

          // Shot breakdown
          const successParts = [];
          if (player.breakdown.goals > 0) successParts.push(`${player.breakdown.goals}G`);
          if (player.breakdown.points > 0) successParts.push(`${player.breakdown.points}P`);
          if (player.breakdown.twoPointers > 0) successParts.push(`${player.breakdown.twoPointers}×2P`);

          const missParts = [];
          if (player.breakdown.wide > 0) missParts.push(`${player.breakdown.wide}W`);
          if (player.breakdown.saved > 0) missParts.push(`${player.breakdown.saved}S`);
          if (player.breakdown.droppedShort > 0) missParts.push(`${player.breakdown.droppedShort}DS`);
          if (player.breakdown.offPost > 0) missParts.push(`${player.breakdown.offPost}OP`);

          const successText = successParts.length > 0 ? successParts.join(' ') : '';
          const missText = missParts.length > 0 ? `(${missParts.join(' ')})` : '';
          const breakdownText = `${successText} ${missText}`.trim();

          if (breakdownText) {
            ctx.fillStyle = '#cbd5e1';
            ctx.font = `20px ${SHARE_FONT}`;
            ctx.fillText(breakdownText, canvas.width - 70, mainY + 26);
          }

          // Divider
          if (index < displayPlayers.length - 1) {
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(70, top + rowHeight);
            ctx.lineTo(canvas.width - 70, top + rowHeight);
            ctx.stroke();
          }
        });

        if (playerStats.length > maxPlayers) {
          const remainingY = 360 + (maxPlayers * rowHeight) + 30;
          ctx.fillStyle = '#cbd5e1';
          ctx.font = `20px ${SHARE_FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(`... and ${playerStats.length - maxPlayers} more players`, canvas.width / 2, remainingY);
        }
      } else {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = `28px ${SHARE_FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('No shots taken yet', canvas.width / 2, 400);
      }

      // Legend
      ctx.fillStyle = '#cbd5e1';
      ctx.font = `18px ${SHARE_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('Success: G=Goals, P=Points, 2P=Two-Pointers', canvas.width / 2, canvas.height - 90);
      ctx.fillText('Misses: W=Wide, S=Saved, DS=Dropped Short, OP=Off Post', canvas.width / 2, canvas.height - 65);

      // Footer
      drawShareFooter(ctx, canvas.width, canvas.height - 30, match.venue || '', formatShareDate(match.dateTime));

      canvas.toBlob((blob) => resolve(blob), 'image/png', 0.92);
    }));
  }

  // Generate share image for individual event
  function generateEventShareImage(match, event, runningScore) {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // Set canvas size for social sharing (Instagram-style square)
      canvas.width = 800;
      canvas.height = 800;

      // Background gradient
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, '#1f2937'); // gray-800
      gradient.addColorStop(1, '#111827'); // gray-900
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Competition header
      ctx.fillStyle = '#f3f4f6'; // gray-100
      ctx.font = 'bold 38px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(match.competition || 'Match Update', canvas.width / 2, 80);

      let currentY = 160;

      // Event type/outcome with flag emoji for scoring events
      const outcomeText = event.shotOutcome ?
        event.shotOutcome.replace(/([A-Z])/g, ' $1').replace(/\b\w/g, (l) => l.toUpperCase()) :
        event.type === EventType.FOUL_CONCEDED ? 'Foul' :
        event.type === EventType.CARD ? `${event.cardType} Card` :
        event.type === EventType.KICKOUT ? `Kick-out ${event.wonKickout ? 'Won' : 'Lost'}` :
        event.type === EventType.SUBSTITUTION ? 'Substitution' :
        event.type === EventType.NOTE ? 'Note' :
        event.type === EventType.PERIOD_END ? event.period : '';

      // Draw flag icon for scoring outcomes, then text
      if (event.type === EventType.SHOT &&
          (event.shotOutcome === ShotOutcome.GOAL ||
           event.shotOutcome === ShotOutcome.POINT ||
           event.shotOutcome === ShotOutcome.TWO_POINTER)) {

        // Measure text width to calculate flag position
        ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        const textWidth = ctx.measureText(outcomeText).width;
        const flagSize = 32;
        const spacing = 15;
        const totalWidth = flagSize + spacing + textWidth;
        const startX = (canvas.width - totalWidth) / 2;

        // Draw flag shape (pole + rectangular flag)
        const flagX = startX;
        const flagY = currentY - 28;

        // Pole
        ctx.fillStyle = '#9ca3af'; // gray pole
        ctx.fillRect(flagX, flagY, 3, 36);

        // Flag rectangle (waving to the right)
        const flagWidth = flagSize;
        const flagHeight = 20;

        if (event.shotOutcome === ShotOutcome.GOAL) {
          ctx.fillStyle = '#22C55E'; // green
        } else if (event.shotOutcome === ShotOutcome.POINT) {
          ctx.fillStyle = '#FFFFFF'; // white
        } else if (event.shotOutcome === ShotOutcome.TWO_POINTER) {
          ctx.fillStyle = '#FB923C'; // orange
        }
        ctx.fillRect(flagX + 3, flagY + 2, flagWidth, flagHeight);

        // Draw outcome text beside flag
        ctx.fillStyle = '#f3f4f6'; // white text
        ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(outcomeText, flagX + flagSize + spacing, currentY);
        currentY += 70;
      } else {
        // Plain text for non-scoring events (no flag)
        ctx.fillStyle = '#f3f4f6'; // white
        ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(outcomeText, canvas.width / 2, currentY);
        currentY += 70;
      }

      // For period end events, add time elapsed line
      if (event.type === EventType.PERIOD_END) {
        const minutes = Math.floor(event.timeElapsed / 60);
        ctx.fillStyle = '#9ca3af'; // gray-400
        ctx.font = '32px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${minutes} min`, canvas.width / 2, currentY);
        currentY += 60;
      }

      // Team name (more prominent - larger and white)
      const team = event.teamId ? (event.teamId === match.team1.id ? match.team1 : match.team2) : null;
      if (team) {
        ctx.fillStyle = '#f3f4f6'; // white (was gray-400)
        ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'; // 48px (was 32px)
        ctx.textAlign = 'center';
        ctx.fillText(team.name, canvas.width / 2, currentY);
        currentY += 70;
      }

      // Player info
      const getPlayer = (playerId) => {
        if (!playerId) return null;
        return match.team1.players.find((p) => p.id === playerId) ||
               match.team2.players.find((p) => p.id === playerId) || null;
      };

      if (event.type === EventType.SHOT || event.type === EventType.FOUL_CONCEDED ||
          event.type === EventType.CARD || event.type === EventType.KICKOUT) {
        const player = getPlayer(event.player1Id);
        if (player) {
          const defaultName = `No.${player.jerseyNumber}`;
          let playerText = `#${player.jerseyNumber}`;
          if (player.name && player.name !== defaultName) {
            playerText += ` ${player.name}`;
          }
          ctx.fillStyle = '#f3f4f6'; // gray-100
          ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(playerText, canvas.width / 2, currentY);
          currentY += 60;
        }
      }

      // Substitution players
      if (event.type === EventType.SUBSTITUTION) {
        const playerOut = getPlayer(event.player1Id);
        const playerIn = getPlayer(event.player2Id);
        const outStr = playerOut ?
          `#${playerOut.jerseyNumber}${playerOut.name && playerOut.name !== `No.${playerOut.jerseyNumber}` ? ' ' + playerOut.name : ''}` : '';
        const inStr = playerIn ?
          `#${playerIn.jerseyNumber}${playerIn.name && playerIn.name !== `No.${playerIn.jerseyNumber}` ? ' ' + playerIn.name : ''}` : '';
        ctx.fillStyle = '#f3f4f6'; // gray-100
        ctx.font = '32px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${outStr} ⟶ ${inStr}`, canvas.width / 2, currentY);
        currentY += 60;
      }

      // Shot type for shot events (now before time)
      if (event.type === EventType.SHOT && event.shotType) {
        const shotTypeMap = {
          fromPlay: 'From Play',
          free: 'Free',
          penalty: 'Penalty',
          fortyFive: '45m/65m',
          sixtyFive: '45m/65m',
          sideline: 'Sideline',
          mark: 'Mark'
        };
        const shotTypeText = shotTypeMap[event.shotType] || event.shotType;
        ctx.fillStyle = '#9ca3af'; // gray-400
        ctx.font = '26px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(shotTypeText, canvas.width / 2, currentY);
        currentY += 50;
      }

      // Time and period (now after shot type) - skip for period end events
      if (event.type !== EventType.PERIOD_END) {
        const minutes = Math.floor(event.timeElapsed / 60);
        ctx.fillStyle = '#9ca3af'; // gray-400
        ctx.font = '28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${minutes} min - ${event.period}`, canvas.width / 2, currentY);
        currentY += 50;
      }

      // Foul type for foul events
      if (event.type === EventType.FOUL_CONCEDED) {
        let foulText = event.foulOutcome ? event.foulOutcome.charAt(0).toUpperCase() + event.foulOutcome.slice(1) : '';
        if (event.cardType) {
          foulText += ` + ${event.cardType.charAt(0).toUpperCase() + event.cardType.slice(1)} Card`;
        }
        if (foulText) {
          ctx.fillStyle = '#9ca3af'; // gray-400
          ctx.font = '26px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(foulText, canvas.width / 2, currentY);
          currentY += 50;
        }
      }

      // Separator line before score
      if (runningScore) {
        currentY += 20;
        ctx.strokeStyle = '#4b5563'; // gray-600
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(150, currentY);
        ctx.lineTo(canvas.width - 150, currentY);
        ctx.stroke();
        currentY += 50;

        // Running score
        ctx.fillStyle = '#60a5fa'; // blue-400
        ctx.font = 'bold 32px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${match.team1.name}: ${runningScore.t1Goals}-${runningScore.t1Points.toString().padStart(2, '0')}`, canvas.width / 2, currentY);
        currentY += 50;
        ctx.fillText(`${match.team2.name}: ${runningScore.t2Goals}-${runningScore.t2Points.toString().padStart(2, '0')}`, canvas.width / 2, currentY);
        currentY += 50;
      }

      // Notes if present
      if (event.noteText && event.noteText.trim()) {
        currentY += 30;
        ctx.fillStyle = '#9ca3af'; // gray-400
        ctx.font = '24px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';

        // Word wrap for long notes
        const maxWidth = canvas.width - 160;
        const words = event.noteText.trim().split(' ');
        let line = '';
        const lines = [];

        for (let word of words) {
          const testLine = line + word + ' ';
          const metrics = ctx.measureText(testLine);
          if (metrics.width > maxWidth && line !== '') {
            lines.push(line);
            line = word + ' ';
          } else {
            line = testLine;
          }
        }
        lines.push(line);

        // Draw note icon
        ctx.fillText('📝', canvas.width / 2, currentY);
        currentY += 40;

        // Draw wrapped text
        lines.forEach((line) => {
          ctx.fillText(line.trim(), canvas.width / 2, currentY);
          currentY += 35;
        });
      }

      // Convert to blob
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png', 0.9);
    });
  }

  async function shareBasicMatchInfo() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    
    // Calculate current scores
    const team1Score = computeTeamScore(match, 'team1');
    const team2Score = computeTeamScore(match, 'team2');
    
    // Generate match image
    const imageBlob = await generateMatchShareImage(match, team1Score, team2Score);
    
    // Try sharing image only with Web Share API first (mobile)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([imageBlob], 'match-update.png', { type: 'image/png' })] })) {
      try {
        const imageFile = new File([imageBlob], 'match-update.png', { type: 'image/png' });
        await navigator.share({
          files: [imageFile]
        });
        return;
      } catch (err) {
        console.log('Image sharing failed, trying image download:', err);
      }
    }
    
    // If image sharing not supported, download image directly
    try {
      const imageUrl = URL.createObjectURL(imageBlob);
      const downloadLink = document.createElement('a');
      downloadLink.href = imageUrl;
      downloadLink.download = `match-update-${match.team1.name}-vs-${match.team2.name}.png`;
      downloadLink.click();
      
      showShareSuccessMessage('Match image downloaded to your device!');
      URL.revokeObjectURL(imageUrl);

    } catch (err) {
      console.log('Image download failed');
      showShareSuccessMessage('Unable to share or download image. Please try again.');
    }
  }

  // ---------------------------------------------------------------------------
  // Live score sharing (Firebase Realtime Database)
  //
  // Broadcasting mirrors a small snapshot of the match to the cloud so anyone
  // with the share link can follow the score on live.html.  The clock is NOT
  // pushed every second: we send periodStartTimestamp and isPaused only when
  // they change, and the viewer recomputes the running time locally the same
  // way startTimerInterval() does.  That keeps a full match to a handful of
  // writes instead of several thousand.
  // ---------------------------------------------------------------------------

  const LIVE_SHARE_PATH = 'liveMatches';
  let firebaseDb = null;

  // Lazily initialise Firebase. Returns null if the SDK never loaded (offline,
  // blocked CDN) so every caller degrades quietly instead of throwing.
  function getFirebaseDb() {
    if (firebaseDb) return firebaseDb;
    if (typeof firebase === 'undefined' || typeof firebaseConfig === 'undefined') return null;
    try {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      firebaseDb = firebase.database();
      return firebaseDb;
    } catch (err) {
      console.warn('Firebase init failed', err);
      return null;
    }
  }

  // URL-safe random token. Share IDs must be unguessable: the database rules
  // allow unauthenticated writes, so the ID is what protects a broadcast.
  function generateShareId() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
  }

  // Full viewer URL for a broadcast match.
  function getLiveShareUrl(match) {
    if (!match || !match.shareId) return '';
    const base = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
    return base + 'live.html?id=' + match.shareId;
  }

  // Most recent scoring shot, formatted for the live page. Scores only -
  // cards, fouls, kickouts, subs and notes are deliberately not broadcast.
  //
  // Uses sortEventsByTime rather than the last element of match.events: event
  // times are editable, so insertion order can diverge from chronological
  // order, and the events list sorts the same way.
  function getLastScoreForBroadcast(match) {
    const empty = { text: '', team: '', outcome: '', minute: 0, period: '' };
    if (!match || !Array.isArray(match.events) || match.events.length === 0) return empty;

    const scoringOutcomes = [ShotOutcome.GOAL, ShotOutcome.POINT, ShotOutcome.TWO_POINTER];
    const sorted = sortEventsByTime(match.events, true);
    const ev = sorted.find((e) =>
      e && e.type === EventType.SHOT && scoringOutcomes.indexOf(e.shotOutcome) !== -1);
    if (!ev) return empty;

    // The app renders 'twoPointer' as "2 Pointer", not the generic
    // de-camelCased "Two Pointer".
    const outcomeLabels = { goal: 'Goal', point: 'Point', twoPointer: '2 Pointer' };
    // Keyed on the values ShotType actually stores. The in-app maps key on
    // '45m65m', which is never written, so a 45 shows there as "Forty Five".
    const shotTypeLabels = {
      fromPlay: 'From Play', free: 'Free', penalty: 'Penalty',
      fortyFive: '45m/65m', sixtyFive: '45m/65m',
      sideline: 'Sideline', mark: 'Mark'
    };

    const player = ev.player1Id
      ? (match.team1.players.find((p) => p.id === ev.player1Id) ||
         match.team2.players.find((p) => p.id === ev.player1Id) || null)
      : null;

    // Name alone reads better for spectators; the jersey number is only a
    // fallback for players still on their default "No.N" label.
    let scorer = '';
    if (player) {
      const defaultName = `No.${player.jerseyNumber}`;
      scorer = (player.name && player.name !== defaultName)
        ? player.name
        : `#${player.jerseyNumber}`;
    }

    const parts = [outcomeLabels[ev.shotOutcome] || ''];
    if (ev.shotType && shotTypeLabels[ev.shotType]) parts.push(shotTypeLabels[ev.shotType]);
    if (scorer) parts.push(scorer);

    const team = ev.teamId
      ? (ev.teamId === match.team1.id ? match.team1 : match.team2)
      : null;

    return {
      text: parts.filter(Boolean).join(' · '),
      team: team ? (team.name || '') : '',
      outcome: ev.shotOutcome || '',
      minute: Math.floor((ev.timeElapsed || 0) / 60),
      period: ev.period || ''
    };
  }

  // Build the payload written to the cloud. Carries the score, clock state and
  // the most recent score including the scorer's name - no full event list.
  function buildLivePayload(match) {
    const team1Score = computeTeamScore(match, 'team1');
    const team2Score = computeTeamScore(match, 'team2');
    // Always written, even when empty: RTDB drops undefined keys, so omitting
    // these would leave stale values from an earlier push in place.
    const lastScore = getLastScoreForBroadcast(match);
    return {
      team1Name: match.team1.name || 'Team 1',
      team2Name: match.team2.name || 'Team 2',
      competition: match.competition || '',
      venue: match.venue || '',
      team1Score: team1Score.total,
      team2Score: team2Score.total,
      team1Goals: team1Score.goals,
      team1Points: team1Score.points,
      team2Goals: team2Score.goals,
      team2Points: team2Score.points,
      currentPeriod: match.currentPeriod,
      elapsedTime: match.elapsedTime || 0,
      periodStartTimestamp: match.periodStartTimestamp || null,
      isPaused: match.isPaused !== false,
      matchType: match.matchType || 'football',
      lastScoreText: lastScore.text,
      lastScoreTeam: lastScore.team,
      lastScoreOutcome: lastScore.outcome,
      lastScoreMinute: lastScore.minute,
      lastScorePeriod: lastScore.period,
      lastUpdated: firebase.database.ServerValue.TIMESTAMP
    };
  }

  // Push a snapshot. No-op unless this match is broadcasting. Never allowed to
  // interrupt match tracking, so all failures are swallowed with a warning.
  function pushLiveUpdate(match) {
    if (!match || !match.isBroadcasting || !match.shareId) return;
    const db = getFirebaseDb();
    if (!db) return;
    try {
      db.ref(LIVE_SHARE_PATH + '/' + match.shareId)
        .set(buildLivePayload(match))
        .catch((err) => console.warn('Live score update failed', err));
    } catch (err) {
      console.warn('Live score update failed', err);
    }
  }

  // Begin broadcasting. Returns true on success.
  async function startBroadcast(match) {
    const db = getFirebaseDb();
    if (!db) return false;
    if (!match.shareId) match.shareId = generateShareId();
    match.isBroadcasting = true;
    try {
      await db.ref(LIVE_SHARE_PATH + '/' + match.shareId).set(buildLivePayload(match));
      await saveAppState();
      return true;
    } catch (err) {
      console.warn('Failed to start live sharing', err);
      match.isBroadcasting = false;
      return false;
    }
  }

  // Stop broadcasting and remove the public record.
  async function stopBroadcast(match) {
    const db = getFirebaseDb();
    const shareId = match.shareId;
    match.isBroadcasting = false;
    await saveAppState();
    if (!db || !shareId) return;
    try {
      await db.ref(LIVE_SHARE_PATH + '/' + shareId).remove();
    } catch (err) {
      console.warn('Failed to remove live score record', err);
    }
  }

  // Realtime DB has no TTL, so clear out broadcasts left running on old
  // matches to stop orphaned public records accumulating. Best effort only.
  function cleanupStaleBroadcasts() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let changed = false;
    appState.matches.forEach((match) => {
      if (!match.isBroadcasting || !match.shareId) return;
      const matchTime = match.dateTime ? new Date(match.dateTime).getTime() : 0;
      if (matchTime && matchTime > cutoff) return;
      match.isBroadcasting = false;
      changed = true;
      const db = getFirebaseDb();
      if (db) {
        try {
          db.ref(LIVE_SHARE_PATH + '/' + match.shareId).remove()
            .catch((err) => console.warn('Stale broadcast cleanup failed', err));
        } catch (err) {
          console.warn('Stale broadcast cleanup failed', err);
        }
      }
    });
    if (changed) saveAppState();
  }

  // Live share modal ---------------------------------------------------------

  function openLiveShareModal() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    const modal = document.getElementById('live-share-modal');
    if (!modal) return;
    renderLiveShareModal(match);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function closeLiveShareModal() {
    const modal = document.getElementById('live-share-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    setLiveShareStatus('');
  }

  function setLiveShareStatus(text) {
    const el = document.getElementById('live-share-status');
    if (!el) return;
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
  }

  function renderLiveShareModal(match) {
    const offState = document.getElementById('live-share-off');
    const onState = document.getElementById('live-share-on');
    const urlEl = document.getElementById('live-share-url');
    const sendBtn = document.getElementById('live-share-send');
    if (!offState || !onState) return;

    if (match.isBroadcasting) {
      offState.style.display = 'none';
      onState.style.display = 'block';
      if (urlEl) urlEl.textContent = getLiveShareUrl(match);
      if (sendBtn) sendBtn.style.display = navigator.share ? 'block' : 'none';
    } else {
      offState.style.display = 'block';
      onState.style.display = 'none';
    }
    updateLiveShareIndicator(match);
  }

  // Small dot on the toolbar button so an active broadcast is visible without
  // opening the modal.
  function updateLiveShareIndicator(match) {
    const dot = document.getElementById('live-share-indicator');
    if (!dot) return;
    dot.style.display = match && match.isBroadcasting ? 'block' : 'none';
  }

  async function handleStartBroadcast() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    if (typeof firebase === 'undefined') {
      setLiveShareStatus('Live sharing needs an internet connection. Please try again when online.');
      return;
    }
    setLiveShareStatus('Starting…');
    const ok = await startBroadcast(match);
    if (ok) {
      setLiveShareStatus('');
      renderLiveShareModal(match);
    } else {
      setLiveShareStatus('Could not start sharing. Check your connection and try again.');
    }
  }

  async function handleStopBroadcast() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    setLiveShareStatus('Stopping…');
    await stopBroadcast(match);
    setLiveShareStatus('');
    renderLiveShareModal(match);
  }

  async function handleCopyLiveLink() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    const url = getLiveShareUrl(match);
    try {
      await navigator.clipboard.writeText(url);
      setLiveShareStatus('Link copied.');
    } catch (err) {
      setLiveShareStatus('Could not copy automatically - select the link above to copy it.');
    }
  }

  async function handleSendLiveLink() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    const url = getLiveShareUrl(match);
    if (!navigator.share) return;
    try {
      await navigator.share({
        title: match.team1.name + ' v ' + match.team2.name,
        text: 'Follow the live score',
        url: url
      });
    } catch (err) {
      // User dismissed the share sheet - nothing to report.
    }
  }

  // Share individual event as image
  async function shareIndividualEvent(eventId) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;

    const event = match.events.find((e) => e.id === eventId);
    if (!event) return;

    // Calculate running score up to this event (same logic as renderEventsList)
    let t1Goals = 0;
    let t1Points = 0;
    let t2Goals = 0;
    let t2Points = 0;

    for (const ev of match.events) {
      if (ev.type === EventType.SHOT) {
        if (ev.teamId === match.team1.id) {
          if (ev.shotOutcome === ShotOutcome.GOAL) t1Goals += 1;
          else if (ev.shotOutcome === ShotOutcome.POINT) t1Points += 1;
          else if (ev.shotOutcome === ShotOutcome.TWO_POINTER) t1Points += 2;
        } else if (ev.teamId === match.team2.id) {
          if (ev.shotOutcome === ShotOutcome.GOAL) t2Goals += 1;
          else if (ev.shotOutcome === ShotOutcome.POINT) t2Points += 1;
          else if (ev.shotOutcome === ShotOutcome.TWO_POINTER) t2Points += 2;
        }
      }
      // Stop when we reach the current event
      if (ev.id === eventId) break;
    }

    const runningScore = { t1Goals, t1Points, t2Goals, t2Points };

    // Generate event image
    const imageBlob = await generateEventShareImage(match, event, runningScore);

    // Try sharing image with Web Share API first (mobile)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([imageBlob], 'event.png', { type: 'image/png' })] })) {
      try {
        const imageFile = new File([imageBlob], 'event.png', { type: 'image/png' });
        await navigator.share({
          files: [imageFile]
        });
        return;
      } catch (err) {
        console.log('Image sharing failed, trying image download:', err);
      }
    }

    // Fallback: Download image directly
    try {
      const imageUrl = URL.createObjectURL(imageBlob);
      const downloadLink = document.createElement('a');
      const team = event.teamId === match.team1.id ? match.team1 : match.team2;
      downloadLink.href = imageUrl;
      downloadLink.download = `event-${team.name}-${Date.now()}.png`.replace(/\s+/g, '_');
      downloadLink.click();

      showShareSuccessMessage('Event image downloaded to your device!');
      URL.revokeObjectURL(imageUrl);
    } catch (err) {
      console.log('Image download failed');
      showShareSuccessMessage('Unable to share or download image. Please try again.');
    }
  }

  // Generate formatted events export text matching the events list view
  function generateEventsExport(match) {
    // Helper to get player from either team
    const getPlayer = (playerId) => {
      if (!playerId) return null;
      return match.team1.players.find(p => p.id === playerId) ||
             match.team2.players.find(p => p.id === playerId) || null;
    };

    // Build running score for each event (same as renderEventsList)
    const scoreByEventId = {};
    let t1Goals = 0;
    let t1Points = 0;
    let t2Goals = 0;
    let t2Points = 0;

    match.events.forEach((ev) => {
      if (ev.type === EventType.SHOT) {
        if (ev.teamId === match.team1.id) {
          if (ev.shotOutcome === ShotOutcome.GOAL) t1Goals += 1;
          else if (ev.shotOutcome === ShotOutcome.POINT) t1Points += 1;
          else if (ev.shotOutcome === ShotOutcome.TWO_POINTER) t1Points += 2;
        } else if (ev.teamId === match.team2.id) {
          if (ev.shotOutcome === ShotOutcome.GOAL) t2Goals += 1;
          else if (ev.shotOutcome === ShotOutcome.POINT) t2Points += 1;
          else if (ev.shotOutcome === ShotOutcome.TWO_POINTER) t2Points += 2;
        }
      }
      scoreByEventId[ev.id] = { t1Goals, t1Points, t2Goals, t2Points };
    });

    // Build export text with header
    let text = `${match.competition || 'Match'} - Events\n\n`;
    text += `${match.team1.name} vs ${match.team2.name}\n`;

    if (match.dateTime) {
      const matchDate = new Date(match.dateTime).toLocaleDateString(undefined, {
        day: 'numeric', month: 'long', year: 'numeric'
      });
      text += `${matchDate}`;
    }
    if (match.venue) {
      text += ` | ${match.venue}`;
    }
    text += '\n\n';
    text += '================================\n\n';

    // Process events in chronological order (oldest first, properly sorted by period and time)
    const chronologicalEvents = sortEventsByTime(match.events, false);
    chronologicalEvents.forEach((ev, index) => {
      // Time and period (top right in UI, but we'll put it first)
      const minutes = Math.floor(ev.timeElapsed / 60);
      const timeStr = `${minutes} min`;
      text += `[${timeStr} - ${ev.period}]\n`;

      // Team name
      const team = ev.teamId ? (ev.teamId === match.team1.id ? match.team1 : match.team2) : null;
      if (team) {
        text += `${team.name}\n`;
      }

      // Event type/outcome
      let outcomeText = '';
      if (ev.type === EventType.SHOT) {
        outcomeText = ev.shotOutcome
          .replace(/([A-Z])/g, ' $1')
          .replace(/\b\w/g, (l) => l.toUpperCase());
      } else if (ev.type === EventType.CARD) {
        outcomeText = `${ev.cardType ? ev.cardType.charAt(0).toUpperCase() + ev.cardType.slice(1) : ''} Card`;
      } else if (ev.type === EventType.FOUL_CONCEDED) {
        outcomeText = `Foul${ev.foulOutcome ? ' (' + ev.foulOutcome.charAt(0).toUpperCase() + ev.foulOutcome.slice(1) + ')' : ''}`;
        if (ev.cardType) {
          outcomeText += ` + ${ev.cardType.charAt(0).toUpperCase() + ev.cardType.slice(1)} Card`;
        }
      } else if (ev.type === EventType.KICKOUT) {
        outcomeText = `Kick-out ${ev.wonKickout ? 'Won' : 'Lost'}`;
      } else if (ev.type === EventType.SUBSTITUTION) {
        outcomeText = 'Substitution';
      } else if (ev.type === EventType.NOTE) {
        outcomeText = 'Note';
      }
      text += `${outcomeText}\n`;

      // Scoreboard (only for scoring shots)
      const scoreboard = scoreByEventId[ev.id];
      if (ev.type === EventType.SHOT &&
          (ev.shotOutcome === ShotOutcome.GOAL ||
           ev.shotOutcome === ShotOutcome.POINT ||
           ev.shotOutcome === ShotOutcome.TWO_POINTER)) {
        text += `${match.team1.name}: ${scoreboard.t1Goals}-${scoreboard.t1Points}\n`;
        text += `${match.team2.name}: ${scoreboard.t2Goals}-${scoreboard.t2Points}\n`;
      }

      // Player info for shots
      if (ev.type === EventType.SHOT) {
        const player = getPlayer(ev.player1Id);
        if (player) {
          const defaultName = `No.${player.jerseyNumber}`;
          let line = `#${player.jerseyNumber}`;
          if (player.name && player.name !== defaultName) {
            line += ` ${player.name}`;
          }
          text += `${line}\n`;
        }
        // Shot type
        if (ev.shotType) {
          const shotTypeMap = {
            fromPlay: 'From Play',
            free: 'Free',
            penalty: 'Penalty',
            fortyFive: '45',
            sixtyFive: '65',
            sideline: 'Sideline',
            mark: 'Mark'
          };
          const shotTypeText = shotTypeMap[ev.shotType] || ev.shotType
            .replace(/([A-Z])/g, ' $1')
            .replace(/\b\w/g, (l) => l.toUpperCase());
          text += `${shotTypeText}\n`;
        }
      }

      // Player info for substitutions
      if (ev.type === EventType.SUBSTITUTION) {
        const playerOut = getPlayer(ev.player1Id);
        const playerIn = getPlayer(ev.player2Id);
        const outStr = playerOut
          ? `#${playerOut.jerseyNumber}${playerOut.name && playerOut.name !== `No.${playerOut.jerseyNumber}` ? ' ' + playerOut.name : ''}`
          : '';
        const inStr = playerIn
          ? `#${playerIn.jerseyNumber}${playerIn.name && playerIn.name !== `No.${playerIn.jerseyNumber}` ? ' ' + playerIn.name : ''}`
          : '';
        text += `${outStr} -> ${inStr}\n`;
      }

      // Player info for cards and fouls
      if (ev.type === EventType.CARD || ev.type === EventType.FOUL_CONCEDED) {
        const player = getPlayer(ev.player1Id);
        if (player) {
          const defaultName = `No.${player.jerseyNumber}`;
          let line = `#${player.jerseyNumber}`;
          if (player.name && player.name !== defaultName) {
            line += ` ${player.name}`;
          }
          text += `${line}\n`;
        }
      }

      // Notes
      if (ev.noteText && ev.noteText.trim()) {
        text += `${ev.noteText}\n`;
      }

      // Event separator
      if (index < match.events.length - 1) {
        text += '\n--------------------------------\n\n';
      }
    });

    text += '\n\n================================\n';
    text += `Total Events: ${match.events.length}\n`;
    text += '\nGenerated by Match Tracker';

    return text;
  }

  // Share events list
  async function shareEventsList() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;

    const exportText = generateEventsExport(match);

    // Try Web Share API (mobile)
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${match.competition || 'Match'} Events`,
          text: exportText
        });
        return;
      } catch (err) {
        if (err.name === 'AbortError') {
          // User cancelled, just return
          return;
        }
        console.log('Share failed, trying download:', err);
      }
    }

    // Fallback: Download as text file
    const blob = new Blob([exportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const fileName = `${match.team1.name}_vs_${match.team2.name}_events.txt`.replace(/\s+/g, '_');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function shareMatchStats() {
    if (!currentMatchStats) return;
    
    const shareText = StatsCalculator.generateShareableStats(currentMatchStats);
    
    // Try using Web Share API first (mobile)
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Match Statistics',
          text: shareText
        });
        return;
      } catch (err) {
        console.log('Native sharing failed, falling back to clipboard');
      }
    }
    
    // Fallback to clipboard
    try {
      await navigator.clipboard.writeText(shareText);
      showShareSuccessMessage('Statistics copied to clipboard! You can now paste it in WhatsApp or any messaging app.');
    } catch (err) {
      // Ultimate fallback - create a text area for manual copy
      createManualCopyFallback(shareText);
    }
  }
  
  function showShareSuccessMessage(message) {
    const notification = document.createElement('div');
    notification.className = 'fixed top-4 left-4 right-4 bg-green-600 text-white p-3 rounded-lg z-50';
    notification.innerHTML = `
      <div class="flex items-center space-x-2">
        <span>✅</span>
        <div class="text-sm">${message}</div>
      </div>
    `;
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 3000);
  }
  
  function createManualCopyFallback(text) {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
    modal.innerHTML = `
      <div class="bg-gray-800 text-gray-100 p-4 rounded-lg shadow-lg w-11/12 max-w-md">
        <h3 class="text-lg font-bold mb-2">Copy Statistics</h3>
        <p class="text-sm text-gray-300 mb-3">Select all text below and copy it:</p>
        <textarea readonly class="w-full h-64 p-2 bg-gray-700 text-gray-100 border border-gray-600 rounded text-sm">${text}</textarea>
        <button id="close-copy-modal" class="w-full mt-3 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">Close</button>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Select the text
    const textarea = modal.querySelector('textarea');
    textarea.select();
    
    // Close modal handler
    modal.querySelector('#close-copy-modal').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
  }

  /* Data Model Helpers */

  // Generate a unique ID using current timestamp and random suffix
  function generateId() {
    return `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  }

  // Initialize players for a team: 30 players numbered 1-30
  function generatePlayers() {
    const players = [];
    for (let i = 1; i <= 30; i++) {
      players.push({
        id: generateId(),
        name: `No.${i}`,
        jerseyNumber: i,
        position: ''
      });
    }
    return players;
  }

  // A panel is a fixed team-sheet: exactly PANEL_SIZE slots, jerseys 1..PANEL_SIZE.
  // The slot *is* the jersey number, so duplicates are impossible by construction
  // and importing a panel into a team is a straight 1:1 copy.
  const PANEL_SIZE = 30;

  // Tracks panels we've already warned about overflowing, so the alert in
  // normalizePanel() fires once per session rather than on every re-render.
  const overflowWarnedPanels = new Set();

  // Coerce a stored panel's players array into exactly PANEL_SIZE numbered slots.
  // Idempotent: safe to run repeatedly on an already-normalized panel.
  function normalizePanel(panel) {
    if (!panel || typeof panel !== 'object') return panel;
    const existing = Array.isArray(panel.players) ? panel.players : [];
    const slots = new Array(PANEL_SIZE).fill(null);
    // Legacy panels predate jersey numbers entirely; they fill 1..N in stored order.
    const hasNumbers = existing.some(p => p && Number.isInteger(p.jerseyNumber));

    if (hasNumbers) {
      // First pass: honour every valid, unclaimed jersey number.
      existing.forEach((p) => {
        if (!p) return;
        const n = p.jerseyNumber;
        if (Number.isInteger(n) && n >= 1 && n <= PANEL_SIZE && !slots[n - 1]) {
          slots[n - 1] = { id: p.id || generateId(), name: p.name || '', jerseyNumber: n };
        }
      });
      // Second pass: anything left over (missing, out-of-range or duplicate
      // number) drops into the first free slot rather than being discarded.
      existing.forEach((p) => {
        if (!p || !(p.name || '').trim()) return;
        const n = p.jerseyNumber;
        const alreadyPlaced =
          Number.isInteger(n) && n >= 1 && n <= PANEL_SIZE &&
          slots[n - 1] && slots[n - 1].id === p.id;
        if (alreadyPlaced) return;
        const free = slots.findIndex(s => s === null);
        if (free >= 0) {
          slots[free] = { id: p.id || generateId(), name: p.name, jerseyNumber: free + 1 };
        }
      });
    } else {
      existing.slice(0, PANEL_SIZE).forEach((p, i) => {
        slots[i] = { id: (p && p.id) || generateId(), name: (p && p.name) || '', jerseyNumber: i + 1 };
      });
    }

    // A panel holding more real names than there are slots can't be represented.
    // Say so out loud rather than dropping names silently.
    const named = existing.filter(p => p && (p.name || '').trim());
    const kept = new Set(slots.filter(Boolean).map(s => s.id));
    const dropped = named.filter(p => !kept.has(p.id)).map(p => p.name.trim());
    if (dropped.length && !overflowWarnedPanels.has(panel.id)) {
      overflowWarnedPanels.add(panel.id);
      console.warn(`Panel "${panel.name}" exceeds ${PANEL_SIZE} players; dropped:`, dropped);
      alert(
        `The panel "${panel.name}" holds more than ${PANEL_SIZE} players.\n\n` +
        `A panel is limited to ${PANEL_SIZE} jerseys, so these names could not be kept:\n` +
        dropped.join(', ')
      );
    }

    panel.players = slots.map((s, i) => s || { id: generateId(), name: '', jerseyNumber: i + 1 });
    return panel;
  }

  // Normalize every stored panel in memory. Deliberately does not save — the
  // migrated shape is persisted by the next ordinary saveAppState().
  function normalizeAllPanels() {
    if (Array.isArray(appState.playerPanels)) appState.playerPanels.forEach(normalizePanel);
  }

  // Count the slots in a panel that actually hold a name.
  function countPanelPlayers(panel) {
    if (!panel || !Array.isArray(panel.players)) return 0;
    return panel.players.filter(p => p && (p.name || '').trim() !== '').length;
  }

  // Load matches using enhanced storage system
  async function loadAppState() {
    try {
      const stored = await StorageManager.loadData('matches');
      if (stored) {
        appState.matches = stored;
      } else {
        appState.matches = [];
      }
    } catch (err) {
      console.warn('Failed to load matches from storage', err);
      appState.matches = [];
    }
    
    // Load player panels
    try {
      const storedPanels = await StorageManager.loadData('playerPanels');
      if (storedPanels) {
        appState.playerPanels = storedPanels;
      } else {
        appState.playerPanels = [];
      }
    } catch (err) {
      console.warn('Failed to load player panels from storage', err);
      appState.playerPanels = [];
    }
    // Migrate legacy panels (name-only lists) into fixed 30-slot team sheets.
    normalizeAllPanels();
    
    // Load last selected panels
    try {
      const storedLastSelected = await StorageManager.loadData('lastSelectedPanels');
      if (storedLastSelected) {
        appState.lastSelectedPanels = storedLastSelected;
      } else {
        appState.lastSelectedPanels = {};
      }
    } catch (err) {
      console.warn('Failed to load last selected panels from storage', err);
      appState.lastSelectedPanels = {};
    }

    // When data last left the device. Null on a device that has never exported
    // - which is not the same as "backed up long ago", so callers must handle it.
    try {
      appState.lastBackupAt = await StorageManager.loadData('lastBackupAt');
    } catch (err) {
      console.warn('Failed to load last backup timestamp from storage', err);
      appState.lastBackupAt = null;
    }
  }

  // Persist the whole app state.
  //
  // Returns true only if every key was durably written. Most of the ~30
  // callers do not await this, so the return value is not yet acted on
  // everywhere - but StorageManager now surfaces a warning to the user itself
  // when a write fails, which is what the old silent path was missing.
  async function saveAppState() {
    try {
      const results = await Promise.all([
        StorageManager.saveData('matches', appState.matches),
        StorageManager.saveData('playerPanels', appState.playerPanels),
        StorageManager.saveData('lastSelectedPanels', appState.lastSelectedPanels)
      ]);
      return results.every(Boolean);
    } catch (err) {
      console.error('Failed to save app state', err);
      return false;
    }
  }

  // Find a match by ID
  function findMatchById(matchId) {
    return appState.matches.find((m) => m.id === matchId);
  }

  /**
   * Delete a match from the application state and update persistent storage.  This helper
   * removes the match with the given ID from the matches array, updates
   * persistent storage and refreshes the match list view.  If the currently viewed
   * match is deleted, the app will return to the list view.  User confirmation
   * should be performed by the caller.
   *
   * @param {string} matchId - The ID of the match to remove.
   */
  function deleteMatch(matchId) {
    const index = appState.matches.findIndex((m) => m.id === matchId);
    if (index >= 0) {
      // Remove the match
      appState.matches.splice(index, 1);
      saveAppState();
      // If currently viewing this match, go back to list view
      if (appState.currentMatchId === matchId) {
        appState.currentMatchId = null;
        showView('match-list-view');
      }
      renderMatchList();
    }
  }

  // Compute score for a team based on events
  function computeTeamScore(match, teamKey) {
    let goals = 0;
    let points = 0;
    match.events.forEach((event) => {
      if (event.type === EventType.SHOT && event.teamId === match[teamKey].id) {
        if (event.shotOutcome === ShotOutcome.GOAL) goals++;
        else if (event.shotOutcome === ShotOutcome.POINT) points++;
        else if (event.shotOutcome === ShotOutcome.TWO_POINTER) points += 2;
      }
    });
    const total = goals * 3 + points;
    return { goals, points, total };
  }

  // Convert seconds to mm:ss string for display
  function formatTime(seconds) {
    const m = Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0');
    const s = Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0');
    return `${m}:${s}`;
  }

  // Convert seconds to minutes elapsed string for sharing (e.g., "12 min")
  function formatTimeForSharing(seconds) {
    const m = Math.floor(seconds / 60);
    return `${m} min`;
  }

  // Get numeric order for match period (for sorting events chronologically)
  function getPeriodOrder(period) {
    const periodOrder = {
      'Not Started': 0,
      '1st Half': 1,
      'Half Time': 2,
      '2nd Half': 3,
      'Full Time': 4,
      'Extra Time 1st Half': 5,
      'Extra Time Half Time': 6,
      'Extra Time 2nd Half': 7,
      'Match Over': 8
    };
    return periodOrder[period] ?? 0;
  }

  // Sort events by period and time (chronologically)
  // reverse = true: newest first (for event list display)
  // reverse = false: oldest first (for export/share)
  function sortEventsByTime(events, reverse = false) {
    const sorted = [...events].sort((a, b) => {
      // First sort by period
      const periodDiff = getPeriodOrder(a.period) - getPeriodOrder(b.period);
      if (periodDiff !== 0) return periodDiff;

      // Then by time within period
      return (a.timeElapsed || 0) - (b.timeElapsed || 0);
    });

    return reverse ? sorted.reverse() : sorted;
  }

  // Get next period given current period and whether match has extra time enabled
  function getNextPeriod(current, match) {
    const order = [
      MatchPeriod.NOT_STARTED,
      MatchPeriod.FIRST_HALF,
      MatchPeriod.HALF_TIME,
      MatchPeriod.SECOND_HALF,
      MatchPeriod.FULL_TIME,
      MatchPeriod.EXTRA_FIRST,
      MatchPeriod.EXTRA_HALF,
      MatchPeriod.EXTRA_SECOND,
      MatchPeriod.MATCH_OVER
    ];
    const idx = order.indexOf(current);
    if (idx < 0 || idx >= order.length - 1) return MatchPeriod.MATCH_OVER;
    // Skip extra periods if no extra time configured (half length = 0)
    const next = order[idx + 1];
    if (
      (next === MatchPeriod.EXTRA_FIRST || next === MatchPeriod.EXTRA_HALF || next === MatchPeriod.EXTRA_SECOND) &&
      (!match.extraHalfLength || match.extraHalfLength <= 0)
    ) {
      return MatchPeriod.MATCH_OVER;
    }
    return next;
  }

  /* UI Rendering Functions */

  // Render the list of matches
  function renderMatchList(filterText = '') {
    const list = document.getElementById('match-list');
    list.innerHTML = '';
    if (appState.matches.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'empty-message';
      msg.textContent = 'No matches yet. Tap "Add Match" to create one.';
      list.appendChild(msg);
      return;
    }
    // Sort matches by date/time descending (newest first)
    const sorted = [...appState.matches].sort((a, b) => {
      const da = new Date(a.dateTime || 0);
      const db = new Date(b.dateTime || 0);
      return db - da;
    });

    // Filter matches if filter text is provided
    let filtered = sorted;
    if (filterText && filterText.trim() !== '') {
      const lowerFilter = filterText.trim().toLowerCase();
      filtered = sorted.filter((match) => {
        const competition = (match.competition || '').toLowerCase();
        const team1 = (match.team1?.name || '').toLowerCase();
        const team2 = (match.team2?.name || '').toLowerCase();
        return (
          competition.includes(lowerFilter) ||
          team1.includes(lowerFilter) ||
          team2.includes(lowerFilter)
        );
      });
    }

    // Show message if no matches found after filtering
    if (filtered.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'empty-message';
      msg.textContent = 'No matches found. Try a different search.';
      list.appendChild(msg);
      return;
    }

    filtered.forEach((match, idx) => {
      // Create a card wrapper for each match item.  Use a vertical layout with
      // subtle spacing between lines.  The card is clickable to open match
      // details and has relative positioning so we can anchor the delete
      // button inside it.
      const card = document.createElement('div');
      card.className =
        'match-card relative bg-gray-800 border border-gray-700 rounded-lg p-4 cursor-pointer hover:bg-gray-700 flex flex-col space-y-1 text-left';
      card.style.setProperty('--i', idx);
      card.addEventListener('click', () => openMatchDetails(match.id));

      // Competition line: show the competition name if provided; otherwise,
      // use the match title if available.  Use a bold, slightly larger
      // font size to give prominence.
      const compLine = document.createElement('div');
      compLine.className = 'text-gray-100 font-semibold text-lg';
      compLine.textContent = match.competition || match.title || '';
      card.appendChild(compLine);

      // Teams line: display the two team names separated by "vs".  Use
      // secondary colour to differentiate from the competition line.
      const teamsLine = document.createElement('div');
      teamsLine.className = 'text-gray-300';
      teamsLine.textContent = `${match.team1?.name || ''} vs ${match.team2?.name || ''}`;
      card.appendChild(teamsLine);

      // Score line: calculate and display current score for both teams
      const team1Score = computeTeamScore(match, 'team1');
      const team2Score = computeTeamScore(match, 'team2');
      const scoreLine = document.createElement('div');
      scoreLine.className = 'text-blue-400 font-semibold text-center mt-1';
      const team1ScoreText = `${team1Score.goals}-${team1Score.points.toString().padStart(2, '0')} (${team1Score.total})`;
      const team2ScoreText = `${team2Score.goals}-${team2Score.points.toString().padStart(2, '0')} (${team2Score.total})`;
      scoreLine.textContent = `${team1ScoreText} vs ${team2ScoreText}`;
      card.appendChild(scoreLine);

      // Date line: format the stored date into a human‑readable string.
      const dateLine = document.createElement('div');
      dateLine.className = 'text-gray-500 text-sm';
      const dt = match.dateTime ? new Date(match.dateTime) : null;
      dateLine.textContent = dt
        ? dt.toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
          })
        : '';
      card.appendChild(dateLine);

      // Add a delete button anchored to the top right of each card.  Use
      // pointer‑events: none on the SVG so the button click registers on
      // the button element itself.
      const del = document.createElement('button');
      del.title = 'Delete match';
      del.className = 'absolute bottom-2 right-2 text-gray-300 hover:text-gray-100';
      del.innerHTML =
        '<img src="icons/delete.svg" alt="Add Match" class="w-8 h-8" />';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this match?')) {
          deleteMatch(match.id);
        }
      });
      card.appendChild(del);

      list.appendChild(card);
    });
  }

  // Show a particular view and hide others
  function showView(viewId) {
    const views = document.querySelectorAll('.view');
    views.forEach((v) => {
      // Some views use flex so their list scrolls independently of the
      // sticky header+search; all others stay as block.
      const flexViews = ['match-list-view', 'player-panels-view'];
      const showAs = (v.id === viewId)
        ? (flexViews.includes(v.id) ? 'flex' : 'block')
        : 'none';
      v.style.display = showAs;
    });
    // Hide the header (app title) on match list and match form views, show it on match details.
    const header = document.querySelector('header');
    if (header) {
      if (viewId === 'match-details-view') {
        header.style.display = 'block';
      } else {
        header.style.display = 'none';
      }
    }
    
    // Add/remove grass background class for header when in match view
    const body = document.body;
    const html = document.documentElement;
    if (viewId === 'match-details-view') {
      body.classList.add('match-view-active');
      html.classList.add('match-view-active');
    } else {
      body.classList.remove('match-view-active');
      html.classList.remove('match-view-active');
    }
  }

  // Make showView globally accessible for inline onclick handlers
  window.showView = showView;

  // Reset and show match form for creating a new match
  function showAddMatchForm() {
    const formTitle = document.getElementById('form-title');
    formTitle.textContent = 'New Match';
    const form = document.getElementById('match-form');
    form.reset();
    // Clear any editing state when creating a new match
    appState.editingMatchId = null;
    showView('match-form-view');
    // Hide the header on the match creation screen
    const header = document.querySelector('header');
    if (header) header.style.display = 'none';
  }

  /**
   * Populate and display the match form for editing an existing match.  The
   * form fields are prefilled with the current match details and the
   * appState.editingMatchId flag is set so that the form submission
   * updates the existing match rather than creating a new one.
   */
  function showEditMatchForm() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    appState.editingMatchId = match.id;
    const formTitle = document.getElementById('form-title');
    formTitle.textContent = 'Edit Match';
    // Populate fields
    document.getElementById('competition').value = match.competition || '';
    document.getElementById('dateTime').value = match.dateTime || '';
    document.getElementById('venue').value = match.venue || '';
    document.getElementById('referee').value = match.referee || '';
    document.getElementById('matchType').value = match.matchType || 'football';
    document.getElementById('team1').value = match.team1.name || '';
    document.getElementById('team2').value = match.team2.name || '';
    // Removed halfLength and extraHalfLength form fields; durations are no longer editable via the UI.
    showView('match-form-view');
    // Hide the header on the match edit screen
    const header = document.querySelector('header');
    if (header) header.style.display = 'none';
  }

  // Handle match form submission to create a new match
  function handleMatchFormSubmit(event) {
    event.preventDefault();
    const competition = document.getElementById('competition').value.trim();
    const dateTime = document.getElementById('dateTime').value;
    const venue = document.getElementById('venue').value.trim();
    const referee = document.getElementById('referee').value.trim();
    const matchType = document.getElementById('matchType').value;
    const team1Name = document.getElementById('team1').value.trim();
    const team2Name = document.getElementById('team2').value.trim();
    // With the duration inputs removed from the form, default values are used for half length (30) and
    // extra half length (0).  These durations are not currently used in the timer implementation but
    // remain part of the data model for potential future use.
    const halfLength = 30;
    // Use a default extra time half length of 10 minutes.  This enables the extra time flow without
    // requiring user input.  The duration itself is not currently used by the timer logic.
    const extraHalfLength = 10;
    if (!team1Name || !team2Name) {
      alert('Please provide names for both teams.');
      return;
    }
    // If editing an existing match, update it instead of creating a new one
    if (appState.editingMatchId) {
      const match = findMatchById(appState.editingMatchId);
      if (match) {
        match.competition = competition;
        match.dateTime = dateTime;
        match.venue = venue;
        match.referee = referee;
        match.matchType = matchType;
        // Leave existing halfLength and extraHalfLength unchanged when editing; durations are not
        // modifiable through the UI.  If no values exist, the defaults will remain.
        // Update team names but keep IDs and players
        match.team1.name = team1Name;
        match.team2.name = team2Name;
        saveAppState();
        // Refresh scoreboard and title using existing match ID
        openMatchDetails(match.id);
        // Clear editing state
        appState.editingMatchId = null;
      }
    } else {
      // Create a new match
      const match = {
        id: generateId(),
        competition,
        dateTime,
        venue,
        referee,
        matchType,
        // Include default durations in the new match object for completeness, even though they are not
        // configurable via the UI.  These fields are unused by the current timer logic.
        halfLength,
        extraHalfLength,
        team1: {
          id: generateId(),
          name: team1Name,
          players: generatePlayers(),
        },
        team2: {
          id: generateId(),
          name: team2Name,
          players: generatePlayers(),
        },
        events: [],
        currentPeriod: MatchPeriod.NOT_STARTED,
        elapsedTime: 0, // seconds
        isPaused: true,
        periodStartTimestamp: null
      };
      appState.matches.push(match);
      saveAppState();
      renderMatchList();
      // go back to list view
      showView('match-list-view');
    }
  }

  // Cancel match form
  function cancelMatchForm() {
    // If editing a match, return to match details rather than list
    if (appState.editingMatchId) {
      const id = appState.editingMatchId;
      appState.editingMatchId = null;
      openMatchDetails(id);
    } else {
      showView('match-list-view');
    }
  }

  // Generate formatted events export text matching the events list view
  function generateEventsExport(match) {
    // Helper to get player from either team
    const getPlayer = (playerId) => {
      if (!playerId) return null;
      return match.team1.players.find(p => p.id === playerId) ||
             match.team2.players.find(p => p.id === playerId) || null;
    };

    // Build running score for each event (same as renderEventsList)
    const scoreByEventId = {};
    let t1Goals = 0;
    let t1Points = 0;
    let t2Goals = 0;
    let t2Points = 0;

    match.events.forEach((ev) => {
      if (ev.type === EventType.SHOT) {
        if (ev.teamId === match.team1.id) {
          if (ev.shotOutcome === ShotOutcome.GOAL) t1Goals += 1;
          else if (ev.shotOutcome === ShotOutcome.POINT) t1Points += 1;
          else if (ev.shotOutcome === ShotOutcome.TWO_POINTER) t1Points += 2;
        } else if (ev.teamId === match.team2.id) {
          if (ev.shotOutcome === ShotOutcome.GOAL) t2Goals += 1;
          else if (ev.shotOutcome === ShotOutcome.POINT) t2Points += 1;
          else if (ev.shotOutcome === ShotOutcome.TWO_POINTER) t2Points += 2;
        }
      }
      scoreByEventId[ev.id] = { t1Goals, t1Points, t2Goals, t2Points };
    });

    // Build export text with header
    let text = `${match.competition || 'Match'} - Events\n\n`;
    text += `${match.team1.name} vs ${match.team2.name}\n`;

    if (match.dateTime) {
      const matchDate = new Date(match.dateTime).toLocaleDateString(undefined, {
        day: 'numeric', month: 'long', year: 'numeric'
      });
      text += `${matchDate}`;
    }
    if (match.venue) {
      text += ` | ${match.venue}`;
    }
    text += '\n\n';
    text += '================================\n\n';

    // Process events in chronological order (oldest first, properly sorted by period and time)
    const chronologicalEvents = sortEventsByTime(match.events, false);
    chronologicalEvents.forEach((ev, index) => {
      // Time and period (top right in UI, but we'll put it first)
      const minutes = Math.floor(ev.timeElapsed / 60);
      const timeStr = `${minutes} min`;
      text += `[${timeStr} - ${ev.period}]\n`;

      // Team name
      const team = ev.teamId ? (ev.teamId === match.team1.id ? match.team1 : match.team2) : null;
      if (team) {
        text += `${team.name}\n`;
      }

      // Event type/outcome
      let outcomeText = '';
      if (ev.type === EventType.SHOT) {
        outcomeText = ev.shotOutcome
          .replace(/([A-Z])/g, ' $1')
          .replace(/\b\w/g, (l) => l.toUpperCase());
      } else if (ev.type === EventType.CARD) {
        outcomeText = `${ev.cardType ? ev.cardType.charAt(0).toUpperCase() + ev.cardType.slice(1) : ''} Card`;
      } else if (ev.type === EventType.FOUL_CONCEDED) {
        outcomeText = `Foul${ev.foulOutcome ? ' (' + ev.foulOutcome.charAt(0).toUpperCase() + ev.foulOutcome.slice(1) + ')' : ''}`;
        if (ev.cardType) {
          outcomeText += ` + ${ev.cardType.charAt(0).toUpperCase() + ev.cardType.slice(1)} Card`;
        }
      } else if (ev.type === EventType.KICKOUT) {
        outcomeText = `Kick-out ${ev.wonKickout ? 'Won' : 'Lost'}`;
      } else if (ev.type === EventType.SUBSTITUTION) {
        outcomeText = 'Substitution';
      } else if (ev.type === EventType.NOTE) {
        outcomeText = 'Note';
      }
      text += `${outcomeText}\n`;

      // Scoreboard (only for scoring shots)
      const scoreboard = scoreByEventId[ev.id];
      if (ev.type === EventType.SHOT &&
          (ev.shotOutcome === ShotOutcome.GOAL ||
           ev.shotOutcome === ShotOutcome.POINT ||
           ev.shotOutcome === ShotOutcome.TWO_POINTER)) {
        text += `${match.team1.name}: ${scoreboard.t1Goals}-${scoreboard.t1Points}\n`;
        text += `${match.team2.name}: ${scoreboard.t2Goals}-${scoreboard.t2Points}\n`;
      }

      // Player info for shots
      if (ev.type === EventType.SHOT) {
        const player = getPlayer(ev.player1Id);
        if (player) {
          const defaultName = `No.${player.jerseyNumber}`;
          let line = `#${player.jerseyNumber}`;
          if (player.name && player.name !== defaultName) {
            line += ` ${player.name}`;
          }
          text += `${line}\n`;
        }
        // Shot type
        if (ev.shotType) {
          const shotTypeMap = {
            fromPlay: 'From Play',
            free: 'Free',
            penalty: 'Penalty',
            fortyFive: '45',
            sixtyFive: '65',
            sideline: 'Sideline',
            mark: 'Mark'
          };
          const shotTypeText = shotTypeMap[ev.shotType] || ev.shotType
            .replace(/([A-Z])/g, ' $1')
            .replace(/\b\w/g, (l) => l.toUpperCase());
          text += `${shotTypeText}\n`;
        }
      }

      // Player info for substitutions
      if (ev.type === EventType.SUBSTITUTION) {
        const playerOut = getPlayer(ev.player1Id);
        const playerIn = getPlayer(ev.player2Id);
        const outStr = playerOut
          ? `#${playerOut.jerseyNumber}${playerOut.name && playerOut.name !== `No.${playerOut.jerseyNumber}` ? ' ' + playerOut.name : ''}`
          : '';
        const inStr = playerIn
          ? `#${playerIn.jerseyNumber}${playerIn.name && playerIn.name !== `No.${playerIn.jerseyNumber}` ? ' ' + playerIn.name : ''}`
          : '';
        text += `${outStr} -> ${inStr}\n`;
      }

      // Player info for cards and fouls
      if (ev.type === EventType.CARD || ev.type === EventType.FOUL_CONCEDED) {
        const player = getPlayer(ev.player1Id);
        if (player) {
          const defaultName = `No.${player.jerseyNumber}`;
          let line = `#${player.jerseyNumber}`;
          if (player.name && player.name !== defaultName) {
            line += ` ${player.name}`;
          }
          text += `${line}\n`;
        }
      }

      // Notes
      if (ev.noteText && ev.noteText.trim()) {
        text += `${ev.noteText}\n`;
      }

      // Event separator
      if (index < match.events.length - 1) {
        text += '\n--------------------------------\n\n';
      }
    });

    text += '\n\n================================\n';
    text += `Total Events: ${match.events.length}\n`;
    text += '\nGenerated by Match Tracker';

    return text;
  }

  // Share events list
  async function shareEventsList() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;

    const exportText = generateEventsExport(match);

    // Try Web Share API (mobile)
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${match.competition || 'Match'} Events`,
          text: exportText
        });
        return;
      } catch (err) {
        if (err.name === 'AbortError') {
          // User cancelled, just return
          return;
        }
        console.log('Share failed, trying download:', err);
      }
    }

    // Fallback: Download as text file
    const blob = new Blob([exportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const fileName = `${match.team1.name}_vs_${match.team2.name}_events.txt`.replace(/\s+/g, '_');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Open details of a match
  function openMatchDetails(matchId) {
    appState.currentMatchId = matchId;
    const match = findMatchById(matchId);
    if (!match) return;
    // Reset any running timer
    stopTimer();
    // Update the top bar with competition name (or team names if no competition).  Team names are not
    // displayed separately in the details view because they already appear on the score cards.
    const appTitle = document.getElementById('app-title');
    if (appTitle) {
      // Show only the competition name above the timer.  Team names are
      // displayed on the score cards, so avoid repeating them here.  If no
      // competition is provided, leave the title blank.
      appTitle.textContent = match.competition || '';
      // Show header when viewing match details
      const header = appTitle.closest('header');
      if (header) header.style.display = 'block';
    }
    // Render scoreboard
    updateScoreboard(match);
    // Render timer display and controls
    updateTimerControls(match);
    // Ensure event buttons are enabled/disabled appropriately for the current period
    updateEventButtons(match);
    // Show the broadcast dot if this match is already being shared
    updateLiveShareIndicator(match);
    // Render event form fields for default type
    const eventTypeSelect = document.getElementById('event-type');
    eventTypeSelect.value = EventType.SHOT;
    renderEventFields(eventTypeSelect.value);
    // Render events list and last event summary
    renderEventsList(match);
    renderLastEvent(match);
    // If the match was already running when navigating away (i.e. not paused),
    // restart the timer interval when returning to the details view.  This
    // ensures the clock continues to update while the user switches between
    // different screens.  Only resume the interval during active playing
    // periods; half‑time and other breaks should remain paused.
    if (match && !match.isPaused && isPlayingPeriod(match.currentPeriod)) {
      // Do not modify periodStartTimestamp here; it has been preserved.  Just
      // restart the interval so elapsedTime continues from where it left off.
      startTimerInterval(match);
    }
    showView('match-details-view');
  }

  // Back to match list
  function backToList() {
    stopTimer();
    appState.currentMatchId = null;
    showView('match-list-view');
    // Hide the header when returning to the match list
    const appTitle = document.getElementById('app-title');
    if (appTitle) {
      appTitle.textContent = 'Match Tracker';
      const header = appTitle.closest('header');
      if (header) header.style.display = 'none';
    }
  }

  // Re-trigger a CSS .flash animation if the displayed value changed
  function applyScoreFlash(el, newValue) {
    if (!el) return;
    const prev = el.textContent;
    if (prev !== '' && prev !== String(newValue)) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    el.textContent = newValue;
  }

  // Compute and render scoreboard for current match
  function updateScoreboard(match) {
    const team1Score = computeTeamScore(match, 'team1');
    const team2Score = computeTeamScore(match, 'team2');
    // Update team cards instead of old scoreboard
    const card1 = document.getElementById('team1-card');
    const card2 = document.getElementById('team2-card');
    if (card1) {
      card1.querySelector('.team-name').textContent = match.team1.name;
      applyScoreFlash(card1.querySelector('.score-goals'), team1Score.goals);
      applyScoreFlash(card1.querySelector('.score-points'), team1Score.points);
      card1.querySelector('.score-total').textContent = `(${team1Score.total})`;
    }
    if (card2) {
      card2.querySelector('.team-name').textContent = match.team2.name;
      applyScoreFlash(card2.querySelector('.score-goals'), team2Score.goals);
      applyScoreFlash(card2.querySelector('.score-points'), team2Score.points);
      card2.querySelector('.score-total').textContent = `(${team2Score.total})`;
    }

    // Show or hide the two‑pointer buttons based on the match type.  A two‑pointer is only available
    // in football (men's) matches.  Ladies football, hurling and camogie do not use two pointers.
    updateTwoPointerButtons(match);

    // Mirror the new score to the cloud if this match is being shared.
    pushLiveUpdate(match);
  }

  /**
   * Toggle visibility of two‑pointer buttons according to the current match type.  In Gaelic
   * football (men's), a two‑point score is possible and the button should be visible.  In all
   * other codes (ladies football, hurling, camogie) the button should be hidden.
   *
   * @param {object} match - The current match object.
   */
  function updateTwoPointerButtons(match) {
    const show = match.matchType === 'football';
    document.querySelectorAll('.team-two-pointer-btn').forEach((btn) => {
      if (show) {
        btn.classList.remove('hidden');
      } else {
        btn.classList.add('hidden');
      }
    });
  }

  // Helper function to create styled outcome capsule for scoring events
  function createStyledOutcome(outcomeText, shotOutcome) {
    if (shotOutcome === ShotOutcome.GOAL ||
        shotOutcome === ShotOutcome.POINT ||
        shotOutcome === ShotOutcome.TWO_POINTER) {
      // Create span with capsule styling
      const span = document.createElement('span');
      span.textContent = outcomeText;
      span.style.display = 'inline-block';
      span.style.padding = '1px 5px';
      span.style.borderRadius = '10px';
      span.style.fontWeight = '600';
      span.style.fontSize = '0.875rem';

      if (shotOutcome === ShotOutcome.GOAL) {
        span.style.backgroundColor = '#22C55E';
        span.style.color = '#FFFFFF';
      } else if (shotOutcome === ShotOutcome.POINT) {
        span.style.backgroundColor = '#FFFFFF';
        span.style.color = '#111827';
      } else if (shotOutcome === ShotOutcome.TWO_POINTER) {
        span.style.backgroundColor = '#FB923C';
        span.style.color = '#FFFFFF';
      }

      return span;
    }
    // For non-scoring outcomes, return plain text
    return outcomeText;
  }

  // Render the last event summary at bottom of the match details view
  function renderLastEvent(match) {
    const display = document.getElementById('last-event-display');
    if (!display) return;
    if (!match || !match.events || match.events.length === 0) {
      display.innerHTML = '';
      display.classList.add('hidden');
      return;
    }
    const last = match.events[match.events.length - 1];
    if (!last) {
      display.innerHTML = '';
      display.classList.add('hidden');
      return;
    }

    const team = last.teamId ? (last.teamId === match.team1.id ? match.team1 : match.team2) : null;
    const getPlayer = (id) => id
      ? (match.team1.players.find((p) => p.id === id) || match.team2.players.find((p) => p.id === id) || null)
      : null;
    const formatPlayer = (p) => {
      if (!p) return '';
      const def = `No.${p.jerseyNumber}`;
      return p.name && p.name !== def ? `#${p.jerseyNumber} ${p.name}` : `#${p.jerseyNumber}`;
    };
    const minutes = Math.floor(last.timeElapsed / 60);

    // Build outcome chip / label
    let outcomeText = '';
    let chipNode = null;
    let headlineText = team ? team.name : '';
    if (last.type === EventType.SHOT) {
      outcomeText = last.shotOutcome
        .replace(/([A-Z])/g, ' $1')
        .replace(/\b\w/g, (l) => l.toUpperCase());
      const styled = createStyledOutcome(outcomeText, last.shotOutcome);
      if (typeof styled !== 'string') chipNode = styled;
    } else if (last.type === EventType.CARD) {
      outcomeText = `${last.cardType ? last.cardType.charAt(0).toUpperCase() + last.cardType.slice(1) : ''} Card`;
    } else if (last.type === EventType.FOUL_CONCEDED) {
      let foulText = `Foul${last.foulOutcome ? ' (' + last.foulOutcome.charAt(0).toUpperCase() + last.foulOutcome.slice(1) + ')' : ''}`;
      if (last.cardType) foulText += ` + ${last.cardType.charAt(0).toUpperCase() + last.cardType.slice(1)} Card`;
      outcomeText = foulText;
    } else if (last.type === EventType.KICKOUT) {
      outcomeText = `Kick‑out ${last.wonKickout ? 'Won' : 'Lost'}`;
    } else if (last.type === EventType.SUBSTITUTION) {
      outcomeText = 'Substitution';
    } else if (last.type === EventType.NOTE) {
      outcomeText = 'Note';
    } else if (last.type === EventType.PERIOD_END) {
      // Period transitions don't have a team — promote the period name to
      // the headline so the ticker reads e.g. "HALF TIME" instead of empty.
      headlineText = last.period || 'Period End';
    }

    // Compose subtitle parts (single muted line)
    const parts = [];
    if (last.type === EventType.SHOT) {
      if (last.shotType) {
        const map = { fromPlay: 'From Play', free: 'Free', penalty: 'Penalty', '45m65m': '45m/65m', sideline: 'Sideline', mark: 'Mark' };
        parts.push(map[last.shotType] || last.shotType
          .replace(/([A-Z])/g, ' $1').replace(/\b\w/g, (l) => l.toUpperCase()));
      }
      const player = getPlayer(last.player1Id);
      if (player) parts.push(formatPlayer(player));
    } else if (last.type === EventType.SUBSTITUTION) {
      const outP = getPlayer(last.player1Id);
      const inP = getPlayer(last.player2Id);
      if (outP || inP) parts.push(`${formatPlayer(outP)} → ${formatPlayer(inP)}`);
    } else if (last.type === EventType.CARD || last.type === EventType.FOUL_CONCEDED) {
      const p = getPlayer(last.player1Id);
      if (p) parts.push(formatPlayer(p));
    }
    if (last.noteText && last.noteText.trim()) parts.push(last.noteText.trim());
    parts.push(`${minutes} min`);
    // Skip the period in the subtitle for period-end events — the period
    // name is already the headline, no need to repeat it.
    if (last.type !== EventType.PERIOD_END) parts.push(last.period);

    // Build DOM
    display.innerHTML = '';

    const content = document.createElement('div');
    content.className = 'flex-1 min-w-0';

    const headline = document.createElement('div');
    headline.className = 'last-event-headline flex items-center gap-2';
    if (headlineText) {
      const teamSpan = document.createElement('span');
      teamSpan.className = 'last-event-team';
      teamSpan.textContent = headlineText;
      headline.appendChild(teamSpan);
    }
    if (chipNode) {
      headline.appendChild(chipNode);
    } else if (outcomeText) {
      const fallback = document.createElement('span');
      fallback.className = 'last-event-outcome';
      fallback.textContent = outcomeText;
      headline.appendChild(fallback);
    }
    content.appendChild(headline);

    const subtitle = document.createElement('div');
    subtitle.className = 'last-event-subtitle';
    subtitle.textContent = parts.join(' · ');
    content.appendChild(subtitle);

    display.appendChild(content);

    // Action buttons (inline, right side)
    const actions = document.createElement('div');
    actions.className = 'flex items-center ml-3 flex-shrink-0';

    const shareBtn = document.createElement('button');
    shareBtn.className = 'cursor-pointer mr-2';
    shareBtn.title = 'Share event';
    shareBtn.innerHTML = '<img src="icons/share.svg" alt="Share Event" class="w-8 h-8" />';
    shareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      shareIndividualEvent(last.id);
    });
    actions.appendChild(shareBtn);

    const listBtn = document.createElement('button');
    listBtn.id = 'show-events-btn';
    listBtn.className = 'cursor-pointer';
    listBtn.title = 'Show all events';
    listBtn.innerHTML = '<img src="icons/burger.svg" alt="Show all events" class="w-8 h-8" />';
    actions.appendChild(listBtn);

    display.appendChild(actions);
    display.classList.remove('hidden');
    listBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showEventsView();
      display.classList.add('hidden');
    });
    // Attach click on display to edit last event (excluding buttons)
    display.onclick = (e) => {
      const clickedButton = e.target.closest('button');
      if (clickedButton === listBtn || clickedButton === shareBtn) return;
      showEditEventForm(last.id);
    };
  }

  // Render quick scoring buttons labels according to team names
  function updateQuickButtons(match) {
    // Update button group dataset or aria-label with team names
    const team1GoalBtn = document.getElementById('team1-goal-btn');
    const team1PointBtn = document.getElementById('team1-point-btn');
    const team2GoalBtn = document.getElementById('team2-goal-btn');
    const team2PointBtn = document.getElementById('team2-point-btn');
    if (team1GoalBtn) {
      team1GoalBtn.textContent = `${match.team1.name} Goal`;
      team1PointBtn.textContent = `${match.team1.name} Point`;
    }
    if (team2GoalBtn) {
      team2GoalBtn.textContent = `${match.team2.name} Goal`;
      team2PointBtn.textContent = `${match.team2.name} Point`;
    }
  }
  /**
   * Show the event type selection modal for a specific team. This modal
   * presents a grid of event types with SVG icons, allowing the user to
   * select which type of event they want to record. Once selected, it
   * opens the appropriate event-specific modal.
   *
   * @param {string} teamKey - 'team1' or 'team2'
   */
  function showEventTypeModal(teamKey) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    // Prevent opening the event form when not in a playing period
    if (!isPlayingPeriod(match.currentPeriod)) {
      return;
    }
    
    const modal = document.getElementById('event-type-modal');
    const metaEl = document.getElementById('event-type-meta');
    if (!modal || !metaEl) return;
    
    // Set the team context for the modal
    modal.dataset.teamKey = teamKey;
    
    // Get team and current match info
    const team = teamKey === 'team1' ? match.team1 : match.team2;
    const minutes = Math.floor(match.elapsedTime / 60);
    const timeStr = `${minutes} min`;
    
    // Populate meta information
    metaEl.textContent = `${team.name} • ${timeStr} • ${match.currentPeriod}`;
    
    // Show modal
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  /**
   * Hide the event type selection modal
   */
  function hideEventTypeModal() {
    const modal = document.getElementById('event-type-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  /**
   * Show the Add Event modal and preselect the team for which the event is
   * being added.  This replaces the inline event form previously displayed
   * at the bottom of the page.  It renders dynamic fields for the selected
   * event type and focuses the user's attention on event creation.
   *
   * @param {string} teamKey - 'team1' or 'team2'
   */
  function showAddEventModal(teamKey) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    // Prevent opening the event form when not in a playing period
    if (!isPlayingPeriod(match.currentPeriod)) {
      return;
    }
    const modal = document.getElementById('add-event-modal');
    if (!modal) return;
    // Ensure the modal is visible
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    // Set default event type to shot if not already set
    const eventTypeSelect = document.getElementById('event-type');
    if (eventTypeSelect) {
      // Render fields for currently selected type
      renderEventFields(eventTypeSelect.value);
    }
    // Preselect team in event fields
    const teamSelect = document.querySelector('#event-fields select#event-team');
    if (teamSelect && match && (teamKey === 'team1' || teamKey === 'team2')) {
      teamSelect.value = match[teamKey].id;
      teamSelect.dispatchEvent(new Event('change'));
    }
  }

  /**
   * Hide the Add Event modal and clear any transient UI state.  Used when
   * cancelling an event or after successfully adding one.
   */
  function hideAddEventModal() {
    const modal = document.getElementById('add-event-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    // Optionally clear the dynamic fields container
    const fields = document.getElementById('event-fields');
    if (fields) fields.innerHTML = '';
  }

  /**
   * Show the Events list view.  When the user taps the list button in the
   * last event display, navigate to the full events view page.
   */
  function showEventsView() {
    // Render events list for current match
    const match = findMatchById(appState.currentMatchId);
    if (match) {
      renderEventsList(match);
    }
    showView('events-view');
  }

  /**
   * Hide the Events list view and return to match details.
   */
  function hideEventsView() {
    showView('match-details-view');
    // Restore the last event display when returning from events view
    const match = findMatchById(appState.currentMatchId);
    if (match && match.events && match.events.length > 0) {
      const lastDisplay = document.getElementById('last-event-display');
      if (lastDisplay) {
        lastDisplay.classList.remove('hidden');
      }
    }
  }

  // Quickly add a scoring event without opening event form
  function quickAddShot(teamKey, outcome) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    // Do not allow adding scoring events outside of a playing period
    if (!isPlayingPeriod(match.currentPeriod)) {
      return;
    }
    // Determine team id from key
    const teamId = match[teamKey].id;
    const period = match.currentPeriod;
    const nowSeconds = match.elapsedTime;
    const event = {
      id: generateId(),
      type: EventType.SHOT,
      period,
      timeElapsed: nowSeconds,
      teamId: teamId,
      player1Id: null,
      player2Id: null,
      shotOutcome: outcome,
      shotType: ShotType.FROM_PLAY,
      foulOutcome: null,
      cardType: null,
      wonKickout: null,
      noteText: null
    };
    match.events.push(event);
    // Update scoreboard, events list and last event display
    updateScoreboard(match);
    renderEventsList(match);
    renderLastEvent(match);
    saveAppState();
  }

  /*
   * Show the score event modal for selecting shot type and player.
   * When a user taps the goal or point button on a team card, rather than
   * immediately recording a default shot (via quickAddShot), we present a
   * tailored form.  The form lets them choose the shot type (e.g. Free,
   * Penalty) and the player responsible, and add optional notes.  Once
   * confirmed, the event is recorded and the scoreboard updated.
   *
   * @param {string} teamKey - 'team1' or 'team2'
   * @param {string} outcome - ShotOutcome.GOAL or ShotOutcome.POINT
   */
  let scoreModalData = null;
  function showScoreModal(teamKey, outcome, initial = {}) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    // Only allow scoring during playing periods (except when editing)
    if (!initial.isEdit && !isPlayingPeriod(match.currentPeriod)) {
      return;
    }
    // Prepare state for modal.  If editing an existing event, preserve its
    // identifiers.  The `initial` object may contain: shotType, playerId,
    // isEdit (boolean) and eventId.
    scoreModalData = {
      teamKey,
      outcome,
      selectedShotType: initial.shotType || ShotType.FROM_PLAY,
      selectedPlayerId: initial.playerId != null ? initial.playerId : null,
      isEdit: initial.isEdit || false,
      eventId: initial.eventId || null
    };
    // References to modal elements
    const modal = document.getElementById('score-event-modal');
    const titleEl = document.getElementById('score-modal-title');
    const typeListEl = document.getElementById('score-type-list');
    const playerListEl = document.getElementById('score-player-list');
    const notesInput = document.getElementById('score-notes');
    // Clear previous content
    titleEl.innerHTML = '';
    typeListEl.innerHTML = '';
    playerListEl.innerHTML = '';
    notesInput.value = '';

    // If editing, set notes from existing event
    if (initial.isEdit && initial.eventId) {
      const match = findMatchById(appState.currentMatchId);
      const existingEvent = match?.events.find(e => e.id === initial.eventId);
      if (existingEvent && existingEvent.noteText) {
        setTimeout(() => {
          const notesInput = document.getElementById('score-notes');
          if (notesInput) notesInput.value = existingEvent.noteText;
        }, 0);
      }
    }

    // Build header with appropriate icon and label.
    // Wrapped in a helper so the score-type picker (added below) can re-render
    // the title when the user toggles between Point and 2 Pointer.
    const isMissEvent = outcome !== ShotOutcome.GOAL && outcome !== ShotOutcome.POINT && outcome !== ShotOutcome.TWO_POINTER;
    function renderScoreModalTitle(outcomeVal) {
      titleEl.innerHTML = '';
      let labelText;
      if (isMissEvent) {
        const missIcon = document.createElement('img');
        // Use the same Miss glyph as the event-type chooser so the icon
        // identity is consistent between picking the event type and editing it.
        missIcon.src = 'icons/missevent.svg';
        missIcon.alt = 'Miss';
        missIcon.classList.add('w-6', 'h-6');
        titleEl.appendChild(missIcon);
        labelText = 'Miss';
      } else {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');
        icon.classList.add('w-6', 'h-6');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill-rule', 'evenodd');
        path.setAttribute('d', 'M3 2.25a.75.75 0 0 1 .75.75v.54l1.838-.46a9.75 9.75 0 0 1 6.725.738l.108.054A8.25 8.25 0 0 0 18 4.524l3.11-.732a.75.75 0 0 1 .917.81 47.784 47.784 0 0 0 .005 10.337.75.75 0 0 1-.574.812l-3.114.733a9.75 9.75 0 0 1-6.594-.77l-.108-.054a8.25 8.25 0 0 0-5.69-.625l-2.202.55V21a.75.75 0 0 1-1.5 0V3A.75.75 0 0 1 3 2.25Z');
        path.setAttribute('clip-rule', 'evenodd');
        if (outcomeVal === ShotOutcome.GOAL) {
          path.setAttribute('fill', '#22C55E');
          labelText = 'Goal';
        } else if (outcomeVal === ShotOutcome.TWO_POINTER) {
          path.setAttribute('fill', '#FB923C');
          labelText = '2 Pointer';
        } else {
          path.setAttribute('fill', '#FFFFFF');
          labelText = 'Point';
        }
        icon.appendChild(path);
        titleEl.appendChild(icon);
      }
      const labelEl = document.createElement('span');
      labelEl.textContent = labelText;
      labelEl.classList.add('text-xl', 'font-semibold');
      titleEl.appendChild(labelEl);
    }
    renderScoreModalTitle(outcome);
    // Meta section removed to save space
    
    if (isMissEvent) {
      // For miss events, show both shot types AND miss types
      // Set default values: From Play for shot type, Wide for miss type
      if (!scoreModalData.selectedShotType) {
        scoreModalData.selectedShotType = ShotType.FROM_PLAY;
      }
      if (scoreModalData.outcome === ShotOutcome.WIDE && !initial.shotType) {
        // Only use default if this is a new miss event (not editing)
        scoreModalData.outcome = ShotOutcome.WIDE;
      }
      
      // Create shot type section
      const shotTypeHeader = document.createElement('div');
      shotTypeHeader.className = 'text-sm font-medium text-gray-300 mb-2';
      shotTypeHeader.textContent = 'Shot Type';
      typeListEl.appendChild(shotTypeHeader);
      
      const shotOptions = [
        { value: ShotType.FROM_PLAY, label: 'From Play' },
        { value: ShotType.FREE, label: 'Free' },
        { value: ShotType.PENALTY, label: 'Penalty' },
        { value: ShotType.FORTY_FIVE, label: '45m/65m' },
        { value: ShotType.SIDELINE, label: 'Sideline' },
        { value: ShotType.MARK, label: 'Mark' }
      ];
      
      shotOptions.forEach(({ value, label }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.value = value;
        btn.dataset.section = 'shot';
        btn.textContent = label;
        btn.className = 'w-full text-left px-3 py-1 border border-gray-600 rounded text-sm mb-1';
        
        if (value === scoreModalData.selectedShotType) {
          btn.classList.add('bg-blue-600', 'text-white');
        } else {
          btn.classList.add('bg-gray-700', 'text-gray-100');
        }
        
        btn.addEventListener('click', () => {
          scoreModalData.selectedShotType = value;
          // Highlight selected shot type
          typeListEl.querySelectorAll('[data-section="shot"]').forEach((item) => {
            if (item.dataset.value === value) {
              item.classList.add('bg-blue-600', 'text-white');
              item.classList.remove('bg-gray-700', 'text-gray-100');
            } else {
              item.classList.remove('bg-blue-600', 'text-white');
              item.classList.add('bg-gray-700', 'text-gray-100');
            }
          });
        });
        typeListEl.appendChild(btn);
      });
      
      // Add spacing between sections
      const spacer = document.createElement('div');
      spacer.className = 'mb-3';
      typeListEl.appendChild(spacer);
      
      // Create miss type section
      const missTypeHeader = document.createElement('div');
      missTypeHeader.className = 'text-sm font-medium text-gray-300 mb-2';
      missTypeHeader.textContent = 'Miss Type';
      typeListEl.appendChild(missTypeHeader);
      
      const missOptions = [
        { value: ShotOutcome.WIDE, label: 'Wide' },
        { value: ShotOutcome.SAVED, label: 'Saved' },
        { value: ShotOutcome.DROPPED_SHORT, label: 'Dropped Short' },
        { value: ShotOutcome.OFF_POST, label: 'Off Post' }
      ];
      
      missOptions.forEach(({ value, label }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.value = value;
        btn.dataset.section = 'miss';
        btn.textContent = label;
        btn.className = 'w-full text-left px-3 py-1 border border-gray-600 rounded text-sm mb-1';
        
        if (value === scoreModalData.outcome) {
          btn.classList.add('bg-blue-600', 'text-white');
        } else {
          btn.classList.add('bg-gray-700', 'text-gray-100');
        }
        
        btn.addEventListener('click', () => {
          scoreModalData.outcome = value;
          // Highlight selected miss type
          typeListEl.querySelectorAll('[data-section="miss"]').forEach((item) => {
            if (item.dataset.value === value) {
              item.classList.add('bg-blue-600', 'text-white');
              item.classList.remove('bg-gray-700', 'text-gray-100');
            } else {
              item.classList.remove('bg-blue-600', 'text-white');
              item.classList.add('bg-gray-700', 'text-gray-100');
            }
          });
        });
        typeListEl.appendChild(btn);
      });
    } else {
      // For scoring events: optionally show a Point / 2-Pointer toggle for
      // football & ladies football (the orange flag was removed from the
      // scoreboard; the choice now lives here).
      const supportsTwoPointer = match.matchType === 'football' || match.matchType === 'ladiesFootball';
      const isPointScoring = outcome === ShotOutcome.POINT || outcome === ShotOutcome.TWO_POINTER;
      if (supportsTwoPointer && isPointScoring) {
        const scoreTypeHeader = document.createElement('div');
        scoreTypeHeader.className = 'text-sm font-medium text-gray-300 mb-2';
        scoreTypeHeader.textContent = 'Score Type';
        typeListEl.appendChild(scoreTypeHeader);

        const scoreTypeContainer = document.createElement('div');
        scoreTypeContainer.className = 'mb-3';

        const scoreTypeOptions = [
          { value: ShotOutcome.POINT, label: 'Point' },
          { value: ShotOutcome.TWO_POINTER, label: '2 Pointer' }
        ];
        scoreTypeOptions.forEach(({ value, label }) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.dataset.value = value;
          btn.dataset.section = 'scoreType';
          btn.textContent = label;
          btn.className = 'w-full text-left p-2 border border-gray-600 rounded text-sm mb-1';
          if (value === scoreModalData.outcome) {
            btn.classList.add('bg-blue-600', 'text-white');
          } else {
            btn.classList.add('bg-gray-700', 'text-gray-100');
          }
          btn.addEventListener('click', () => {
            scoreModalData.outcome = value;
            scoreTypeContainer.querySelectorAll('button').forEach((item) => {
              if (item.dataset.value === value) {
                item.classList.add('bg-blue-600', 'text-white');
                item.classList.remove('bg-gray-700', 'text-gray-100');
              } else {
                item.classList.remove('bg-blue-600', 'text-white');
                item.classList.add('bg-gray-700', 'text-gray-100');
              }
            });
            renderScoreModalTitle(value);
          });
          scoreTypeContainer.appendChild(btn);
        });
        typeListEl.appendChild(scoreTypeContainer);
      }

      // For scoring events, show shot types with header
      const shotTypeHeader = document.createElement('div');
      shotTypeHeader.className = 'text-sm font-medium text-gray-300 mb-2';
      shotTypeHeader.textContent = 'Shot Type';
      typeListEl.appendChild(shotTypeHeader);

      const shotOptions = [
        { value: ShotType.FROM_PLAY, label: 'From Play' },
        { value: ShotType.FREE, label: 'Free' },
        { value: ShotType.PENALTY, label: 'Penalty' },
        { value: ShotType.FORTY_FIVE, label: '45m/65m' },
        { value: ShotType.SIDELINE, label: 'Sideline' },
        { value: ShotType.MARK, label: 'Mark' }
      ];
      
      shotOptions.forEach(({ value, label }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.value = value;
        btn.dataset.section = 'shot';
        btn.textContent = label;
        btn.className = 'w-full text-left p-2 border border-gray-600 rounded text-sm';

        if (value === scoreModalData.selectedShotType) {
          btn.classList.add('bg-blue-600', 'text-white');
        } else {
          btn.classList.add('bg-gray-700', 'text-gray-100');
        }

        btn.addEventListener('click', () => {
          scoreModalData.selectedShotType = value;
          // Highlight selected shot type — scope to shot buttons only, so the
          // Point / 2-Pointer score-type buttons keep their selected state.
          typeListEl.querySelectorAll('[data-section="shot"]').forEach((item) => {
            if (item.dataset.value === value) {
              item.classList.add('bg-blue-600', 'text-white');
              item.classList.remove('bg-gray-700', 'text-gray-100');
            } else {
              item.classList.remove('bg-blue-600', 'text-white');
              item.classList.add('bg-gray-700', 'text-gray-100');
            }
          });
        });
        typeListEl.appendChild(btn);
      });
    }
    // Build player list.  Include a blank option at the top for None.
    const players = match[teamKey].players.slice().sort((a, b) => a.jerseyNumber - b.jerseyNumber);
    // Add None option
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.dataset.value = '';
    // Provide default styling; highlight logic will override when selected
    noneBtn.className = 'w-full text-left px-3 py-1 border border-gray-600 rounded text-sm mb-1 bg-gray-700 text-gray-100';
    noneBtn.innerHTML = `<div class="flex items-center space-x-2"><span class="jersey-chip">--</span><span>None</span></div>`;
    noneBtn.addEventListener('click', () => selectPlayer(null));
    playerListEl.appendChild(noneBtn);
    // Helper to highlight selected player
    function selectPlayer(id) {
      // id may be null to represent no player selected.  Use empty string for comparison.
      scoreModalData.selectedPlayerId = id;
      const items = playerListEl.querySelectorAll('button');
      const compareVal = id === null || id === undefined ? '' : String(id);
      items.forEach((item) => {
        if (item.dataset.value === compareVal) {
          item.classList.add('bg-blue-600', 'text-white');
          item.classList.remove('bg-gray-700', 'text-gray-100');
        } else {
          item.classList.remove('bg-blue-600', 'text-white');
          item.classList.add('bg-gray-700', 'text-gray-100');
        }
      });
    }
    // For each player, create a button row
    players.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.value = p.id;
      btn.innerHTML = `<div class="flex items-center space-x-2"><span class="jersey-chip">${p.jerseyNumber}</span><span>${p.name}</span></div>`;
      btn.className = 'w-full text-left px-3 py-1 border border-gray-600 rounded text-sm mb-1 bg-gray-700 text-gray-100';
      btn.addEventListener('click', () => selectPlayer(p.id));
      playerListEl.appendChild(btn);
    });
    // highlight initial selection (from initial.playerId)
    selectPlayer(scoreModalData.selectedPlayerId);
    // Show modal
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  // Hide score modal and clear state
  function hideScoreModal() {
    const modal = document.getElementById('score-event-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    // Reset state
    scoreModalData = null;
  }

  // Save score event and close modal
  function saveScoreEvent() {
    if (!scoreModalData) return;
    const { teamKey, outcome, selectedShotType, selectedPlayerId } = scoreModalData;
    const notesInput = document.getElementById('score-notes');
    const noteText = notesInput ? notesInput.value.trim() : null;
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      hideScoreModal();
      return;
    }
    if (scoreModalData.isEdit && scoreModalData.eventId) {
      // Update existing event rather than creating a new one
      const existing = match.events.find((ev) => ev.id === scoreModalData.eventId);
      if (existing) {
        existing.teamId = match[teamKey].id;
        existing.player1Id = selectedPlayerId || null;
        existing.shotOutcome = outcome;
        existing.shotType = selectedShotType;
        existing.noteText = noteText || null;
        // Also update period/time to current elapsed time (if we want to allow editing time?)
        // For editing events we leave original period/time unchanged to preserve chronology.
      }
    } else {
      // Create event
      const event = {
        id: generateId(),
        type: EventType.SHOT,
        period: match.currentPeriod,
        timeElapsed: match.elapsedTime,
        teamId: match[teamKey].id,
        player1Id: selectedPlayerId || null,
        player2Id: null,
        shotOutcome: outcome,
        shotType: selectedShotType,
        foulOutcome: null,
        cardType: null,
        wonKickout: null,
        noteText: noteText || null
      };
      match.events.push(event);
    }
    // Update UI and storage
    updateScoreboard(match);
    renderEventsList(match);
    renderLastEvent(match);
    saveAppState();
    // Close modal
    hideScoreModal();
  }

  // Foul modal data
  let foulModalData = null;

  // Show foul modal for combined foul + card event
  function showFoulModal(teamKey, initial = {}) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    
    // Only allow foul events during playing periods (except when editing)
    if (!initial.isEdit && !isPlayingPeriod(match.currentPeriod)) {
      return;
    }
    
    // Prepare state for modal
    foulModalData = {
      teamKey,
      selectedFoulType: initial.foulType || 'free',
      selectedCardType: initial.cardType || 'none',
      selectedPlayerId: initial.playerId != null ? initial.playerId : null,
      isEdit: initial.isEdit || false,
      eventId: initial.eventId || null
    };
    
    // If editing, set notes from existing event
    if (initial.isEdit && initial.eventId) {
      const match = findMatchById(appState.currentMatchId);
      const existingEvent = match?.events.find(e => e.id === initial.eventId);
      if (existingEvent && existingEvent.noteText) {
        setTimeout(() => {
          const notesInput = document.getElementById('foul-notes');
          if (notesInput) notesInput.value = existingEvent.noteText;
        }, 0);
      }
    }
    
    // References to modal elements
    const modal = document.getElementById('foul-event-modal');
    const metaEl = document.getElementById('foul-event-meta');
    const playerListEl = document.getElementById('foul-player-list');
    const notesInput = document.getElementById('foul-notes');
    
    // Clear previous content
    playerListEl.innerHTML = '';
    notesInput.value = '';
    
    // Set up meta info (team name, time, period)
    const team = match[teamKey];
    const formattedTime = Math.floor(match.elapsedTime / 60).toString().padStart(2, '0') + ':' + 
                         (match.elapsedTime % 60).toString().padStart(2, '0');
    metaEl.textContent = `${team.name} • ${formattedTime} • ${match.currentPeriod}`;
    
    // Build player list
    const players = match[teamKey].players.slice().sort((a, b) => a.jerseyNumber - b.jerseyNumber);
    
    // Add None option
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.dataset.playerId = '';
    noneBtn.className = 'w-full text-left p-2 text-sm flex items-center space-x-2 border border-gray-600 rounded';
    
    if (foulModalData.selectedPlayerId === null) {
      noneBtn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
    } else {
      noneBtn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
    }
    
    const noneCircle = document.createElement('div');
    noneCircle.className = 'w-6 h-6 rounded bg-gray-500 flex items-center justify-center text-xs font-bold';
    noneCircle.textContent = '--';
    const noneSpan = document.createElement('span');
    noneSpan.textContent = 'None';
    
    noneBtn.appendChild(noneCircle);
    noneBtn.appendChild(noneSpan);
    
    noneBtn.addEventListener('click', () => {
      foulModalData.selectedPlayerId = null;
      // Update button styles
      playerListEl.querySelectorAll('button').forEach((item) => {
        if (item.dataset.playerId === '') {
          item.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
          item.classList.remove('bg-gray-700', 'text-gray-100', 'border-gray-600');
        } else {
          item.classList.remove('bg-blue-600', 'text-white', 'border-blue-600');
          item.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
        }
      });
    });
    
    playerListEl.appendChild(noneBtn);
    
    // Add player buttons
    players.forEach((player) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.playerId = player.id;
      btn.className = 'w-full text-left p-2 text-sm flex items-center space-x-2 border border-gray-600 rounded';
      
      if (player.id === foulModalData.selectedPlayerId) {
        btn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
      } else {
        btn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
      }
      
      const circle = document.createElement('div');
      circle.className = 'w-6 h-6 rounded bg-gray-600 flex items-center justify-center text-xs font-bold';
      circle.textContent = player.jerseyNumber;
      
      const nameSpan = document.createElement('span');
      const defaultName = `No.${player.jerseyNumber}`;
      nameSpan.textContent = player.name && player.name !== defaultName ? player.name : defaultName;
      
      btn.appendChild(circle);
      btn.appendChild(nameSpan);
      
      btn.addEventListener('click', () => {
        foulModalData.selectedPlayerId = player.id;
        // Update button styles
        playerListEl.querySelectorAll('button').forEach((item) => {
          if (item.dataset.playerId === player.id) {
            item.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
            item.classList.remove('bg-gray-700', 'text-gray-100', 'border-gray-600');
          } else {
            item.classList.remove('bg-blue-600', 'text-white', 'border-blue-600');
            item.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
          }
        });
      });
      
      playerListEl.appendChild(btn);
    });
    
    // Update foul type and card type selection display
    updateFoulTypeSelection();
    updateCardTypeSelection();
    
    // Show modal
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }


  // Update foul type button styles
  function updateFoulTypeSelection() {
    const freeBtn = document.getElementById('foul-type-free');
    const penaltyBtn = document.getElementById('foul-type-penalty');
    
    [freeBtn, penaltyBtn].forEach(btn => {
      const foulType = btn.dataset.foulType;
      if (foulType === foulModalData.selectedFoulType) {
        btn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
        btn.classList.remove('bg-gray-700', 'text-gray-100', 'border-gray-600');
      } else {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600');
        btn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
      }
    });
  }


  // Update card type button styles
  function updateCardTypeSelection() {
    const cardButtons = ['none', 'yellow', 'red', 'black'];
    
    cardButtons.forEach(cardType => {
      const btn = document.getElementById(`card-type-${cardType}`);
      if (cardType === foulModalData.selectedCardType) {
        btn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
        btn.classList.remove('bg-gray-700', 'text-gray-100', 'border-gray-600');
      } else {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600');
        btn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
      }
    });
  }

  // Hide foul modal
  function hideFoulModal() {
    const modal = document.getElementById('foul-event-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    foulModalData = null;
  }

  // Save foul event and close modal
  function saveFoulEvent() {
    if (!foulModalData) return;
    
    const { teamKey, selectedFoulType, selectedCardType, selectedPlayerId } = foulModalData;
    const notesInput = document.getElementById('foul-notes');
    const noteText = notesInput ? notesInput.value.trim() : null;
    
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      hideFoulModal();
      return;
    }
    
    if (foulModalData.isEdit && foulModalData.eventId) {
      // Update existing event
      const existing = match.events.find((ev) => ev.id === foulModalData.eventId);
      if (existing) {
        existing.teamId = match[teamKey].id;
        existing.player1Id = selectedPlayerId || null;
        existing.foulOutcome = selectedFoulType;
        existing.cardType = selectedCardType !== 'none' ? selectedCardType : null;
        existing.noteText = noteText || null;
      }
    } else {
      // Create foul event
      const foulEvent = {
        id: generateId(),
        type: EventType.FOUL_CONCEDED,
        period: match.currentPeriod,
        timeElapsed: match.elapsedTime,
        teamId: match[teamKey].id,
        player1Id: selectedPlayerId || null,
        player2Id: null,
        shotOutcome: null,
        shotType: null,
        foulOutcome: selectedFoulType,
        cardType: selectedCardType !== 'none' ? selectedCardType : null,
        wonKickout: null,
        noteText: noteText || null
      };
      match.events.push(foulEvent);
    }
    
    // Update UI and storage
    updateScoreboard(match);
    renderEventsList(match);
    renderLastEvent(match);
    saveAppState();
    
    // Close modal
    hideFoulModal();
  }

  // Kickout modal data
  let kickoutModalData = null;

  // Show kickout modal
  function showKickoutModal(teamKey, initial = {}) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    
    // Only allow kickout events during playing periods (except when editing)
    if (!initial.isEdit && !isPlayingPeriod(match.currentPeriod)) {
      return;
    }
    
    // Prepare state for modal
    kickoutModalData = {
      teamKey,
      selectedOutcome: initial.outcome || 'won',
      selectedPlayerId: initial.playerId != null ? initial.playerId : null,
      isEdit: initial.isEdit || false,
      eventId: initial.eventId || null
    };
    
    // If editing, set notes from existing event
    if (initial.isEdit && initial.eventId) {
      const match = findMatchById(appState.currentMatchId);
      const existingEvent = match?.events.find(e => e.id === initial.eventId);
      if (existingEvent && existingEvent.noteText) {
        setTimeout(() => {
          const notesInput = document.getElementById('kickout-notes');
          if (notesInput) notesInput.value = existingEvent.noteText;
        }, 0);
      }
    }
    
    // References to modal elements
    const modal = document.getElementById('kickout-event-modal');
    const metaEl = document.getElementById('kickout-event-meta');
    const playerListEl = document.getElementById('kickout-player-list');
    const notesInput = document.getElementById('kickout-notes');
    
    // Clear previous content
    playerListEl.innerHTML = '';
    notesInput.value = '';
    
    // Set up meta info (team name, time, period)
    const team = match[teamKey];
    const formattedTime = Math.floor(match.elapsedTime / 60).toString().padStart(2, '0') + ':' + 
                         (match.elapsedTime % 60).toString().padStart(2, '0');
    metaEl.textContent = `${team.name} • ${formattedTime} • ${match.currentPeriod}`;
    
    // Build player list (same as foul modal)
    const players = match[teamKey].players.slice().sort((a, b) => a.jerseyNumber - b.jerseyNumber);
    
    // Add None option
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.dataset.playerId = '';
    noneBtn.className = 'w-full text-left p-2 text-sm flex items-center space-x-2 border border-gray-600 rounded';
    
    if (kickoutModalData.selectedPlayerId === null) {
      noneBtn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
    } else {
      noneBtn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
    }
    
    const noneCircle = document.createElement('div');
    noneCircle.className = 'w-6 h-6 rounded bg-gray-500 flex items-center justify-center text-xs font-bold';
    noneCircle.textContent = '--';
    const noneSpan = document.createElement('span');
    noneSpan.textContent = 'None';
    
    noneBtn.appendChild(noneCircle);
    noneBtn.appendChild(noneSpan);
    
    noneBtn.addEventListener('click', () => {
      kickoutModalData.selectedPlayerId = null;
      // Update button styles
      playerListEl.querySelectorAll('button').forEach((item) => {
        if (item.dataset.playerId === '') {
          item.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
          item.classList.remove('bg-gray-700', 'text-gray-100', 'border-gray-600');
        } else {
          item.classList.remove('bg-blue-600', 'text-white', 'border', 'border-blue-600');
          item.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
        }
      });
    });
    
    playerListEl.appendChild(noneBtn);
    
    // Add player buttons
    players.forEach((player) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.playerId = player.id;
      btn.className = 'w-full text-left p-2 text-sm flex items-center space-x-2 border border-gray-600 rounded';
      
      if (player.id === kickoutModalData.selectedPlayerId) {
        btn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
      } else {
        btn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
      }
      
      const circle = document.createElement('div');
      circle.className = 'w-6 h-6 rounded bg-gray-600 flex items-center justify-center text-xs font-bold';
      circle.textContent = player.jerseyNumber;
      
      const nameSpan = document.createElement('span');
      const defaultName = `No.${player.jerseyNumber}`;
      nameSpan.textContent = player.name && player.name !== defaultName ? player.name : defaultName;
      
      btn.appendChild(circle);
      btn.appendChild(nameSpan);
      
      btn.addEventListener('click', () => {
        kickoutModalData.selectedPlayerId = player.id;
        // Update button styles
        playerListEl.querySelectorAll('button').forEach((item) => {
          if (item.dataset.playerId === player.id) {
            item.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
            item.classList.remove('bg-gray-700', 'text-gray-100', 'border-gray-600');
          } else {
            item.classList.remove('bg-blue-600', 'text-white', 'border', 'border-blue-600');
            item.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
          }
        });
      });
      
      playerListEl.appendChild(btn);
    });
    
    // Update outcome selection display
    updateKickoutOutcomeSelection();
    
    // Show modal
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  // Update kickout outcome button styles
  function updateKickoutOutcomeSelection() {
    const wonBtn = document.getElementById('kickout-outcome-won');
    const lostBtn = document.getElementById('kickout-outcome-lost');
    
    [wonBtn, lostBtn].forEach(btn => {
      const outcome = btn.dataset.kickoutOutcome;
      if (outcome === kickoutModalData.selectedOutcome) {
        btn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
        btn.classList.remove('bg-gray-700', 'text-gray-100', 'border-gray-600');
      } else {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600');
        btn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
      }
    });
  }

  // Hide kickout modal
  function hideKickoutModal() {
    const modal = document.getElementById('kickout-event-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    kickoutModalData = null;
  }

  // Save kickout event and close modal
  function saveKickoutEvent() {
    if (!kickoutModalData) return;
    
    const { teamKey, selectedOutcome, selectedPlayerId } = kickoutModalData;
    const notesInput = document.getElementById('kickout-notes');
    const noteText = notesInput ? notesInput.value.trim() : null;
    
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      hideKickoutModal();
      return;
    }
    
    if (kickoutModalData.isEdit && kickoutModalData.eventId) {
      // Update existing event
      const existing = match.events.find((ev) => ev.id === kickoutModalData.eventId);
      if (existing) {
        existing.teamId = match[teamKey].id;
        existing.player1Id = selectedPlayerId || null;
        existing.wonKickout = selectedOutcome === 'won';
        existing.noteText = noteText || null;
      }
    } else {
      // Create kickout event
      const kickoutEvent = {
        id: generateId(),
        type: EventType.KICKOUT,
        period: match.currentPeriod,
        timeElapsed: match.elapsedTime,
        teamId: match[teamKey].id,
        player1Id: selectedPlayerId || null,
        player2Id: null,
        shotOutcome: null,
        shotType: null,
        foulOutcome: null,
        cardType: null,
        wonKickout: selectedOutcome === 'won',
        noteText: noteText || null
      };
      match.events.push(kickoutEvent);
    }
    
    // Update UI and storage
    updateScoreboard(match);
    renderEventsList(match);
    renderLastEvent(match);
    saveAppState();
    
    // Close modal
    hideKickoutModal();
  }

  // Substitution modal data
  let substitutionModalData = null;

  // Show substitution modal
  function showSubstitutionModal(teamKey, initial = {}) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    
    // Only allow substitution events during playing periods (except when editing)
    if (!initial.isEdit && !isPlayingPeriod(match.currentPeriod)) {
      return;
    }
    
    // Prepare state for modal
    substitutionModalData = {
      teamKey,
      selectedPlayerOffId: initial.playerOffId != null ? initial.playerOffId : null,
      selectedPlayerOnId: initial.playerOnId != null ? initial.playerOnId : null,
      isEdit: initial.isEdit || false,
      eventId: initial.eventId || null
    };
    
    // If editing, set notes from existing event
    if (initial.isEdit && initial.eventId) {
      const match = findMatchById(appState.currentMatchId);
      const existingEvent = match?.events.find(e => e.id === initial.eventId);
      if (existingEvent && existingEvent.noteText) {
        setTimeout(() => {
          const notesInput = document.getElementById('substitution-notes');
          if (notesInput) notesInput.value = existingEvent.noteText;
        }, 0);
      }
    }
    
    // References to modal elements
    const modal = document.getElementById('substitution-event-modal');
    const metaEl = document.getElementById('substitution-event-meta');
    const playerOffListEl = document.getElementById('substitution-player-off-list');
    const playerOnListEl = document.getElementById('substitution-player-on-list');
    const notesInput = document.getElementById('substitution-notes');
    
    // Clear previous content
    playerOffListEl.innerHTML = '';
    playerOnListEl.innerHTML = '';
    notesInput.value = '';
    
    // Set up meta info (team name, time, period)
    const team = match[teamKey];
    const formattedTime = Math.floor(match.elapsedTime / 60).toString().padStart(2, '0') + ':' + 
                         (match.elapsedTime % 60).toString().padStart(2, '0');
    metaEl.textContent = `${team.name} • ${formattedTime} • ${match.currentPeriod}`;
    
    // Build player lists
    const players = match[teamKey].players.slice().sort((a, b) => a.jerseyNumber - b.jerseyNumber);
    
    // Helper function to create player button
    function createPlayerButton(player, isPlayerOff) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.playerId = player.id;
      btn.className = 'w-full text-left p-2 text-sm flex items-center space-x-2 border border-gray-600 rounded';
      
      const isSelected = isPlayerOff ? 
        (player.id === substitutionModalData.selectedPlayerOffId) :
        (player.id === substitutionModalData.selectedPlayerOnId);
      
      if (isSelected) {
        btn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
      } else {
        btn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
      }
      
      const circle = document.createElement('div');
      circle.className = 'w-6 h-6 rounded bg-gray-600 flex items-center justify-center text-xs font-bold';
      circle.textContent = player.jerseyNumber;
      
      const nameSpan = document.createElement('span');
      const defaultName = `No.${player.jerseyNumber}`;
      nameSpan.textContent = player.name && player.name !== defaultName ? player.name : defaultName;
      
      btn.appendChild(circle);
      btn.appendChild(nameSpan);
      
      btn.addEventListener('click', () => {
        if (isPlayerOff) {
          substitutionModalData.selectedPlayerOffId = player.id;
        } else {
          substitutionModalData.selectedPlayerOnId = player.id;
        }
        updateSubstitutionPlayerSelection();
      });
      
      return btn;
    }
    
    // Add None option for Player Off
    const noneOffBtn = document.createElement('button');
    noneOffBtn.type = 'button';
    noneOffBtn.dataset.playerId = '';
    noneOffBtn.className = 'w-full text-left p-2 text-sm flex items-center space-x-2 border border-gray-600 rounded';
    
    if (substitutionModalData.selectedPlayerOffId === null) {
      noneOffBtn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
    } else {
      noneOffBtn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
    }
    
    const noneOffCircle = document.createElement('div');
    noneOffCircle.className = 'w-6 h-6 rounded bg-gray-500 flex items-center justify-center text-xs font-bold';
    noneOffCircle.textContent = '--';
    const noneOffSpan = document.createElement('span');
    noneOffSpan.textContent = 'None';
    
    noneOffBtn.appendChild(noneOffCircle);
    noneOffBtn.appendChild(noneOffSpan);
    
    noneOffBtn.addEventListener('click', () => {
      substitutionModalData.selectedPlayerOffId = null;
      updateSubstitutionPlayerSelection();
    });
    
    playerOffListEl.appendChild(noneOffBtn);
    
    // Add None option for Player On
    const noneOnBtn = document.createElement('button');
    noneOnBtn.type = 'button';
    noneOnBtn.dataset.playerId = '';
    noneOnBtn.className = 'w-full text-left p-2 text-sm flex items-center space-x-2 border border-gray-600 rounded';
    
    if (substitutionModalData.selectedPlayerOnId === null) {
      noneOnBtn.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
    } else {
      noneOnBtn.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
    }
    
    const noneOnCircle = document.createElement('div');
    noneOnCircle.className = 'w-6 h-6 rounded bg-gray-500 flex items-center justify-center text-xs font-bold';
    noneOnCircle.textContent = '--';
    const noneOnSpan = document.createElement('span');
    noneOnSpan.textContent = 'None';
    
    noneOnBtn.appendChild(noneOnCircle);
    noneOnBtn.appendChild(noneOnSpan);
    
    noneOnBtn.addEventListener('click', () => {
      substitutionModalData.selectedPlayerOnId = null;
      updateSubstitutionPlayerSelection();
    });
    
    playerOnListEl.appendChild(noneOnBtn);
    
    // Add player buttons
    players.forEach((player) => {
      playerOffListEl.appendChild(createPlayerButton(player, true));
      playerOnListEl.appendChild(createPlayerButton(player, false));
    });
    
    // Show modal
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  // Update substitution player selection
  function updateSubstitutionPlayerSelection() {
    const playerOffListEl = document.getElementById('substitution-player-off-list');
    const playerOnListEl = document.getElementById('substitution-player-on-list');
    
    // Update Player Off list
    playerOffListEl.querySelectorAll('button').forEach((item) => {
      const playerId = item.dataset.playerId || null;
      if (playerId === substitutionModalData.selectedPlayerOffId || 
          (playerId === '' && substitutionModalData.selectedPlayerOffId === null)) {
        item.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
        item.classList.remove('bg-gray-700', 'text-gray-100', 'border-gray-600');
      } else {
        item.classList.remove('bg-blue-600', 'text-white', 'border', 'border-blue-600');
        item.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
      }
    });
    
    // Update Player On list
    playerOnListEl.querySelectorAll('button').forEach((item) => {
      const playerId = item.dataset.playerId || null;
      if (playerId === substitutionModalData.selectedPlayerOnId || 
          (playerId === '' && substitutionModalData.selectedPlayerOnId === null)) {
        item.classList.add('bg-blue-600', 'text-white', 'border', 'border-blue-600');
        item.classList.remove('bg-gray-700', 'text-gray-100', 'border-gray-600');
      } else {
        item.classList.remove('bg-blue-600', 'text-white', 'border', 'border-blue-600');
        item.classList.add('bg-gray-700', 'text-gray-100', 'border', 'border-gray-600');
      }
    });
  }

  // Hide substitution modal
  function hideSubstitutionModal() {
    const modal = document.getElementById('substitution-event-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    substitutionModalData = null;
  }

  // Save substitution event and close modal
  function saveSubstitutionEvent() {
    if (!substitutionModalData) return;
    
    const { teamKey, selectedPlayerOffId, selectedPlayerOnId } = substitutionModalData;
    const notesInput = document.getElementById('substitution-notes');
    const noteText = notesInput ? notesInput.value.trim() : null;
    
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      hideSubstitutionModal();
      return;
    }
    
    if (substitutionModalData.isEdit && substitutionModalData.eventId) {
      // Update existing event
      const existing = match.events.find((ev) => ev.id === substitutionModalData.eventId);
      if (existing) {
        existing.teamId = match[teamKey].id;
        existing.player1Id = selectedPlayerOffId || null;
        existing.player2Id = selectedPlayerOnId || null;
        existing.noteText = noteText || null;
      }
    } else {
      // Create substitution event
      const substitutionEvent = {
        id: generateId(),
        type: EventType.SUBSTITUTION,
        period: match.currentPeriod,
        timeElapsed: match.elapsedTime,
        teamId: match[teamKey].id,
        player1Id: selectedPlayerOffId || null,
        player2Id: selectedPlayerOnId || null,
        shotOutcome: null,
        shotType: null,
        foulOutcome: null,
        cardType: null,
        wonKickout: null,
        noteText: noteText || null
      };
      match.events.push(substitutionEvent);
    }
    
    // Update UI and storage
    updateScoreboard(match);
    renderEventsList(match);
    renderLastEvent(match);
    saveAppState();
    
    // Close modal
    hideSubstitutionModal();
  }

  // Note modal data
  let noteModalData = null;

  // Show note modal
  function showNoteModal(teamKey, initial = {}) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    
    // Prepare state for modal
    noteModalData = {
      teamKey,
      noteText: initial.noteText || '',
      isEdit: initial.isEdit || false,
      eventId: initial.eventId || null
    };
    
    // References to modal elements
    const modal = document.getElementById('note-event-modal');
    const metaEl = document.getElementById('note-event-meta');
    const noteTextEl = document.getElementById('note-text');
    
    // Clear previous content
    noteTextEl.value = noteModalData.noteText;
    
    // Set up meta info (team name, time, period)
    const team = match[teamKey];
    const formattedTime = Math.floor(match.elapsedTime / 60).toString().padStart(2, '0') + ':' + 
                         (match.elapsedTime % 60).toString().padStart(2, '0');
    metaEl.textContent = `${team.name} • ${formattedTime} • ${match.currentPeriod}`;
    
    // Show modal
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  // Hide note modal
  function hideNoteModal() {
    const modal = document.getElementById('note-event-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    noteModalData = null;
  }

  // Save note event and close modal
  function saveNoteEvent() {
    if (!noteModalData) return;
    
    const { teamKey } = noteModalData;
    const noteTextEl = document.getElementById('note-text');
    const noteText = noteTextEl ? noteTextEl.value.trim() : '';
    
    if (!noteText) {
      // Don't save empty notes
      hideNoteModal();
      return;
    }
    
    const match = findMatchById(appState.currentMatchId);
    if (!match) {
      hideNoteModal();
      return;
    }
    
    if (noteModalData.isEdit && noteModalData.eventId) {
      // Update existing event
      const existing = match.events.find((ev) => ev.id === noteModalData.eventId);
      if (existing) {
        existing.teamId = match[teamKey].id;
        existing.noteText = noteText;
      }
    } else {
      // Create note event
      const noteEvent = {
        id: generateId(),
        type: EventType.NOTE,
        period: match.currentPeriod,
        timeElapsed: match.elapsedTime,
        teamId: match[teamKey].id,
        player1Id: null,
        player2Id: null,
        shotOutcome: null,
        shotType: null,
        foulOutcome: null,
        cardType: null,
        wonKickout: null,
        noteText: noteText
      };
      match.events.push(noteEvent);
    }
    
    // Update UI and storage
    updateScoreboard(match);
    renderEventsList(match);
    renderLastEvent(match);
    saveAppState();
    
    // Close modal
    hideNoteModal();
  }

  // Show edit players view.  When a team key ("team1" or "team2") is provided, only
  // that team's roster is presented for editing.  Otherwise, both teams are shown.
  function showEditPlayers(teamKey) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    const container = document.getElementById('players-edit-container');
    container.innerHTML = '';
    
    // Helper to build a section for a single team's roster.
    function buildTeamSection(team, key) {
      const sec = document.createElement('div');
      sec.className = 'team-players';

      // Team name header. Title block on the left (team name + small mono
      // "N PLAYERS" caption), Swap toggle on the right. Reads like a team-sheet
      // section header rather than a plain label.
      const header = document.createElement('div');
      header.className = 'team-players-header';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'team-players-title';

      const teamName = document.createElement('h3');
      teamName.textContent = team.name;
      titleWrap.appendChild(teamName);

      const count = document.createElement('span');
      count.className = 'team-players-count';
      count.textContent = `${team.players.length} Players`;
      titleWrap.appendChild(count);

      header.appendChild(titleWrap);

      // Right-hand actions: Import (before throw-in only) and the Swap toggle.
      const actions = document.createElement('div');
      actions.className = 'team-players-actions';

      // Importing rewrites the whole roster, so it's offered only before the
      // match starts — relabelling players mid-match would rewrite the names
      // shown against events already recorded.
      if (match.currentPeriod === MatchPeriod.NOT_STARTED && appState.playerPanels.length > 0) {
        const importBtn = document.createElement('button');
        // Class, not id: both teams render into the same container.
        // No primary-btn/bg-blue-600 here: `button.bg-blue-600.primary-btn` in
        // styles.css is more specific than .panel-import-btn and would repaint this
        // as a solid green CTA, losing the ghost pill it shares with Swap.
        importBtn.className = 'panel-import-btn';
        importBtn.type = 'button';
        importBtn.dataset.teamKey = key;
        importBtn.title = 'Import a panel into this team';
        importBtn.textContent = 'Import';
        importBtn.addEventListener('click', () => showPanelImportPicker(key));
        actions.appendChild(importBtn);
      }

      const swapBtn = document.createElement('button');
      swapBtn.id = 'swap-players-btn';
      swapBtn.type = 'button';
      swapBtn.className = 'primary-btn bg-blue-600 hover:bg-blue-700 text-white px-4 py-2';
      swapBtn.title = 'Swap two players';
      swapBtn.textContent = 'Swap';
      // Wrapped so the click event isn't passed as the container id.
      swapBtn.addEventListener('click', () => toggleSwapMode('players-edit-container'));
      actions.appendChild(swapBtn);
      header.appendChild(actions);

      sec.appendChild(header);

      // Sort players numerically by jersey number for consistency.
      const playersSorted = [...team.players].sort((a, b) => a.jerseyNumber - b.jerseyNumber);
      playersSorted.forEach((player, idx) => {
        const row = document.createElement('div');
        row.className = 'player-row';
        // --i drives the staggered reveal animation defined in styles.css.
        row.style.setProperty('--i', idx);
        row.dataset.playerId = player.id;
        row.dataset.teamKey = key;
        row.dataset.jerseyNumber = player.jerseyNumber;

        // Jersey number badge — reuses the shared `.jersey-chip` style.
        const chip = document.createElement('span');
        chip.className = 'jersey-chip';
        chip.textContent = player.jerseyNumber;

        // Name input — borderless inside the card; gets a subtle background
        // on focus so editing is still obvious.
        const input = document.createElement('input');
        input.type = 'text';
        input.value = player.name;
        input.className = 'player-row-name';
        // Identifiers retained on the input for savePlayerChanges().
        input.dataset.playerId = player.id;
        input.dataset.teamKey = key;
        input.dataset.jerseyNumber = player.jerseyNumber;

        // Select-from-panel button (icon only, right-aligned in the card).
        const selectBtn = document.createElement('button');
        selectBtn.type = 'button';
        selectBtn.className = 'player-row-action';
        selectBtn.title = 'Select Player from Panel';
        selectBtn.innerHTML = '<img src="icons/selectplayer.svg" alt="" class="w-6 h-6" />';
        selectBtn.dataset.teamKey = key;
        selectBtn.dataset.playerId = player.id;
        selectBtn.dataset.jerseyNumber = player.jerseyNumber;
        selectBtn.addEventListener('click', (e) => {
          // Don't open the panel picker while swap-mode is active — the row
          // tap handler takes over and the action button is hidden anyway.
          if (document.getElementById('players-edit-container').getAttribute('data-swap-mode') === 'on') {
            e.stopPropagation();
            return;
          }
          const button = e.currentTarget;
          showPlayerSelectionDropdown(button.dataset.teamKey, button.dataset.playerId, button.dataset.jerseyNumber, button);
        });

        // Row-level click for swap mode. In normal mode this no-ops; in swap
        // mode the input is `pointer-events: none` so taps on the input area
        // bubble to the row.
        row.addEventListener('click', (e) => {
          handleSwapRowTap(document.getElementById('players-edit-container'), row, e);
        });

        row.appendChild(chip);
        row.appendChild(input);
        row.appendChild(selectBtn);
        sec.appendChild(row);
      });

      return sec;
    }
    if (teamKey === 'team1' || teamKey === 'team2') {
      // Show only the requested team's players
      const team = match[teamKey];
      container.appendChild(buildTeamSection(team, teamKey));
    } else {
      // Fall back to showing both teams
      container.appendChild(buildTeamSection(match.team1, 'team1'));
      container.appendChild(buildTeamSection(match.team2, 'team2'));
    }
    // Always start in normal (non-swap) mode whenever the view is shown.
    setSwapMode(false);
    // Display the edit players view
    showView('edit-players-view');
  }

  // Function removed - panel selection moved to Select Player screen

  // Show player selection as a page view
  function showPlayerSelectionDropdown(teamKey, playerId, jerseyNumber, buttonElement) {
    // Store selection context for later use
    appState.playerSelectionContext = {
      teamKey: teamKey,
      playerId: playerId,
      jerseyNumber: jerseyNumber
    };
    
    // Get page elements
    const jerseyInfo = document.getElementById('player-selection-jersey-info');
    const panelDropdown = document.getElementById('player-selection-panel-dropdown');
    const playerList = document.getElementById('player-selection-list-page');
    
    // Set jersey info — formatted so the number renders as a glowing
    // scoreboard digit alongside an uppercase mono caption.
    jerseyInfo.innerHTML = `Filling jersey <span class="player-selection-jersey-num">${jerseyNumber}</span>`;

    // The bulk-import picker reuses this view and hides the dropdown; restore it.
    panelDropdown.style.display = '';
    
    // Get saved panel selection first
    const panelKey = `${appState.currentMatchId}-${appState.playerSelectionContext.teamKey}`;
    const lastSelectedPanel = appState.lastSelectedPanels[panelKey];
    const panelId = buttonElement.dataset.panelId || lastSelectedPanel;
    
    // Clear and populate panel dropdown - only include actual panels
    panelDropdown.innerHTML = '';
    
    // Add placeholder option only if no panel is selected
    if (!panelId) {
      const placeholderOption = document.createElement('option');
      placeholderOption.value = '';
      placeholderOption.textContent = 'Select Panel';
      placeholderOption.disabled = true;
      placeholderOption.selected = true;
      panelDropdown.appendChild(placeholderOption);
    }
    
    appState.playerPanels.forEach(panel => {
      const option = document.createElement('option');
      option.value = panel.id;
      option.textContent = panel.name;
      panelDropdown.appendChild(option);
    });
    
    // Add dropdown change event listener (remove any existing first)
    const newDropdown = panelDropdown.cloneNode(true);
    panelDropdown.parentNode.replaceChild(newDropdown, panelDropdown);
    
    // Set initial panel selection
    if (panelId) {
      newDropdown.value = panelId;
    } else {
      // Explicitly set to empty value to ensure placeholder is shown
      newDropdown.value = '';
    }
    
    newDropdown.addEventListener('change', (e) => {
      const selectedPanelId = e.target.value;
      updatePlayerSelectionList(selectedPanelId, playerList);
      
      // Save the selected panel for this match and team
      const panelKey = `${appState.currentMatchId}-${appState.playerSelectionContext.teamKey}`;
      if (selectedPanelId) {
        appState.lastSelectedPanels[panelKey] = selectedPanelId;
      } else {
        delete appState.lastSelectedPanels[panelKey];
      }
      saveAppState();
    });
    
    // Initialize player list
    updatePlayerSelectionList(panelId || '', playerList);
  
  // Helper function to update player list based on selected panel
  function updatePlayerSelectionList(panelId, playerList) {
    // Clear existing player list
    playerList.innerHTML = '';
    
    if (!panelId) {
      playerList.innerHTML = '<p class="text-gray-400 text-center py-8">Select a panel above to see available players</p>';
      return;
    }
    
    const panel = appState.playerPanels.find(p => p.id === panelId);
    if (!panel || panel.players.length === 0) {
      playerList.innerHTML = '<p class="text-gray-400 text-center py-8">No players found in selected panel</p>';
      return;
    }
    
    // Add players to list
    panel.players
      .filter(player => player.name.trim() !== '') // Only show players with names
      .forEach((player, idx) => {
        const button = document.createElement('button');
        button.type = 'button';
        // --i drives the staggered reveal animation defined in styles.css.
        button.style.setProperty('--i', idx);

        // Show the panel jersey so it's clear which number a name comes from —
        // the list is in jersey order now that panels are numbered sheets.
        const chip = document.createElement('span');
        chip.className = 'jersey-chip player-selection-chip';
        chip.textContent = player.jerseyNumber;
        button.appendChild(chip);

        const nameEl = document.createElement('span');
        nameEl.textContent = player.name;
        button.appendChild(nameEl);

        button.addEventListener('click', () => {
          selectPlayerForJersey(appState.playerSelectionContext.teamKey,
                              appState.playerSelectionContext.playerId,
                              appState.playerSelectionContext.jerseyNumber,
                              player.name);
          // Return to edit players view
          showView('edit-players-view');
        });

        playerList.appendChild(button);
      });
  }
    
    // Show player selection view
    showView('player-selection-view');
  }

  // Select a player for a jersey number
  function selectPlayerForJersey(teamKey, playerId, jerseyNumber, playerName) {
    const input = document.querySelector(`input[data-player-id="${playerId}"][data-jersey-number="${jerseyNumber}"]`);
    if (input) {
      input.value = playerName;
      input.focus();
      
      // Trigger change event to save the selection
      const event = new Event('change', { bubbles: true });
      input.dispatchEvent(event);
    }
  }

  // Copy an entire panel into one team's roster on the Edit Players screen.
  //
  // Writes to the DOM inputs only — never to appState. That is deliberate:
  //  - Cancel stays honest, since nothing is committed until Done.
  //  - savePlayerChanges() then assigns only `.name` on the existing player
  //    objects, so ids and jersey numbers survive and recorded events keep
  //    resolving to the right player.
  function importPanelIntoTeam(teamKey, panelId) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    // Import is only offered before throw-in; re-check in case the screen is stale.
    if (match.currentPeriod !== MatchPeriod.NOT_STARTED) return;

    const panel = appState.playerPanels.find(p => p.id === panelId);
    if (!panel) return;
    normalizePanel(panel);

    // A live swap selection would point at rows we're about to overwrite.
    setSwapMode(false, 'players-edit-container');

    const byNumber = new Map(panel.players.map(p => [p.jerseyNumber, p]));
    // Scoping by team is essential — both teams render in the same container.
    const inputs = document.querySelectorAll(
      `#players-edit-container input.player-row-name[data-team-key="${teamKey}"]`
    );
    inputs.forEach((input) => {
      const n = parseInt(input.dataset.jerseyNumber, 10);
      const slot = byNumber.get(n);
      const name = slot && slot.name.trim();
      // Empty panel slots reset the jersey to its placeholder. `No.N` is the
      // sentinel the rest of the app tests against to decide whether to show a
      // name alongside the number, so it must be exactly this string.
      input.value = name ? name : `No.${n}`;
    });

    appState.lastSelectedPanels[`${appState.currentMatchId}-${teamKey}`] = panelId;
    saveAppState();
  }

  // Panel picker for a bulk import. Reuses the Player Selection view rather
  // than introducing another screen.
  function showPanelImportPicker(teamKey) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    if (!appState.playerPanels.length) {
      alert('No player panels yet. Create one from the home screen first.');
      return;
    }

    const team = match[teamKey];
    const listEl = document.getElementById('player-selection-list-page');
    const infoEl = document.getElementById('player-selection-jersey-info');
    const dropdownEl = document.getElementById('player-selection-panel-dropdown');
    if (!listEl) return;

    if (infoEl) infoEl.textContent = `Import a panel into ${team.name}`;
    // The panel dropdown is for picking a player within a panel; here the list
    // itself is the panel picker, so hide it.
    if (dropdownEl) dropdownEl.style.display = 'none';

    listEl.innerHTML = '';
    appState.playerPanels.forEach((panel, idx) => {
      normalizePanel(panel);
      const filled = countPanelPlayers(panel);

      const button = document.createElement('button');
      button.type = 'button';
      // --i drives the staggered reveal animation, as in the player list.
      button.style.setProperty('--i', idx);
      button.textContent = `${panel.name}  ·  ${filled} ${filled === 1 ? 'player' : 'players'}`;

      button.addEventListener('click', () => {
        if (confirmPanelImport(panel, team, teamKey, filled)) {
          importPanelIntoTeam(teamKey, panel.id);
          showView('edit-players-view');
        }
      });

      listEl.appendChild(button);
    });

    showView('player-selection-view');
  }

  // Warn before an import that would discard names the user typed. A roster
  // still on its `No.N` defaults has nothing to lose, so don't nag there.
  function confirmPanelImport(panel, team, teamKey, filled) {
    const inputs = document.querySelectorAll(
      `#players-edit-container input.player-row-name[data-team-key="${teamKey}"]`
    );
    const isPristine = Array.from(inputs).every((input) => {
      const v = input.value.trim();
      return v === '' || v === `No.${input.dataset.jerseyNumber}`;
    });
    if (isPristine) return true;

    const emptySlots = PANEL_SIZE - filled;
    return confirm(
      `Import "${panel.name}" into ${team.name}?\n\n` +
      `This replaces all ${PANEL_SIZE} names.` +
      (emptySlots ? ` ${emptySlots} jersey${emptySlots === 1 ? '' : 's'} will reset to the No.N default.` : '')
    );
  }

  // Make player panel functions globally accessible
  window.showPlayerSelectionDropdown = showPlayerSelectionDropdown;
  window.selectPlayerForJersey = selectPlayerForJersey;

  // Save player name changes
  function savePlayerChanges() {
    // Reset swap mode before leaving so a stale highlight doesn't linger.
    setSwapMode(false);
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    const inputs = document.querySelectorAll('#players-edit-container input[data-player-id]');
    inputs.forEach((input) => {
      const playerId = input.dataset.playerId;
      const teamKey = input.dataset.teamKey;
      const team = match[teamKey];
      const player = team.players.find((p) => p.id === playerId);
      if (player) {
        player.name = input.value.trim();
      }
    });
    saveAppState();
    // Re-render match details to reflect updated names
    updateScoreboard(match);
    renderEventsList(match);
    // If event form fields currently displayed for shot or other types, re-render them to update player dropdowns
    const eventTypeSelect = document.getElementById('event-type');
    if (eventTypeSelect && eventTypeSelect.value) {
      renderEventFields(eventTypeSelect.value);
    }
    // Return to match details view
    showView('match-details-view');
  }

  // Cancel editing players without saving
  function cancelPlayerChanges() {
    // Make sure swap mode is reset when leaving the screen
    setSwapMode(false);
    // Simply go back to match details view; no changes have been saved
    showView('match-details-view');
  }

  // ===== Tap-two-to-swap mode =====
  // Shared by the Edit Players screen and the Panel Editor. Each screen supplies
  // its own container/banner/button plus the row and input selectors to use.
  // Holds the currently-selected first row while waiting for the second tap.
  // Resets whenever swap mode toggles off.
  let swapFirstRow = null;

  const SWAP_TARGETS = {
    'players-edit-container': {
      banner: 'swap-mode-banner',
      button: 'swap-players-btn',
      row: '.player-row',
      input: 'input.player-row-name',
      // Edit Players reads the DOM on Done, so no commit event is needed.
      commitOnSwap: false
    },
    'panel-players-list': {
      banner: 'panel-swap-mode-banner',
      button: 'swap-panel-players-btn',
      row: '.panel-player-row',
      input: 'input.panel-player-name',
      // The panel editor saves per-input on `change`, so a swap must announce
      // itself or it would be visible but never persisted.
      commitOnSwap: true
    }
  };

  function getSwapConfig(container) {
    return (container && SWAP_TARGETS[container.id]) || null;
  }

  function setSwapMode(on, containerId = 'players-edit-container') {
    const container = document.getElementById(containerId);
    const cfg = getSwapConfig(container);
    if (!cfg) return;
    const banner = document.getElementById(cfg.banner);
    const btn = document.getElementById(cfg.button);
    if (!container || !banner || !btn) return;
    if (on) {
      container.setAttribute('data-swap-mode', 'on');
      banner.classList.add('is-visible');
      btn.classList.add('is-on');
      // Text stays "Swap" in both states — the amber colour, rotated glyph,
      // and visible banner already communicate that the mode is active.
      // Changing the label to "Cancel Swap" read like "undo my swap" which
      // it doesn't do.
    } else {
      container.removeAttribute('data-swap-mode');
      banner.classList.remove('is-visible');
      btn.classList.remove('is-on');
      // Clear any selection state
      container.querySelectorAll(`${cfg.row}.is-swap-selected`).forEach((r) => r.classList.remove('is-swap-selected'));
      swapFirstRow = null;
    }
  }

  function toggleSwapMode(containerId = 'players-edit-container') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const isOn = container.getAttribute('data-swap-mode') === 'on';
    setSwapMode(!isOn, containerId);
  }

  function togglePanelSwapMode() {
    toggleSwapMode('panel-players-list');
  }

  // Called from each row's click handler. No-ops outside swap mode.
  function handleSwapRowTap(container, row, evt) {
    const cfg = getSwapConfig(container);
    if (!cfg) return;
    if (!container || container.getAttribute('data-swap-mode') !== 'on') return;
    // We're handling the swap interaction — stop the click from also focusing
    // the readonly input or hitting the select-from-panel button.
    if (evt) evt.preventDefault();

    // First tap: remember this row.
    if (!swapFirstRow) {
      swapFirstRow = row;
      row.classList.add('is-swap-selected');
      return;
    }

    // Second tap on the same row: deselect.
    if (swapFirstRow === row) {
      row.classList.remove('is-swap-selected');
      swapFirstRow = null;
      return;
    }

    // Only allow swaps within the same team. Panel rows carry no team key, so
    // this compares undefined to undefined and correctly permits the swap.
    if (swapFirstRow.dataset.teamKey !== row.dataset.teamKey) {
      // Treat as "switch the selection to the new row" rather than fail silently.
      swapFirstRow.classList.remove('is-swap-selected');
      swapFirstRow = row;
      row.classList.add('is-swap-selected');
      return;
    }

    // Two different rows on the same team — swap their input values.
    const inputA = swapFirstRow.querySelector(cfg.input);
    const inputB = row.querySelector(cfg.input);
    if (inputA && inputB) {
      const tmp = inputA.value;
      inputA.value = inputB.value;
      inputB.value = tmp;
      // Screens that commit per-input need to hear about the change.
      if (cfg.commitOnSwap) {
        inputA.dispatchEvent(new Event('change', { bubbles: true }));
        inputB.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    // Brief pulse on both rows, then reset selection. Swap mode stays on so
    // the user can perform several swaps in a row.
    const rowA = swapFirstRow;
    rowA.classList.remove('is-swap-selected');
    row.classList.remove('is-swap-selected');
    rowA.classList.add('is-swap-pulse');
    row.classList.add('is-swap-pulse');
    setTimeout(() => {
      rowA.classList.remove('is-swap-pulse');
      row.classList.remove('is-swap-pulse');
    }, 400);
    swapFirstRow = null;
  }

  // Update timer display and buttons according to match state
  function updateTimerControls(match) {
    const display = document.getElementById('timer-display');
    if (display) {
      display.textContent = formatTime(match.elapsedTime);
    }
    // Also update the period text above the timer; trigger swap animation on change
    const periodElem = document.getElementById('period-display');
    if (periodElem) {
      const prev = periodElem.textContent;
      if (prev && prev !== match.currentPeriod) {
        periodElem.classList.remove('swapping');
        void periodElem.offsetWidth;
        periodElem.classList.add('swapping');
      }
      periodElem.textContent = match.currentPeriod;
    }
    // Toggle running pulse on the timer
    const display2 = document.getElementById('timer-display');
    if (display2) {
      display2.classList.toggle('is-running', !match.isPaused && isPlayingPeriod(match.currentPeriod));
    }
    // In this version we no longer expose a separate "start" button; the match is started
    // via a long press on the start/end half button.  We keep references to the pause and resume
    // buttons for toggling based on play state.  A non‑existent start button will be null.
    const startBtn = document.getElementById('start-timer-btn');
    const pauseBtn = document.getElementById('pause-timer-btn');
    const resumeBtn = document.getElementById('resume-timer-btn');
    const endPeriodBtn = document.getElementById('end-period-btn');
    const endPeriodLabel = document.getElementById('end-period-label');
    // Determine button visibility based on current period and pause state
    // Always show the long‑press button except when the match is fully over.  Its label and
    // colour are updated below.
    if (match.currentPeriod !== MatchPeriod.MATCH_OVER) {
      endPeriodBtn.style.display = 'block';
    } else {
      endPeriodBtn.style.display = 'none';
    }

    if (match.currentPeriod === MatchPeriod.NOT_STARTED) {
      // Before kickoff: allow user to start the first half (via long press).  Hide pause/resume.
      // No pause/resume controls before kick‑off
      if (startBtn) startBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (resumeBtn) resumeBtn.style.display = 'none';
    } else if (match.currentPeriod === MatchPeriod.MATCH_OVER) {
      // After match ends: no controls are needed.  Guard against null references
      if (startBtn) startBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (resumeBtn) resumeBtn.style.display = 'none';
    } else if (match.currentPeriod === MatchPeriod.HALF_TIME || match.currentPeriod === MatchPeriod.EXTRA_HALF) {
      // During half‑time: hide timer controls; user will long‑press to start next half
      if (startBtn) startBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (resumeBtn) resumeBtn.style.display = 'none';
    } else if (match.currentPeriod === MatchPeriod.FULL_TIME) {
      // At full time, the next action is to start extra time (if configured) or end the match.  The timer
      // should not display pause/resume controls until the extra period begins.  Hide pause and resume
      // buttons so that users cannot resume the timer prematurely.
      if (startBtn) startBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (resumeBtn) resumeBtn.style.display = 'none';
    } else if (match.isPaused) {
      // Paused during play: show resume button.  Long‑press button remains visible and will
      // end the current half when held.
      if (startBtn) startBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (resumeBtn) resumeBtn.style.display = 'block';
    } else {
      // Actively playing: show pause button; hide resume.  Long‑press button remains visible
      // and will end the current half when held.
      if (startBtn) startBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'block';
      if (resumeBtn) resumeBtn.style.display = 'none';
    }
    // Adjust text for endPeriod button based on current period.  During half‑time we
    // show "Start 2nd Half" to more clearly indicate the next action.  During
    // extra‑time half‑time we show "Start Extra 2nd Half".  Otherwise we
    // indicate the period that is ending (e.g. "End 1st Half", "End 2nd Half").
    // Set the label and colour for the long‑press button depending on the match state.  Use the inner
    // span (#end-period-label) instead of the button’s textContent, so that the progress overlay
    // remains intact.  Additionally, toggle colour classes to reflect start (blue) vs end (red) actions.
    // For a simplified and consistent UI the long‑press button always reads
    // "Start Half" when beginning any new half and "End Half" when finishing a half.
    // For extra time, we use "Start Extra" and "End Extra".  When the match
    // has finished normal time and there is no extra time remaining, we show
    // "End Match".  Button colour conveys start (blue) vs end (red) actions.
    let labelText = '';
    let startAction = false;
    if (match.currentPeriod === MatchPeriod.NOT_STARTED) {
      labelText = 'Start Half';
      startAction = true;
    } else if (match.currentPeriod === MatchPeriod.HALF_TIME) {
      // Start the second half
      labelText = 'Start Half';
      startAction = true;
    } else if (match.currentPeriod === MatchPeriod.EXTRA_HALF) {
      // Start the second extra half.  Use the same wording as other halves.
      labelText = 'Start Half';
      startAction = true;
    } else if (match.currentPeriod === MatchPeriod.FULL_TIME) {
      if (match.extraHalfLength && match.extraHalfLength > 0) {
        // After full time, if extra time is configured, we start the first extra half.  Use same label.
        labelText = 'Start Half';
        startAction = true;
      } else {
        // Otherwise the match is over.
        labelText = 'End Match';
        startAction = false;
      }
    } else if (
      match.currentPeriod === MatchPeriod.FIRST_HALF ||
      match.currentPeriod === MatchPeriod.SECOND_HALF ||
      match.currentPeriod === MatchPeriod.EXTRA_FIRST ||
      match.currentPeriod === MatchPeriod.EXTRA_SECOND
    ) {
      // End any playing half (first, second, or extra halves) with the same wording.
      labelText = 'End Half';
      startAction = false;
    } else {
      // Default fallback: hide the label to avoid collapsing the button
      labelText = '';
    }
    if (endPeriodLabel) endPeriodLabel.textContent = labelText;
    // Always use the same colour for the start/end button to tone down the
    // end state.  We remove any red classes and apply the blue classes used
    // for starting periods.  This maintains a consistent look for both
    // starting and ending halves.
    endPeriodBtn.classList.remove('bg-red-600', 'hover:bg-red-700');
    if (labelText) {
      endPeriodBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
    }
    // Update the state of event buttons whenever timer controls are updated
    updateEventButtons(match);
  }

  // Start the match (first half or next period)
  function startMatch() {
    // Retrieve the current match.  Must be done before referencing its properties.
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    // Prevent starting the timer once the match has fully concluded.  If
    // the period is full time and no extra period is configured, or if
    // the match is already over, ignore the request to start.
    if (match.currentPeriod === MatchPeriod.FULL_TIME && (!match.extraHalfLength || match.extraHalfLength === 0)) {
      return;
    }
    if (match.currentPeriod === MatchPeriod.MATCH_OVER) {
      return;
    }
    // Determine next period to start
    let next = match.currentPeriod;
    // Determine which period should begin based on the current period.  Start the first half from
    // NOT_STARTED, the second half from HALF_TIME, the first extra half from FULL_TIME (when
    // extra time is enabled) and the second extra half from EXTRA_HALF.  Otherwise leave as is.
    if (next === MatchPeriod.NOT_STARTED) {
      next = MatchPeriod.FIRST_HALF;
    } else if (next === MatchPeriod.HALF_TIME) {
      next = MatchPeriod.SECOND_HALF;
    } else if (next === MatchPeriod.FULL_TIME) {
      // Kick off extra time only if it is configured.  This guard is handled earlier but
      // duplicated here for clarity.
      if (match.extraHalfLength && match.extraHalfLength > 0) {
        next = MatchPeriod.EXTRA_FIRST;
      }
    } else if (next === MatchPeriod.EXTRA_HALF) {
      next = MatchPeriod.EXTRA_SECOND;
    }
    match.currentPeriod = next;
    match.isPaused = false;
    match.periodStartTimestamp = Date.now() - match.elapsedTime * 1000;
    // Start interval
    startTimerInterval(match);
    updateTimerControls(match);
    saveAppState();
    pushLiveUpdate(match);
  }

  // Pause the match timer
  function pauseMatch() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    match.isPaused = true;
    // update elapsedTime
    match.elapsedTime = Math.floor((Date.now() - match.periodStartTimestamp) / 1000);
    stopTimer();
    updateTimerControls(match);
    saveAppState();
    // Timer state changed but the score did not, so updateScoreboard() never
    // runs here - push directly or the viewer's clock keeps ticking.
    pushLiveUpdate(match);
  }

  // Resume the match timer
  function resumeMatch() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    match.isPaused = false;
    match.periodStartTimestamp = Date.now() - match.elapsedTime * 1000;
    startTimerInterval(match);
    updateTimerControls(match);
    saveAppState();
    pushLiveUpdate(match);
  }

  // End current period and move to next (Half Time / Full Time / Extra time / Match Over)
  function endPeriod() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    // finalize elapsedTime for this period
    if (!match.isPaused) {
      match.elapsedTime = Math.floor((Date.now() - match.periodStartTimestamp) / 1000);
    }
    stopTimer();

    // Set match to paused and update period
    match.isPaused = true;
    match.currentPeriod = getNextPeriod(match.currentPeriod, match);

    // Create period end event when transitioning TO Half Time, Full Time, Extra Half Time, or Match Over
    if (
      match.currentPeriod === MatchPeriod.HALF_TIME ||
      match.currentPeriod === MatchPeriod.FULL_TIME ||
      match.currentPeriod === MatchPeriod.EXTRA_HALF ||
      match.currentPeriod === MatchPeriod.MATCH_OVER
    ) {
      const periodEndEvent = {
        id: Date.now(),
        type: EventType.PERIOD_END,
        period: match.currentPeriod, // The period we're entering (Half Time, Full Time, etc.)
        timeElapsed: match.elapsedTime // Time from the period that just ended
      };
      match.events.push(periodEndEvent);
    }

    // Reset timer for next period (elapsed resets to 0) except if match over
    if (match.currentPeriod !== MatchPeriod.MATCH_OVER) {
      match.elapsedTime = 0;
    }
    // If the next period is a playing period (2nd half or extra 2nd half) then automatically unpause and start timer
    if (
      match.currentPeriod === MatchPeriod.SECOND_HALF ||
      match.currentPeriod === MatchPeriod.EXTRA_SECOND
    ) {
      // Start the timer for the new period immediately
      match.isPaused = false;
      match.periodStartTimestamp = Date.now();
      startTimerInterval(match);
    }
    updateTimerControls(match);
    updateScoreboard(match);
    renderEventsList(match);
    renderLastEvent(match);
    saveAppState();
  }

  // Start timer interval to update every second
  function startTimerInterval(match) {
    stopTimer();
    appState.timerInterval = setInterval(() => {
      const now = Date.now();
      match.elapsedTime = Math.floor((now - match.periodStartTimestamp) / 1000);
      const display = document.getElementById('timer-display');
      display.textContent = formatTime(match.elapsedTime);
    }, 1000);
  }

  // Stop timer interval
  function stopTimer() {
    if (appState.timerInterval) {
      clearInterval(appState.timerInterval);
      appState.timerInterval = null;
    }
  }

  // Time/Period Editor Functions

  // Store current editor state
  const timeEditorState = {
    tempTime: 0,
    originalPeriod: null,
    editorInterval: null,
    timeOffset: 0  // Offset from live match time (in seconds)
  };

  // Start syncing time from live match
  function startEditorTimeSync() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;

    // Clear any existing interval
    if (timeEditorState.editorInterval) {
      clearInterval(timeEditorState.editorInterval);
    }

    // Update display immediately
    timeEditorState.tempTime = match.elapsedTime + timeEditorState.timeOffset;
    updateTimeEditorDisplay();

    // Start interval to sync from live match
    timeEditorState.editorInterval = setInterval(() => {
      const match = findMatchById(appState.currentMatchId);
      if (!match) return;

      // Always sync, but apply the offset
      timeEditorState.tempTime = match.elapsedTime + timeEditorState.timeOffset;
      updateTimeEditorDisplay();
    }, 1000);
  }

  // Stop syncing time
  function stopEditorTimeSync() {
    if (timeEditorState.editorInterval) {
      clearInterval(timeEditorState.editorInterval);
      timeEditorState.editorInterval = null;
    }
  }

  // Open time/period editor
  function openTimePeriodEditor() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;

    // Reset editor state
    timeEditorState.tempTime = match.elapsedTime;
    timeEditorState.originalPeriod = match.currentPeriod;
    timeEditorState.timeOffset = 0;  // No offset initially

    // Populate period selector
    const periodSelector = document.getElementById('period-selector');
    periodSelector.value = match.currentPeriod;

    // Start real-time sync
    startEditorTimeSync();

    showView('time-period-editor-view');
  }

  // Update time editor display
  function updateTimeEditorDisplay() {
    const display = document.getElementById('time-editor-display');
    display.textContent = formatTime(timeEditorState.tempTime);
  }

  // Adjust time by seconds
  function adjustTime(seconds) {
    // Adjust the offset - this will be applied to live time continuously
    timeEditorState.timeOffset += seconds;

    // Ensure result doesn't go negative
    const match = findMatchById(appState.currentMatchId);
    if (match) {
      const newTime = match.elapsedTime + timeEditorState.timeOffset;
      if (newTime < 0) {
        timeEditorState.timeOffset = -match.elapsedTime;
      }
    }

    // Update display immediately
    if (match) {
      timeEditorState.tempTime = match.elapsedTime + timeEditorState.timeOffset;
      updateTimeEditorDisplay();
    }
  }

  // Save time and period changes
  function saveTimePeriodChanges() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;

    // Stop editor sync
    stopEditorTimeSync();

    const periodSelector = document.getElementById('period-selector');
    const newPeriod = periodSelector.value;
    const wasRunning = !match.isPaused;

    // Update match time and period
    match.elapsedTime = timeEditorState.tempTime;
    match.currentPeriod = newPeriod;

    // Recalculate periodStartTimestamp if timer was running
    if (wasRunning) {
      match.periodStartTimestamp = Date.now() - (match.elapsedTime * 1000);
    }

    // Update display and save
    updateTimerControls(match);
    updateScoreboard(match);
    saveAppState();

    // Return to match details
    showView('match-details-view');
  }

  // Cancel time/period editing
  function cancelTimePeriodEditor() {
    const match = findMatchById(appState.currentMatchId);

    // Stop editor sync
    stopEditorTimeSync();

    // Restore original period if it was changed
    if (match && timeEditorState.originalPeriod) {
      const periodSelector = document.getElementById('period-selector');
      if (periodSelector.value !== timeEditorState.originalPeriod) {
        match.currentPeriod = timeEditorState.originalPeriod;
        updateTimerControls(match);
        saveAppState();
      }
    }

    // Don't touch elapsedTime - timer ran naturally in the background
    showView('match-details-view');
  }

  // Helper to create a section header
  function createSectionHeader(title) {
    const header = document.createElement('div');
    header.className = 'text-sm font-medium text-gray-300 mb-2 mt-4 first:mt-0';
    header.textContent = title;
    return header;
  }

  // Render dynamic fields for the selected event type
  function renderEventFields(eventType) {
    const container = document.getElementById('event-fields');
    container.innerHTML = '';
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    // Helper to create select of players
    function createTeamSelect(id) {
      const sel = document.createElement('select');
      sel.id = id;
      sel.name = id;
      // Apply dark‑mode styling classes to selects
      sel.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      const opt1 = document.createElement('option');
      opt1.value = match.team1.id;
      opt1.textContent = match.team1.name;
      const opt2 = document.createElement('option');
      opt2.value = match.team2.id;
      opt2.textContent = match.team2.name;
      sel.appendChild(opt1);
      sel.appendChild(opt2);
      return sel;
    }
    function createPlayerSelect(id, teamId) {
      const sel = document.createElement('select');
      sel.id = id;
      sel.name = id;
      // Apply dark‑mode styling classes to selects
      sel.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      // Include a blank option so that no player is selected by default
      const blankOpt = document.createElement('option');
      blankOpt.value = '';
      blankOpt.textContent = '--';
      sel.appendChild(blankOpt);
      const team = teamId === match.team1.id ? match.team1 : match.team2;
      team.players.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.jerseyNumber}. ${p.name}`;
        sel.appendChild(opt);
      });
      return sel;
    }
    if (eventType === EventType.SHOT) {
      // Team & Player section
      container.appendChild(createSectionHeader('Team & Player'));
      
      // Team select
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('event-team');
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      // Player select (populated on team select change)
      const rowPlayer = document.createElement('div');
      rowPlayer.className = 'form-row';
      const labelPlayer = document.createElement('label');
      labelPlayer.textContent = 'Player';
      const playerSelect = createPlayerSelect('event-player', teamSelect.value);
      rowPlayer.appendChild(labelPlayer);
      rowPlayer.appendChild(playerSelect);
      container.appendChild(rowPlayer);
      teamSelect.addEventListener('change', () => {
        const newPlayerSelect = createPlayerSelect('event-player', teamSelect.value);
        rowPlayer.replaceChild(newPlayerSelect, playerSelect);
      });
      
      // Shot Details section
      container.appendChild(createSectionHeader('Shot Details'));
      
      // Shot type select
      const rowType = document.createElement('div');
      rowType.className = 'form-row';
      const labelType = document.createElement('label');
      labelType.textContent = 'Shot Type';
      const typeSelect = document.createElement('select');
      typeSelect.id = 'shot-type';
      typeSelect.name = 'shot-type';
      // Apply dark mode styling
      typeSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      Object.values(ShotType).forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val
          .replace(/([A-Z])/g, ' $1')
          .replace(/\b(\w)/g, (l) => l.toUpperCase());
        typeSelect.appendChild(opt);
      });
      rowType.appendChild(labelType);
      rowType.appendChild(typeSelect);
      container.appendChild(rowType);
      // Shot outcome select
      const rowOutcome = document.createElement('div');
      rowOutcome.className = 'form-row';
      const labelOutcome = document.createElement('label');
      labelOutcome.textContent = 'Shot Outcome';
      const outcomeSelect = document.createElement('select');
      outcomeSelect.id = 'shot-outcome';
      outcomeSelect.name = 'shot-outcome';
      // Dark mode styling
      outcomeSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      Object.values(ShotOutcome).forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val
          .replace(/([A-Z])/g, ' $1')
          .replace(/\b(\w)/g, (l) => l.toUpperCase());
        outcomeSelect.appendChild(opt);
      });
      rowOutcome.appendChild(labelOutcome);
      rowOutcome.appendChild(outcomeSelect);
      container.appendChild(rowOutcome);
    } else if (eventType === EventType.CARD) {
      // Team & Player section
      container.appendChild(createSectionHeader('Team & Player'));
      
      // Team select
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('event-team');
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      // Player select
      const rowPlayer = document.createElement('div');
      rowPlayer.className = 'form-row';
      const labelPlayer = document.createElement('label');
      labelPlayer.textContent = 'Player';
      const playerSelect = createPlayerSelect('event-player', teamSelect.value);
      rowPlayer.appendChild(labelPlayer);
      rowPlayer.appendChild(playerSelect);
      container.appendChild(rowPlayer);
      teamSelect.addEventListener('change', () => {
        const newPlayerSelect = createPlayerSelect('event-player', teamSelect.value);
        rowPlayer.replaceChild(newPlayerSelect, playerSelect);
      });
      
      // Card Details section
      container.appendChild(createSectionHeader('Card Details'));
      
      // Card type
      const rowCard = document.createElement('div');
      rowCard.className = 'form-row';
      const labelCard = document.createElement('label');
      labelCard.textContent = 'Card';
      const cardSelect = document.createElement('select');
      cardSelect.id = 'card-type';
      cardSelect.name = 'card-type';
      // Dark mode styling for card select
      cardSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      Object.values(CardType).forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
        cardSelect.appendChild(opt);
      });
      rowCard.appendChild(labelCard);
      rowCard.appendChild(cardSelect);
      container.appendChild(rowCard);
    } else if (eventType === EventType.FOUL_CONCEDED) {
      // Team & Player section
      container.appendChild(createSectionHeader('Team & Player'));
      
      // Team and player
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('event-team');
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      const rowPlayer = document.createElement('div');
      rowPlayer.className = 'form-row';
      const labelPlayer = document.createElement('label');
      labelPlayer.textContent = 'Player';
      const playerSelect = createPlayerSelect('event-player', teamSelect.value);
      rowPlayer.appendChild(labelPlayer);
      rowPlayer.appendChild(playerSelect);
      container.appendChild(rowPlayer);
      teamSelect.addEventListener('change', () => {
        const newPlayerSelect = createPlayerSelect('event-player', teamSelect.value);
        rowPlayer.replaceChild(newPlayerSelect, playerSelect);
      });
      
      // Foul Details section
      container.appendChild(createSectionHeader('Foul Details'));
      
      // Foul outcome
      const rowOutcome = document.createElement('div');
      rowOutcome.className = 'form-row';
      const labelOutcome = document.createElement('label');
      labelOutcome.textContent = 'Outcome';
      const foulSelect = document.createElement('select');
      foulSelect.id = 'foul-outcome';
      foulSelect.name = 'foul-outcome';
      // Dark mode styling for foul outcome select
      foulSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      Object.values(FoulOutcome).forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
        foulSelect.appendChild(opt);
      });
      rowOutcome.appendChild(labelOutcome);
      rowOutcome.appendChild(foulSelect);
      container.appendChild(rowOutcome);
    } else if (eventType === EventType.KICKOUT) {
      // Team section
      container.appendChild(createSectionHeader('Team'));
      
      // Team select
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('event-team');
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      
      // Kickout Details section
      container.appendChild(createSectionHeader('Kickout Details'));
      
      // Kickout outcome
      const rowOutcome = document.createElement('div');
      rowOutcome.className = 'form-row';
      const labelOutcome = document.createElement('label');
      labelOutcome.textContent = 'Won?';
      const wonSelect = document.createElement('select');
      wonSelect.id = 'kickout-outcome';
      wonSelect.name = 'kickout-outcome';
      // Dark mode styling for kickout select
      wonSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      ['won', 'lost'].forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
        wonSelect.appendChild(opt);
      });
      rowOutcome.appendChild(labelOutcome);
      rowOutcome.appendChild(wonSelect);
      container.appendChild(rowOutcome);
    } else if (eventType === EventType.SUBSTITUTION) {
      // Team section
      container.appendChild(createSectionHeader('Team'));
      
      // Team select
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('event-team');
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      
      // Players section
      container.appendChild(createSectionHeader('Players'));
      
      // Player out
      const rowPlayerOut = document.createElement('div');
      rowPlayerOut.className = 'form-row';
      const labelPlayerOut = document.createElement('label');
      labelPlayerOut.textContent = 'Player Out';
      const playerOutSelect = createPlayerSelect('event-player1', teamSelect.value);
      rowPlayerOut.appendChild(labelPlayerOut);
      rowPlayerOut.appendChild(playerOutSelect);
      container.appendChild(rowPlayerOut);
      // Player in
      const rowPlayerIn = document.createElement('div');
      rowPlayerIn.className = 'form-row';
      const labelPlayerIn = document.createElement('label');
      labelPlayerIn.textContent = 'Player In';
      const playerInSelect = createPlayerSelect('event-player2', teamSelect.value);
      rowPlayerIn.appendChild(labelPlayerIn);
      rowPlayerIn.appendChild(playerInSelect);
      container.appendChild(rowPlayerIn);
      teamSelect.addEventListener('change', () => {
        const newOut = createPlayerSelect('event-player1', teamSelect.value);
        const newIn = createPlayerSelect('event-player2', teamSelect.value);
        rowPlayerOut.replaceChild(newOut, playerOutSelect);
        rowPlayerIn.replaceChild(newIn, playerInSelect);
      });
    } else if (eventType === EventType.NOTE) {
      // Note section
      container.appendChild(createSectionHeader('Note'));
      
      const rowNote = document.createElement('div');
      rowNote.className = 'form-row';
      const labelNote = document.createElement('label');
      labelNote.textContent = 'Note';
      const noteText = document.createElement('textarea');
      noteText.id = 'event-note';
      noteText.name = 'event-note';
      noteText.rows = 3;
      // Dark mode styling for note textarea
      noteText.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      rowNote.appendChild(labelNote);
      rowNote.appendChild(noteText);
      container.appendChild(rowNote);
    }
  }

  // Add event to current match
  function addEvent() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    // Prevent adding events outside of playing periods
    if (!isPlayingPeriod(match.currentPeriod)) {
      return;
    }
    const eventType = document.getElementById('event-type').value;
    const nowSeconds = match.elapsedTime;
    const period = match.currentPeriod;
    // Build event object
    const event = {
      id: generateId(),
      type: eventType,
      period,
      timeElapsed: nowSeconds,
      teamId: null,
      player1Id: null,
      player2Id: null,
      shotOutcome: null,
      shotType: null,
      foulOutcome: null,
      cardType: null,
      wonKickout: null,
      noteText: null
    };
    if (eventType === EventType.SHOT) {
      const teamId = document.getElementById('event-team').value;
      const playerId = document.getElementById('event-player').value;
      const shotType = document.getElementById('shot-type').value;
      const shotOutcome = document.getElementById('shot-outcome').value;
      event.teamId = teamId;
      event.player1Id = playerId || null;
      event.shotType = shotType;
      event.shotOutcome = shotOutcome;
    } else if (eventType === EventType.CARD) {
      const teamId = document.getElementById('event-team').value;
      const playerId = document.getElementById('event-player').value;
      const cardType = document.getElementById('card-type').value;
      event.teamId = teamId;
      event.player1Id = playerId || null;
      event.cardType = cardType;
    } else if (eventType === EventType.FOUL_CONCEDED) {
      const teamId = document.getElementById('event-team').value;
      const playerId = document.getElementById('event-player').value;
      const foulOutcome = document.getElementById('foul-outcome').value;
      event.teamId = teamId;
      event.player1Id = playerId || null;
      event.foulOutcome = foulOutcome;
    } else if (eventType === EventType.KICKOUT) {
      const teamId = document.getElementById('event-team').value;
      const outcome = document.getElementById('kickout-outcome').value;
      event.teamId = teamId;
      event.wonKickout = outcome === 'won';
    } else if (eventType === EventType.SUBSTITUTION) {
      const teamId = document.getElementById('event-team').value;
      const playerOut = document.getElementById('event-player1').value;
      const playerIn = document.getElementById('event-player2').value;
      event.teamId = teamId;
      event.player1Id = playerOut;
      event.player2Id = playerIn;
      // Optionally update players list: replace out with in number name
      // but here we won't modify players list; just record substitution event.
    } else if (eventType === EventType.NOTE) {
      const noteText = document.getElementById('event-note').value.trim();
      if (!noteText) {
        alert('Please enter a note.');
        return;
      }
      event.noteText = noteText;
    }
    match.events.push(event);
    // Update scoreboard immediately
    updateScoreboard(match);
    // Re-render events list and last event summary
    renderEventsList(match);
    renderLastEvent(match);
    // Persist changes
    saveAppState();
    // Reset event form fields for the selected type
    renderEventFields(eventType);
  }

  // Render events list for current match
  function renderEventsList(match) {
    const list = document.getElementById('events-list');
    list.innerHTML = '';
    // Build a running score map keyed by event ID so that we can display the
    // scoreboard at the time each event occurred.  Iterate through events in
    // chronological order (original order) and accumulate goals and points for
    // each team.  A goal counts as three points but the scoreboard is
    // displayed as goals–points.  Two‑pointers add two points to the point
    // tally.  This map lets us look up the cumulative score for any event.
    const scoreByEventId = {};
    let t1Goals = 0;
    let t1Points = 0;
    let t2Goals = 0;
    let t2Points = 0;
    match.events.forEach((ev) => {
      if (ev.type === EventType.SHOT) {
        if (ev.teamId === match.team1.id) {
          if (ev.shotOutcome === ShotOutcome.GOAL) {
            t1Goals += 1;
          } else if (ev.shotOutcome === ShotOutcome.POINT) {
            t1Points += 1;
          } else if (ev.shotOutcome === ShotOutcome.TWO_POINTER) {
            // Treat two pointer as two points in the points tally
            t1Points += 2;
          }
        } else if (ev.teamId === match.team2.id) {
          if (ev.shotOutcome === ShotOutcome.GOAL) {
            t2Goals += 1;
          } else if (ev.shotOutcome === ShotOutcome.POINT) {
            t2Points += 1;
          } else if (ev.shotOutcome === ShotOutcome.TWO_POINTER) {
            t2Points += 2;
          }
        }
      }
      scoreByEventId[ev.id] = {
        t1Goals,
        t1Points,
        t2Goals,
        t2Points
      };
    });
    // Display most recent events first using proper chronological sorting
    // (by period and time), then reversed so newest appears at top
    const sorted = sortEventsByTime(match.events, true);
    if (sorted.length === 0) {
      const msg = document.createElement('li');
      msg.className = 'empty-message text-center text-gray-400 py-4';
      msg.textContent = 'No events yet.';
      list.appendChild(msg);
      return;
    }
    sorted.forEach((ev, idx) => {
      const item = document.createElement('li');
      // Use a card-like appearance with border and subtle hover effect
      item.className = 'event-item px-4 py-3 mb-2 cursor-pointer bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg min-h-20 relative';
      item.style.setProperty('--i', idx);
      // Tag the row with an event-type-* class so the accent bar picks up
      // the appropriate color (defined in styles.css). Cards use the colour
      // matching the card type. Fouls that include a card adopt the card
      // colour as well, so the most-impactful info wins.
      let typeClass = '';
      if (ev.type === EventType.SHOT) {
        if (ev.shotOutcome === ShotOutcome.GOAL) typeClass = 'event-type-goal';
        else if (ev.shotOutcome === ShotOutcome.POINT) typeClass = 'event-type-point';
        else if (ev.shotOutcome === ShotOutcome.TWO_POINTER) typeClass = 'event-type-twopt';
      } else if (ev.type === EventType.CARD || (ev.type === EventType.FOUL_CONCEDED && ev.cardType)) {
        if (ev.cardType === 'red') typeClass = 'event-type-card-red';
        else if (ev.cardType === 'black') typeClass = 'event-type-card-black';
        else typeClass = 'event-type-card-yellow';
      }
      else if (ev.type === EventType.FOUL_CONCEDED) typeClass = 'event-type-foul';
      else if (ev.type === EventType.KICKOUT) typeClass = 'event-type-kickout';
      else if (ev.type === EventType.SUBSTITUTION) typeClass = 'event-type-sub';
      else if (ev.type === EventType.NOTE) typeClass = 'event-type-note';
      else if (ev.type === EventType.PERIOD_END) typeClass = 'event-type-period';
      if (typeClass) item.classList.add(typeClass);

      // Tag the row with the owning team so the accent bar can sit on the
      // correct side (left for team 1, right for team 2). Period-end events
      // have no team and stay on the left as a neutral marker.
      if (ev.teamId === match.team1.id) item.classList.add('event-team-1');
      else if (ev.teamId === match.team2.id) item.classList.add('event-team-2');


      // Event details (left side content)
      const details = document.createElement('div');
      details.className = 'event-details pr-20';
      // Format minutes as whole number (no seconds)
      const minutes = Math.floor(ev.timeElapsed / 60);
      const timeStr = `${minutes} min`;
      // Determine team object if present
      const team = ev.teamId ? (ev.teamId === match.team1.id ? match.team1 : match.team2) : null;
      // Helper: get player display for lines below
      const getPlayer = (playerId) => {
        if (!playerId) return null;
        const player = match.team1.players.find((p) => p.id === playerId) || match.team2.players.find((p) => p.id === playerId);
        return player || null;
      };
      // Top line: team name
      const teamLine = document.createElement('div');
      teamLine.className = 'font-semibold text-gray-200';
      teamLine.textContent = team ? team.name : '';
      details.appendChild(teamLine);
      // Second line: event type/outcome or description
      const typeLine = document.createElement('div');
      typeLine.className = 'text-gray-300 text-sm';
      // We'll compute additional lines (scoreboard, player, shot type) below
      // Determine a human friendly type/outcome text based on event
      let outcomeText = '';
      if (ev.type === EventType.SHOT) {
        // Convert outcome like "goal", "point", "wide" to capitalized words
        outcomeText = ev.shotOutcome
          .replace(/([A-Z])/g, ' $1')
          .replace(/\b\w/g, (l) => l.toUpperCase());
        // Create styled capsule for scoring outcomes
        const styledOutcome = createStyledOutcome(outcomeText, ev.shotOutcome);
        if (typeof styledOutcome === 'string') {
          typeLine.textContent = styledOutcome;
        } else {
          typeLine.appendChild(styledOutcome);
        }
      } else if (ev.type === EventType.CARD) {
        outcomeText = `${ev.cardType ? ev.cardType.charAt(0).toUpperCase() + ev.cardType.slice(1) : ''} Card`;
        typeLine.textContent = outcomeText;
      } else if (ev.type === EventType.FOUL_CONCEDED) {
        let foulText = `Foul${ev.foulOutcome ? ' (' + ev.foulOutcome.charAt(0).toUpperCase() + ev.foulOutcome.slice(1) + ')' : ''}`;
        if (ev.cardType) {
          foulText += ` + ${ev.cardType.charAt(0).toUpperCase() + ev.cardType.slice(1)} Card`;
        }
        outcomeText = foulText;
        typeLine.textContent = outcomeText;
      } else if (ev.type === EventType.KICKOUT) {
        outcomeText = `Kick‑out ${ev.wonKickout ? 'Won' : 'Lost'}`;
        typeLine.textContent = outcomeText;
      } else if (ev.type === EventType.SUBSTITUTION) {
        outcomeText = 'Substitution';
        typeLine.textContent = outcomeText;
      } else if (ev.type === EventType.NOTE) {
        outcomeText = 'Note';
        typeLine.textContent = outcomeText;
      } else if (ev.type === EventType.PERIOD_END) {
        // Period end events show the period name (e.g., "Half Time")
        outcomeText = ev.period;
        typeLine.textContent = outcomeText;
      }
      details.appendChild(typeLine);

      // For period end events, add time elapsed line before scoreboard
      if (ev.type === EventType.PERIOD_END) {
        const minutes = Math.floor(ev.timeElapsed / 60);
        const timeLine = document.createElement('div');
        timeLine.className = 'text-gray-300 text-sm';
        timeLine.textContent = `${minutes} min`;
        details.appendChild(timeLine);
      }

      // Scoreboard lines: for scoring shots and period end events
      const scoreboard = scoreByEventId[ev.id];
      if (
        (ev.type === EventType.SHOT &&
        (ev.shotOutcome === ShotOutcome.GOAL || ev.shotOutcome === ShotOutcome.POINT || ev.shotOutcome === ShotOutcome.TWO_POINTER)) ||
        ev.type === EventType.PERIOD_END
      ) {
        const sLine1 = document.createElement('div');
        sLine1.className = 'text-blue-400 text-sm';
        sLine1.textContent = `${match.team1.name}: ${scoreboard.t1Goals}-${scoreboard.t1Points}`;
        const sLine2 = document.createElement('div');
        sLine2.className = 'text-blue-400 text-sm';
        sLine2.textContent = `${match.team2.name}: ${scoreboard.t2Goals}-${scoreboard.t2Points}`;
        details.appendChild(sLine1);
        details.appendChild(sLine2);
      }
      // For shot events, add player and shot type lines
      if (ev.type === EventType.SHOT) {
        // Player line
        const player = getPlayer(ev.player1Id);
        if (player) {
          const defaultName = `No.${player.jerseyNumber}`;
          const playerLine = document.createElement('div');
          playerLine.className = 'text-gray-300 text-sm';
          // Always show jersey number; include name only if not the default
          let line = `#${player.jerseyNumber}`;
          if (player.name && player.name !== defaultName) {
            line += ` ${player.name}`;
          }
          playerLine.textContent = line;
          details.appendChild(playerLine);
        }
        // Shot type line
        if (ev.shotType) {
          const shotLine = document.createElement('div');
          shotLine.className = 'text-gray-400 text-sm';
          // Map shotType keys to human friendly labels.  Include slash for 45/65m.
          const shotTypeMap = {
            fromPlay: 'From Play',
            free: 'Free',
            penalty: 'Penalty',
            '45m65m': '45m/65m',
            sideline: 'Sideline',
            mark: 'Mark'
          };
          shotLine.textContent = shotTypeMap[ev.shotType] || ev.shotType
            .replace(/([A-Z])/g, ' $1')
            .replace(/\b\w/g, (l) => l.toUpperCase());
          details.appendChild(shotLine);
        }
      }
      // For substitution events, show player in/out lines
      if (ev.type === EventType.SUBSTITUTION) {
        const playerOut = getPlayer(ev.player1Id);
        const playerIn = getPlayer(ev.player2Id);
        const subLine = document.createElement('div');
        subLine.className = 'text-gray-300 text-sm';
        const outStr = playerOut
          ? `#${playerOut.jerseyNumber}${playerOut.name && playerOut.name !== `No.${playerOut.jerseyNumber}` ? ' ' + playerOut.name : ''}`
          : '';
        const inStr = playerIn
          ? `#${playerIn.jerseyNumber}${playerIn.name && playerIn.name !== `No.${playerIn.jerseyNumber}` ? ' ' + playerIn.name : ''}`
          : '';
        subLine.textContent = `${outStr} ⟶ ${inStr}`;
        details.appendChild(subLine);
      }
      // For card and foul events, show player line
      if (ev.type === EventType.CARD || ev.type === EventType.FOUL_CONCEDED) {
        const player = getPlayer(ev.player1Id);
        if (player) {
          const cardPlayerLine = document.createElement('div');
          cardPlayerLine.className = 'text-gray-300 text-sm';
          const defaultName = `No.${player.jerseyNumber}`;
          let line = `#${player.jerseyNumber}`;
          if (player.name && player.name !== defaultName) {
            line += ` ${player.name}`;
          }
          cardPlayerLine.textContent = line;
          details.appendChild(cardPlayerLine);
        }
      }
      // For any event with notes, show note text on separate line
      if (ev.noteText && ev.noteText.trim()) {
        const noteLine = document.createElement('div');
        noteLine.className = 'text-gray-300 text-sm';
        noteLine.textContent = ev.noteText;
        details.appendChild(noteLine);
      }
      // Append details to item
      item.appendChild(details);
      
      // Timestamp in top-right corner of the event box
      const timeDiv = document.createElement('div');
      timeDiv.className = 'absolute top-2 right-2 text-gray-200 text-xs font-medium text-right';
      timeDiv.innerHTML = `${timeStr}<br><span class="text-gray-400">${ev.period}</span>`;
      item.appendChild(timeDiv);

      // Share button: positioned to the left of delete button
      const shareBtn = document.createElement('button');
      shareBtn.title = 'Share event';
      shareBtn.className = 'text-gray-200 hover:text-gray-100';
      shareBtn.style.position = 'absolute';
      shareBtn.style.bottom = '8px';
      shareBtn.style.right = '40px'; // Position to left of delete button
      shareBtn.innerHTML = '<img src="icons/share.svg" alt="Share Event" class="w-6 h-6" />';
      shareBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        shareIndividualEvent(ev.id);
      });
      item.appendChild(shareBtn);

      // Delete button: render a trash icon instead of an "X" and position it at the
      // bottom right of the event card.  Using absolute positioning allows the
      // icon to float to the card's corner independent of the right column.
      const delBtn = document.createElement('button');
      delBtn.title = 'Delete event';
      // Tailwind classes: absolute positioning, bottom/right offsets and red colour
      // Style the dustbin button with a white outline instead of a solid fill.  The
      // text classes control the stroke colour; the icon uses stroke instead of
      // fill to create a transparent centre.  It also inherits hover colour from
      // the parent button.
      // Apply a lighter colour so the dustbin outline appears closer to white.  The hover
      // colour slightly darkens the stroke to indicate interactivity.
      delBtn.className = 'event-actions absolute bottom-2 right-2 text-gray-200 hover:text-gray-100';
      delBtn.innerHTML =
        '<img src="icons/delete.svg" alt="Delete Event" class="w-6 h-6" />';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this event?')) {
          match.events = match.events.filter((m) => m.id !== ev.id);
          updateScoreboard(match);
          renderEventsList(match);
          renderLastEvent(match);
          saveAppState();
        }
      });
      // Add delete button to bottom-right corner
      item.appendChild(delBtn);
      
      list.appendChild(item);
      
      // Attach click handler to edit event when clicking on item (excluding delete button)
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        showEditEventForm(ev.id);
      });
    });
  }

  /* Edit Event Modal Functions */
  // Show modal to edit an existing event
  function showEditEventForm(eventId) {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    const ev = match.events.find((e) => e.id === eventId);
    if (!ev) return;
    
    // Determine which team key this event belongs to
    const teamKey = ev.teamId === match.team1.id ? 'team1' : 'team2';
    
    // Route to appropriate modal based on event type
    if (ev.type === EventType.SHOT) {
      showScoreModal(teamKey, ev.shotOutcome, {
        shotType: ev.shotType,
        playerId: ev.player1Id != null ? ev.player1Id : null,
        isEdit: true,
        eventId: ev.id
      });
    } else if (ev.type === EventType.FOUL_CONCEDED) {
      showFoulModal(teamKey, {
        foulType: ev.foulOutcome,
        cardType: ev.cardType || 'none',
        playerId: ev.player1Id,
        isEdit: true,
        eventId: ev.id
      });
    } else if (ev.type === EventType.KICKOUT) {
      showKickoutModal(teamKey, {
        outcome: ev.wonKickout ? 'won' : 'lost',
        playerId: ev.player1Id,
        isEdit: true,
        eventId: ev.id
      });
    } else if (ev.type === EventType.SUBSTITUTION) {
      showSubstitutionModal(teamKey, {
        playerOffId: ev.player1Id,
        playerOnId: ev.player2Id,
        isEdit: true,
        eventId: ev.id
      });
    } else if (ev.type === EventType.NOTE) {
      showNoteModal(teamKey, {
        noteText: ev.noteText,
        isEdit: true,
        eventId: ev.id
      });
    } else if (ev.type === EventType.CARD) {
      // For standalone card events, still use the old modal since we don't have a dedicated card modal
      appState.editingEventId = eventId;
      const fieldsContainer = document.getElementById('edit-event-fields');
      fieldsContainer.innerHTML = '';
      renderEditEventFields(ev);
      const modal = document.getElementById('edit-event-modal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }

  // Render input fields for editing event based on its type
  function renderEditEventFields(event) {
    const container = document.getElementById('edit-event-fields');
    container.innerHTML = '';
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    const eventType = event.type;
    // Note: we don't allow changing event type; show as read-only label
    const rowType = document.createElement('div');
    rowType.className = 'form-row flex flex-col';
    const labelType = document.createElement('label');
    labelType.textContent = 'Event Type';
    const typeDisplay = document.createElement('div');
    typeDisplay.textContent = eventType;
    // Dark mode styling for read‑only event type display
    typeDisplay.className = 'p-2 bg-gray-700 text-gray-100 border border-gray-600 rounded';
    rowType.appendChild(labelType);
    rowType.appendChild(typeDisplay);
    container.appendChild(rowType);
    // Helper functions to create selects for team and players
    function createTeamSelect(id, selected) {
      const sel = document.createElement('select');
      sel.id = id;
      sel.name = id;
      // Dark mode styling
      sel.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      const opt1 = document.createElement('option');
      opt1.value = match.team1.id;
      opt1.textContent = match.team1.name;
      if (selected === match.team1.id) opt1.selected = true;
      const opt2 = document.createElement('option');
      opt2.value = match.team2.id;
      opt2.textContent = match.team2.name;
      if (selected === match.team2.id) opt2.selected = true;
      sel.appendChild(opt1);
      sel.appendChild(opt2);
      return sel;
    }
    function createPlayerSelect(id, teamId, selected) {
      const sel = document.createElement('select');
      sel.id = id;
      sel.name = id;
      // Dark mode styling
      sel.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      // Include a blank option at the top so the user can choose no player
      const blankOpt = document.createElement('option');
      blankOpt.value = '';
      blankOpt.textContent = '--';
      // If no player is selected, keep the blank option selected
      if (!selected) blankOpt.selected = true;
      sel.appendChild(blankOpt);
      const team = teamId === match.team1.id ? match.team1 : match.team2;
      team.players.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.jerseyNumber}. ${p.name}`;
        if (selected === p.id) opt.selected = true;
        sel.appendChild(opt);
      });
      return sel;
    }
    // For shot events
    if (eventType === EventType.SHOT) {
      // Team
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row flex flex-col';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('edit-event-team', event.teamId);
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      // Player
      const rowPlayer = document.createElement('div');
      rowPlayer.className = 'form-row flex flex-col';
      const labelPlayer = document.createElement('label');
      labelPlayer.textContent = 'Player';
      let playerSelect = createPlayerSelect('edit-event-player', event.teamId, event.player1Id);
      rowPlayer.appendChild(labelPlayer);
      rowPlayer.appendChild(playerSelect);
      container.appendChild(rowPlayer);
      // update players when team changes
      teamSelect.addEventListener('change', () => {
        const newSel = createPlayerSelect('edit-event-player', teamSelect.value, null);
        rowPlayer.replaceChild(newSel, playerSelect);
        playerSelect = newSel;
      });
      // Shot type
      const rowTypeSelect = document.createElement('div');
      rowTypeSelect.className = 'form-row flex flex-col';
      const labelShotType = document.createElement('label');
      labelShotType.textContent = 'Shot Type';
      const typeSelect = document.createElement('select');
      typeSelect.id = 'edit-shot-type';
      typeSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      Object.values(ShotType).forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val.replace(/([A-Z])/g, ' $1').replace(/\b\w/g, (l) => l.toUpperCase());
        if (event.shotType === val) opt.selected = true;
        typeSelect.appendChild(opt);
      });
      rowTypeSelect.appendChild(labelShotType);
      rowTypeSelect.appendChild(typeSelect);
      container.appendChild(rowTypeSelect);
      // Shot outcome
      const rowOutcome = document.createElement('div');
      rowOutcome.className = 'form-row flex flex-col';
      const labelOutcome = document.createElement('label');
      labelOutcome.textContent = 'Shot Outcome';
      const outcomeSelect = document.createElement('select');
      outcomeSelect.id = 'edit-shot-outcome';
      outcomeSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      Object.values(ShotOutcome).forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val.replace(/([A-Z])/g, ' $1').replace(/\b\w/g, (l) => l.toUpperCase());
        if (event.shotOutcome === val) opt.selected = true;
        outcomeSelect.appendChild(opt);
      });
      rowOutcome.appendChild(labelOutcome);
      rowOutcome.appendChild(outcomeSelect);
      container.appendChild(rowOutcome);
    } else if (eventType === EventType.CARD) {
      // Team
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row flex flex-col';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('edit-event-team', event.teamId);
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      // Player
      const rowPlayer = document.createElement('div');
      rowPlayer.className = 'form-row flex flex-col';
      const labelPlayer = document.createElement('label');
      labelPlayer.textContent = 'Player';
      let playerSelect = createPlayerSelect('edit-event-player', event.teamId, event.player1Id);
      rowPlayer.appendChild(labelPlayer);
      rowPlayer.appendChild(playerSelect);
      container.appendChild(rowPlayer);
      teamSelect.addEventListener('change', () => {
        const newSel = createPlayerSelect('edit-event-player', teamSelect.value, null);
        rowPlayer.replaceChild(newSel, playerSelect);
        playerSelect = newSel;
      });
      // Card type
      const rowCard = document.createElement('div');
      rowCard.className = 'form-row flex flex-col';
      const labelCard = document.createElement('label');
      labelCard.textContent = 'Card';
      const cardSelect = document.createElement('select');
      cardSelect.id = 'edit-card-type';
      cardSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      Object.values(CardType).forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
        if (event.cardType === val) opt.selected = true;
        cardSelect.appendChild(opt);
      });
      rowCard.appendChild(labelCard);
      rowCard.appendChild(cardSelect);
      container.appendChild(rowCard);
    } else if (eventType === EventType.FOUL_CONCEDED) {
      // Team
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row flex flex-col';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('edit-event-team', event.teamId);
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      // Player
      const rowPlayer = document.createElement('div');
      rowPlayer.className = 'form-row flex flex-col';
      const labelPlayer = document.createElement('label');
      labelPlayer.textContent = 'Player';
      let playerSelect = createPlayerSelect('edit-event-player', event.teamId, event.player1Id);
      rowPlayer.appendChild(labelPlayer);
      rowPlayer.appendChild(playerSelect);
      container.appendChild(rowPlayer);
      teamSelect.addEventListener('change', () => {
        const newSel = createPlayerSelect('edit-event-player', teamSelect.value, null);
        rowPlayer.replaceChild(newSel, playerSelect);
        playerSelect = newSel;
      });
      // Outcome
      const rowOutcome = document.createElement('div');
      rowOutcome.className = 'form-row flex flex-col';
      const labelOutcome = document.createElement('label');
      labelOutcome.textContent = 'Outcome';
      const outcomeSelect = document.createElement('select');
      outcomeSelect.id = 'edit-foul-outcome';
      outcomeSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      Object.values(FoulOutcome).forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
        if (event.foulOutcome === val) opt.selected = true;
        outcomeSelect.appendChild(opt);
      });
      rowOutcome.appendChild(labelOutcome);
      rowOutcome.appendChild(outcomeSelect);
      container.appendChild(rowOutcome);
    } else if (eventType === EventType.KICKOUT) {
      // Team
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row flex flex-col';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('edit-event-team', event.teamId);
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      // Won
      const rowWon = document.createElement('div');
      rowWon.className = 'form-row flex flex-col';
      const labelWon = document.createElement('label');
      labelWon.textContent = 'Won?';
      const wonSelect = document.createElement('select');
      wonSelect.id = 'edit-kickout-won';
      wonSelect.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      ['won', 'lost'].forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
        if ((event.wonKickout ? 'won' : 'lost') === val) opt.selected = true;
        wonSelect.appendChild(opt);
      });
      rowWon.appendChild(labelWon);
      rowWon.appendChild(wonSelect);
      container.appendChild(rowWon);
    } else if (eventType === EventType.SUBSTITUTION) {
      // Team
      const rowTeam = document.createElement('div');
      rowTeam.className = 'form-row flex flex-col';
      const labelTeam = document.createElement('label');
      labelTeam.textContent = 'Team';
      const teamSelect = createTeamSelect('edit-event-team', event.teamId);
      rowTeam.appendChild(labelTeam);
      rowTeam.appendChild(teamSelect);
      container.appendChild(rowTeam);
      // Player out
      const rowOut = document.createElement('div');
      rowOut.className = 'form-row flex flex-col';
      const labelOut = document.createElement('label');
      labelOut.textContent = 'Player Out';
      let playerOutSel = createPlayerSelect('edit-player-out', event.teamId, event.player1Id);
      rowOut.appendChild(labelOut);
      rowOut.appendChild(playerOutSel);
      container.appendChild(rowOut);
      // Player in
      const rowIn = document.createElement('div');
      rowIn.className = 'form-row flex flex-col';
      const labelIn = document.createElement('label');
      labelIn.textContent = 'Player In';
      let playerInSel = createPlayerSelect('edit-player-in', event.teamId, event.player2Id);
      rowIn.appendChild(labelIn);
      rowIn.appendChild(playerInSel);
      container.appendChild(rowIn);
      teamSelect.addEventListener('change', () => {
        const newOut = createPlayerSelect('edit-player-out', teamSelect.value, null);
        rowOut.replaceChild(newOut, playerOutSel);
        playerOutSel = newOut;
        const newIn = createPlayerSelect('edit-player-in', teamSelect.value, null);
        rowIn.replaceChild(newIn, playerInSel);
        playerInSel = newIn;
      });
    } else if (eventType === EventType.NOTE) {
      const rowNote = document.createElement('div');
      rowNote.className = 'form-row flex flex-col';
      const labelNote = document.createElement('label');
      labelNote.textContent = 'Note';
      const noteTextarea = document.createElement('textarea');
      noteTextarea.id = 'edit-note-text';
      noteTextarea.className = 'p-2 border rounded bg-gray-700 text-gray-100 border-gray-600 w-full';
      noteTextarea.rows = 3;
      noteTextarea.value = event.noteText || '';
      rowNote.appendChild(labelNote);
      rowNote.appendChild(noteTextarea);
      container.appendChild(rowNote);
    }
  }

  // Save edited event
  function saveEditedEvent() {
    const match = findMatchById(appState.currentMatchId);
    if (!match) return;
    const eventId = appState.editingEventId;
    const ev = match.events.find((e) => e.id === eventId);
    if (!ev) return;
    // Read values from edit fields depending on type
    const eventType = ev.type;
    if (eventType === EventType.SHOT) {
      const teamId = document.getElementById('edit-event-team').value;
      const playerId = document.getElementById('edit-event-player').value;
      const shotType = document.getElementById('edit-shot-type').value;
      const shotOutcome = document.getElementById('edit-shot-outcome').value;
      ev.teamId = teamId;
      ev.player1Id = playerId || null;
      ev.shotType = shotType;
      ev.shotOutcome = shotOutcome;
    } else if (eventType === EventType.CARD) {
      const teamId = document.getElementById('edit-event-team').value;
      const playerId = document.getElementById('edit-event-player').value;
      const cardType = document.getElementById('edit-card-type').value;
      ev.teamId = teamId;
      ev.player1Id = playerId || null;
      ev.cardType = cardType;
    } else if (eventType === EventType.FOUL_CONCEDED) {
      const teamId = document.getElementById('edit-event-team').value;
      const playerId = document.getElementById('edit-event-player').value;
      const foulOutcome = document.getElementById('edit-foul-outcome').value;
      ev.teamId = teamId;
      ev.player1Id = playerId || null;
      ev.foulOutcome = foulOutcome;
    } else if (eventType === EventType.KICKOUT) {
      const teamId = document.getElementById('edit-event-team').value;
      const won = document.getElementById('edit-kickout-won').value;
      ev.teamId = teamId;
      ev.wonKickout = won === 'won';
    } else if (eventType === EventType.SUBSTITUTION) {
      const teamId = document.getElementById('edit-event-team').value;
      const playerOut = document.getElementById('edit-player-out').value;
      const playerIn = document.getElementById('edit-player-in').value;
      ev.teamId = teamId;
      ev.player1Id = playerOut;
      ev.player2Id = playerIn;
    } else if (eventType === EventType.NOTE) {
      const note = document.getElementById('edit-note-text').value.trim();
      ev.noteText = note;
    }
    // Hide modal and reset editing id
    const modal = document.getElementById('edit-event-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    appState.editingEventId = null;
    // Update scoreboard, events list and last event display
    updateScoreboard(match);
    renderEventsList(match);
    // Use setTimeout to ensure DOM updates are applied before rendering last event
    setTimeout(() => {
      renderLastEvent(match);
    }, 0);
    saveAppState();
  }

  // Cancel editing event
  function cancelEditEvent() {
    const modal = document.getElementById('edit-event-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    appState.editingEventId = null;
  }

  /* Event Listeners Setup */

  function initEventListeners() {
    // Home screen navigation
    document.getElementById('home-matches-btn').addEventListener('click', showMatchesView);
    document.getElementById('home-player-panels-btn').addEventListener('click', showPlayerPanelsView);
    document.getElementById('home-data-management-btn').addEventListener('click', showDataManagementModal);
    
    // Back buttons
    document.getElementById('matches-back-btn').addEventListener('click', showHomeView);
    document.getElementById('player-panels-back-btn').addEventListener('click', showHomeView);
    
    // Data management modal
    document.getElementById('close-data-management-btn').addEventListener('click', hideDataManagementModal);
    
    // Player panels management (note: data-management-btn and player-panels-btn removed from matches screen)
    document.getElementById('add-panel-btn').addEventListener('click', () => showPanelEditor());
    document.getElementById('save-panel-btn').addEventListener('click', savePanelEditor);
    document.getElementById('cancel-panel-edit-btn').addEventListener('click', cancelPanelEditor);
    document.getElementById('swap-panel-players-btn').addEventListener('click', togglePanelSwapMode);
    document.getElementById('export-data-btn').addEventListener('click', exportData);
    document.getElementById('select-import-file-btn').addEventListener('click', () => {
      document.getElementById('import-file-input').click();
    });
    document.getElementById('import-file-input').addEventListener('change', handleFileSelect);
    document.getElementById('import-data-btn').addEventListener('click', importData);
    
    // Statistics modal
    document.getElementById('view-stats-btn').addEventListener('click', showMatchStats);
    document.getElementById('close-stats-modal-btn').addEventListener('click', hideMatchStats);
    
    
    // Share match button
    document.getElementById('share-match-btn').addEventListener('click', shareBasicMatchInfo);

    // Live score sharing
    const liveShareBtn = document.getElementById('live-share-btn');
    if (liveShareBtn) liveShareBtn.addEventListener('click', openLiveShareModal);
    const liveShareClose = document.getElementById('live-share-close');
    if (liveShareClose) liveShareClose.addEventListener('click', closeLiveShareModal);
    const liveShareStart = document.getElementById('live-share-start');
    if (liveShareStart) liveShareStart.addEventListener('click', handleStartBroadcast);
    const liveShareStop = document.getElementById('live-share-stop');
    if (liveShareStop) liveShareStop.addEventListener('click', handleStopBroadcast);
    const liveShareCopy = document.getElementById('live-share-copy');
    if (liveShareCopy) liveShareCopy.addEventListener('click', handleCopyLiveLink);
    const liveShareSend = document.getElementById('live-share-send');
    if (liveShareSend) liveShareSend.addEventListener('click', handleSendLiveLink);

    // Add match button
    document.getElementById('add-match-btn').addEventListener('click', showAddMatchForm);

    // Match list filter input - real-time filtering
    const matchFilterInput = document.getElementById('match-filter-input');
    if (matchFilterInput) {
      matchFilterInput.addEventListener('input', (e) => {
        renderMatchList(e.target.value);
      });
    }

    const panelFilterInput = document.getElementById('panel-filter-input');
    if (panelFilterInput) {
      panelFilterInput.addEventListener('input', (e) => {
        renderPlayerPanelsList(e.target.value);
      });
    }

    // Toggle top fade only when the list has scrolled under the sticky header
    ['match-list', 'player-panels-list'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const update = () => el.classList.toggle('is-scrolled', el.scrollTop > 0);
      el.addEventListener('scroll', update, { passive: true });
      update();
    });

    // Form submission
    document.getElementById('match-form').addEventListener('submit', handleMatchFormSubmit);
    // Cancel form (top bar).  Some versions of the UI include a bottom cancel button
    // (cancel-form-btn), so check both IDs and attach the handler if they exist.
    const cancelTop = document.getElementById('cancel-form-top');
    if (cancelTop) cancelTop.addEventListener('click', cancelMatchForm);
    const cancelBottom = document.getElementById('cancel-form-btn');
    if (cancelBottom) cancelBottom.addEventListener('click', cancelMatchForm);
    // Back to list
    document.getElementById('back-to-list-btn').addEventListener('click', backToList);
    // Edit match button
    const editMatchBtn = document.getElementById('edit-match-btn');
    if (editMatchBtn) editMatchBtn.addEventListener('click', showEditMatchForm);
    // Timer control buttons
    const startTimerBtn = document.getElementById('start-timer-btn');
    if (startTimerBtn) {
      startTimerBtn.addEventListener('click', startMatch);
    }
    document.getElementById('pause-timer-btn').addEventListener('click', pauseMatch);
    document.getElementById('resume-timer-btn').addEventListener('click', resumeMatch);
    // End‑period button click handler with confirmation modal
    // Event type selector change
    document.getElementById('event-type').addEventListener('change', (e) => {
      renderEventFields(e.target.value);
    });
    // Add event modal buttons: Cancel and Add (Done)
    const addEventModalCancel = document.getElementById('add-event-modal-cancel');
    if (addEventModalCancel) {
      addEventModalCancel.addEventListener('click', () => hideAddEventModal());
    }
    
    const addEventModalDone = document.getElementById('add-event-modal-done');
    if (addEventModalDone) {
      addEventModalDone.addEventListener('click', () => {
        addEvent();
        hideAddEventModal();
      });
    }

    // The legacy quick scoring buttons and central edit players button were removed.
    // Back from players edit to details
    const backToDetailsBtn = document.getElementById('back-to-details-btn');
    if (backToDetailsBtn) backToDetailsBtn.addEventListener('click', cancelPlayerChanges);
    // Save/cancel players editing
    const savePlayersBtn = document.getElementById('save-players-btn');
    if (savePlayersBtn) savePlayersBtn.addEventListener('click', savePlayerChanges);
    const cancelPlayersBtn = document.getElementById('cancel-players-btn');
    if (cancelPlayersBtn) cancelPlayersBtn.addEventListener('click', cancelPlayerChanges);
    // (The Swap-mode toggle is rendered inside buildTeamSection() and gets
    // its click handler attached there.)

    // Player selection back button
    const playerSelectionBackBtn = document.getElementById('player-selection-back-btn');
    if (playerSelectionBackBtn) playerSelectionBackBtn.addEventListener('click', () => {
      showView('edit-players-view');
    });

    // Edit event modal buttons
    const saveEditEventBtn = document.getElementById('save-edit-event-btn');
    if (saveEditEventBtn) saveEditEventBtn.addEventListener('click', saveEditedEvent);
    const cancelEditEventBtn = document.getElementById('cancel-edit-event-btn');
    if (cancelEditEventBtn) cancelEditEventBtn.addEventListener('click', cancelEditEvent);

    // Back button for events view
    const eventsBackBtn = document.getElementById('events-back-btn');
    if (eventsBackBtn) {
      eventsBackBtn.addEventListener('click', () => hideEventsView());
    }

    // Share events button
    const shareEventsBtn = document.getElementById('share-events-btn');
    if (shareEventsBtn) {
      shareEventsBtn.addEventListener('click', () => shareEventsList());
    }

    // Time/period editor listeners - both period and timer display are clickable
    const periodDisplay = document.getElementById('period-display');
    const timerDisplay = document.getElementById('timer-display');
    if (periodDisplay) {
      periodDisplay.addEventListener('click', openTimePeriodEditor);
    }
    if (timerDisplay) {
      timerDisplay.addEventListener('click', openTimePeriodEditor);
    }

    // Cancel and Done buttons
    const cancelTimeEditBtn = document.getElementById('cancel-time-edit-btn');
    if (cancelTimeEditBtn) {
      cancelTimeEditBtn.addEventListener('click', cancelTimePeriodEditor);
    }
    const doneTimeEditBtn = document.getElementById('done-time-edit-btn');
    if (doneTimeEditBtn) {
      doneTimeEditBtn.addEventListener('click', saveTimePeriodChanges);
    }

    // Time adjustment buttons (+ and - for minutes)
    const minusMinBtn = document.getElementById('minus-1-min-btn');
    if (minusMinBtn) {
      minusMinBtn.addEventListener('click', () => adjustTime(-60));
    }
    const plusMinBtn = document.getElementById('plus-1-min-btn');
    if (plusMinBtn) {
      plusMinBtn.addEventListener('click', () => adjustTime(60));
    }

    // Period action confirmation modal logic
    const periodButton = document.getElementById('end-period-btn');
    const periodModal = document.getElementById('period-confirm-modal');
    const periodTitle = document.getElementById('period-confirm-title');
    const periodMessage = document.getElementById('period-confirm-message');
    const periodYes = document.getElementById('period-confirm-yes');
    const periodNo = document.getElementById('period-confirm-no');
    
    if (periodButton && periodModal) {
      periodButton.addEventListener('click', () => {
        const label = periodButton.querySelector('#end-period-label');
        const text = label ? label.textContent.trim() : '';
        
        // Set modal content based on action
        if (text.startsWith('Start')) {
          periodTitle.textContent = 'Start Period';
          periodMessage.textContent = `Are you sure you want to ${text.toLowerCase()}?`;
        } else {
          periodTitle.textContent = 'End Period';
          periodMessage.textContent = `Are you sure you want to ${text.toLowerCase()}?`;
        }
        
        // Show modal
        periodModal.classList.remove('hidden');
        periodModal.classList.add('flex');
        
        // Store the action to perform
        periodModal.dataset.action = text.startsWith('Start') ? 'start' : 'end';
      });
      
      // Handle confirmation
      if (periodYes) {
        periodYes.addEventListener('click', () => {
          const action = periodModal.dataset.action;
          
          // Hide modal
          periodModal.classList.add('hidden');
          periodModal.classList.remove('flex');
          
          // Perform action
          if (action === 'start') {
            startMatch();
          } else {
            endPeriod();
          }
        });
      }
      
      // Handle cancellation
      if (periodNo) {
        periodNo.addEventListener('click', () => {
          periodModal.classList.add('hidden');
          periodModal.classList.remove('flex');
        });
      }
      
      // Handle clicking outside modal to close
      periodModal.addEventListener('click', (e) => {
        if (e.target === periodModal) {
          periodModal.classList.add('hidden');
          periodModal.classList.remove('flex');
        }
      });
    }

    // Event type selection modal handlers
    const eventTypeModal = document.getElementById('event-type-modal');
    const eventTypeCancel = document.getElementById('event-type-modal-cancel');
    
    if (eventTypeCancel) {
      eventTypeCancel.addEventListener('click', hideEventTypeModal);
    }
    
    if (eventTypeModal) {
      // Handle clicking outside modal to close
      eventTypeModal.addEventListener('click', (e) => {
        if (e.target === eventTypeModal) {
          hideEventTypeModal();
        }
      });
      
      // Handle event type option clicks
      document.querySelectorAll('.event-type-option').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const eventType = btn.dataset.eventType;
          const teamKey = eventTypeModal.dataset.teamKey;
          
          // Hide the event type modal
          hideEventTypeModal();
          
          // Show the appropriate event-specific modal based on type
          if (eventType === 'miss') {
            // For miss, we can reuse the score modal but with a default miss outcome
            showScoreModal(teamKey, ShotOutcome.WIDE);
          } else if (eventType === 'foul') {
            // For foul, show the new foul-specific modal
            showFoulModal(teamKey);
          } else if (eventType === 'kickout') {
            // For kickout, show the new kickout-specific modal
            showKickoutModal(teamKey);
          } else if (eventType === 'sub') {
            // For substitution, show the new substitution-specific modal
            showSubstitutionModal(teamKey);
          } else if (eventType === 'note') {
            // For note, show the new note-specific modal
            showNoteModal(teamKey);
          }
        });
      });
    }

    // Score event modal buttons: Cancel, Done buttons
    const scoreCancelBtn = document.getElementById('score-modal-cancel');
    if (scoreCancelBtn) {
      scoreCancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        hideScoreModal();
      });
    }
    
    const scoreDoneBtn = document.getElementById('score-modal-done');
    if (scoreDoneBtn) {
      scoreDoneBtn.addEventListener('click', (e) => {
        e.preventDefault();
        saveScoreEvent();
      });
    }
    const scoreSaveBtn = document.getElementById('score-modal-save');
    if (scoreSaveBtn) {
      scoreSaveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        saveScoreEvent();
      });
    }

    // Foul modal event listeners
    const foulCancelBtn = document.getElementById('foul-modal-cancel');
    if (foulCancelBtn) {
      foulCancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        hideFoulModal();
      });
    }
    
    const foulDoneBtn = document.getElementById('foul-modal-done');
    if (foulDoneBtn) {
      foulDoneBtn.addEventListener('click', (e) => {
        e.preventDefault();
        saveFoulEvent();
      });
    }

    // Kickout modal event listeners
    const kickoutCancelBtn = document.getElementById('kickout-modal-cancel');
    if (kickoutCancelBtn) {
      kickoutCancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        hideKickoutModal();
      });
    }
    
    const kickoutDoneBtn = document.getElementById('kickout-modal-done');
    if (kickoutDoneBtn) {
      kickoutDoneBtn.addEventListener('click', (e) => {
        e.preventDefault();
        saveKickoutEvent();
      });
    }

    // Substitution modal event listeners
    const substitutionCancelBtn = document.getElementById('substitution-modal-cancel');
    if (substitutionCancelBtn) {
      substitutionCancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        hideSubstitutionModal();
      });
    }
    
    const substitutionDoneBtn = document.getElementById('substitution-modal-done');
    if (substitutionDoneBtn) {
      substitutionDoneBtn.addEventListener('click', (e) => {
        e.preventDefault();
        saveSubstitutionEvent();
      });
    }

    // Note modal event listeners
    const noteCancelBtn = document.getElementById('note-modal-cancel');
    if (noteCancelBtn) {
      noteCancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        hideNoteModal();
      });
    }
    
    const noteDoneBtn = document.getElementById('note-modal-done');
    if (noteDoneBtn) {
      noteDoneBtn.addEventListener('click', (e) => {
        e.preventDefault();
        saveNoteEvent();
      });
    }

    // Kickout outcome selection setup (one-time initialization)
    const kickoutWonBtn = document.getElementById('kickout-outcome-won');
    const kickoutLostBtn = document.getElementById('kickout-outcome-lost');
    if (kickoutWonBtn && kickoutLostBtn) {
      kickoutWonBtn.addEventListener('click', () => {
        if (kickoutModalData) {
          kickoutModalData.selectedOutcome = 'won';
          updateKickoutOutcomeSelection();
        }
      });
      
      kickoutLostBtn.addEventListener('click', () => {
        if (kickoutModalData) {
          kickoutModalData.selectedOutcome = 'lost';
          updateKickoutOutcomeSelection();
        }
      });
    }

    // Foul type selection setup (one-time initialization)
    const freeBtn = document.getElementById('foul-type-free');
    const penaltyBtn = document.getElementById('foul-type-penalty');
    if (freeBtn && penaltyBtn) {
      freeBtn.addEventListener('click', () => {
        if (foulModalData) {
          foulModalData.selectedFoulType = 'free';
          updateFoulTypeSelection();
        }
      });
      
      penaltyBtn.addEventListener('click', () => {
        if (foulModalData) {
          foulModalData.selectedFoulType = 'penalty';
          updateFoulTypeSelection();
        }
      });
    }

    // Card type selection setup (one-time initialization)
    const cardButtons = ['none', 'yellow', 'red', 'black'];
    cardButtons.forEach(cardType => {
      const btn = document.getElementById(`card-type-${cardType}`);
      if (btn) {
        btn.addEventListener('click', () => {
          if (foulModalData) {
            foulModalData.selectedCardType = cardType;
            updateCardTypeSelection();
          }
        });
      }
    });

    // Team-specific buttons (goal, point, event, edit players)
    document.querySelectorAll('.team-goal-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const teamKey = btn.dataset.team;
        // Open scoring modal instead of immediately adding a goal
        showScoreModal(teamKey, ShotOutcome.GOAL);
      });
    });
    document.querySelectorAll('.team-point-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const teamKey = btn.dataset.team;
        // Open scoring modal instead of immediately adding a point
        showScoreModal(teamKey, ShotOutcome.POINT);
      });
    });

    // Two‑pointer buttons: open scoring modal with the two pointer outcome.  These buttons are only visible
    // when the match type supports two‑pointers (football but not ladies football).  They should behave
    // similarly to the goal and point buttons.
    document.querySelectorAll('.team-two-pointer-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const teamKey = btn.dataset.team;
        showScoreModal(teamKey, ShotOutcome.TWO_POINTER);
      });
    });
    document.querySelectorAll('.team-edit-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const teamKey = btn.dataset.team;
        // Show edit players view only for the selected team
        showEditPlayers(teamKey);
      });
    });
    document.querySelectorAll('.team-event-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const teamKey = btn.dataset.team;
        showEventTypeModal(teamKey);
      });
    });
  }

  // The splash is held for at least this long so it reads as a deliberate launch
  // screen rather than a flicker. Startup is now fast enough (~350ms) that without
  // this the splash would be gone before it could be seen.
  const SPLASH_MIN_MS = 900;
  const splashShownAt = Date.now();

  // Dismiss the launch splash added in index.html. Idempotent: the failsafes below
  // mean this can fire more than once, and whichever call lands first wins.
  // `immediate` skips the minimum-display hold - used by the failsafe paths, which
  // must never be delayed by a cosmetic timer.
  function hideAppSplash(immediate) {
    const splash = document.getElementById('app-splash');
    if (!splash || splash.classList.contains('is-hidden')) return;

    const remaining = SPLASH_MIN_MS - (Date.now() - splashShownAt);
    if (!immediate && remaining > 0) {
      setTimeout(() => hideAppSplash(true), remaining);
      return;
    }

    splash.classList.add('is-hidden');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  }

  // Initialise application
  async function init() {
    // Must precede loadAppState(): on a device upgrading from the old
    // dual-store build, the data still lives in localStorage and IndexedDB is
    // empty, so loading first would show an empty app.
    await StorageManager.migrateFromLocalStorage();
    await loadAppState();
    // Ask to be exempt from eviction. Fire-and-forget: it may be refused, and
    // nothing downstream depends on the answer.
    StorageManager.requestPersistence();
    // Clear broadcasts left running on old matches (Realtime DB has no TTL).
    cleanupStaleBroadcasts();
    renderMatchList(); // Prepare match list data even though we don't show it initially
    initEventListeners();
    // Best-effort orientation lock for installed PWAs (Android/Chrome). iOS
    // Safari ignores this; the CSS landscape-lock overlay handles that case.
    if (screen.orientation && typeof screen.orientation.lock === 'function') {
      screen.orientation.lock('portrait').catch(() => { /* unsupported / not in fullscreen */ });
    }
    // Show home screen by default instead of match list
    showHomeView();
    // Hide the header by default since the home view does not display a title.  It will
    // be shown again when opening match details via showView().
    const header = document.querySelector('header');
    if (header) header.style.display = 'none';
    hideAppSplash();
  }

  // Test seam. Everything above lives inside this IIFE and is otherwise
  // unreachable, so test/storage.test.js - which drives a real browser - has no
  // way to exercise the storage layer directly. Exposing these three is enough
  // for it to save, load and count without reaching into app internals.
  window.__mtTest = {
    saveData: (key, data) => StorageManager.saveData(key, data),
    loadData: (key) => StorageManager.loadData(key),
    matchCount: () => appState.matches.length,
    exportData: () => DataManager.exportData(),
    lastBackupAt: () => appState.lastBackupAt,
    daysSinceBackup: () => DataManager.daysSinceBackup(),
  };

  // Kick off once DOM ready
  document.addEventListener('DOMContentLoaded', init);

  // Failsafes: if init() throws, the splash is opaque and would otherwise trap the
  // user on a blank screen. Never let that happen regardless of what init() does.
  // `load` honours the minimum-display hold (it fires right after a fast init, so
  // dismissing immediately here would defeat the hold entirely); the 3s backstop
  // does not, since by then something has clearly gone wrong.
  window.addEventListener('load', () => hideAppSplash());
  setTimeout(() => hideAppSplash(true), 3000);
})();