/*
 * Match Tracker Web App Logic
 *
 * This script implements a simplified yet feature‑rich match tracker inspired
 * by an iOS application. It supports managing multiple matches,
 * automatically generating players for teams, running a match timer with
 * period control, recording various event types (shot, foul, card,
 * kickout, substitution, note), computing scores and persisting data
 * in localStorage. The UI is designed to work well on mobile devices.
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
    NOTE: 'note'
    // Note: periodStart/periodEnd events are not explicitly supported but
    // could be added later.
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

  // Application state persisted in localStorage
  const appState = {
    matches: [], // array of match objects
    currentMatchId: null,
    timerInterval: null,
    editingEventId: null, // currently edited event id
    editingMatchId: null, // holds ID of match being edited via the form
    playerPanels: [], // array of player panel objects
    lastSelectedPanels: {} // stores last selected panel for each team (matchId-teamKey)
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
    
    // Save data with fallback strategy
    async saveData(key, data) {
      const dataToStore = {
        key: key,
        data: data,
        timestamp: Date.now()
      };
      
      // Try localStorage first (faster)
      try {
        localStorage.setItem(key, JSON.stringify(data));
        console.log(`Saved to localStorage: ${key}`);
      } catch (localStorageError) {
        console.warn('localStorage failed, trying IndexedDB:', localStorageError);
        
        // Fallback to IndexedDB
        try {
          const db = await this.initDB();
          const transaction = db.transaction([this.STORE_NAME], 'readwrite');
          const store = transaction.objectStore(this.STORE_NAME);
          store.put(dataToStore);
          await new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          });
          console.log(`Saved to IndexedDB: ${key}`);
        } catch (indexedDBError) {
          console.error('Both storage methods failed:', indexedDBError);
          this.showStorageWarning();
        }
      }
    },
    
    // Load data with fallback strategy
    async loadData(key) {
      // Try localStorage first
      try {
        const stored = localStorage.getItem(key);
        if (stored) {
          return JSON.parse(stored);
        }
      } catch (localStorageError) {
        console.warn('localStorage read failed, trying IndexedDB:', localStorageError);
      }
      
      // Fallback to IndexedDB
      try {
        const db = await this.initDB();
        const transaction = db.transaction([this.STORE_NAME], 'readonly');
        const store = transaction.objectStore(this.STORE_NAME);
        const request = store.get(key);
        
        return new Promise((resolve, reject) => {
          request.onsuccess = () => {
            const result = request.result;
            resolve(result ? result.data : null);
          };
          request.onerror = () => reject(request.error);
        });
      } catch (indexedDBError) {
        console.error('Both storage methods failed for reading:', indexedDBError);
        return null;
      }
    },
    
    // Get storage usage info
    async getStorageInfo() {
      const info = {
        localStorage: { available: false, used: 0, total: 0 },
        indexedDB: { available: false, used: 0, total: 0 }
      };
      
      // Check localStorage
      if (typeof Storage !== 'undefined') {
        try {
          const testKey = 'storage_test';
          localStorage.setItem(testKey, 'test');
          localStorage.removeItem(testKey);
          info.localStorage.available = true;
          
          // Estimate localStorage usage
          let used = 0;
          for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
              used += localStorage.getItem(key).length;
            }
          }
          info.localStorage.used = used;
          info.localStorage.total = 10 * 1024 * 1024; // ~10MB typical limit
        } catch (e) {
          console.warn('localStorage not available:', e);
        }
      }
      
      // Check IndexedDB
      if ('indexedDB' in window) {
        try {
          await this.initDB();
          info.indexedDB.available = true;
          // Note: Getting exact usage requires more complex implementation
          info.indexedDB.total = 50 * 1024 * 1024; // Estimated available space
        } catch (e) {
          console.warn('IndexedDB not available:', e);
        }
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
    // Export all match data to JSON
    exportData() {
      try {
        const exportData = {
          version: '1.0.0',
          exportDate: new Date().toISOString(),
          matches: appState.matches,
          matchCount: appState.matches.length,
          playerPanels: appState.playerPanels,
          panelCount: appState.playerPanels.length,
          lastSelectedPanels: appState.lastSelectedPanels
        };
        
        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        // Create download link
        const link = document.createElement('a');
        link.href = url;
        link.download = `match-tracker-backup-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        return { success: true, message: `Exported ${exportData.matchCount} matches` };
      } catch (error) {
        console.error('Export failed:', error);
        return { success: false, message: `Export failed: ${error.message}` };
      }
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
      
      let html = '';
      
      if (info.localStorage.available) {
        const usedPercent = ((info.localStorage.used / info.localStorage.total) * 100).toFixed(1);
        html += `<div>localStorage: ${formatBytes(info.localStorage.used)} / ${formatBytes(info.localStorage.total)} (${usedPercent}%)</div>`;
      }
      
      if (info.indexedDB.available) {
        html += `<div>IndexedDB: Available (~${formatBytes(info.indexedDB.total)} space)</div>`;
      }
      
      if (!info.localStorage.available && !info.indexedDB.available) {
        html = '<div class="text-yellow-400">⚠️ No storage available</div>';
      }
      
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
  function renderPlayerPanelsList() {
    const container = document.getElementById('player-panels-list');
    if (!container) return;
    
    if (appState.playerPanels.length === 0) {
      container.innerHTML = `
        <div class="text-center text-gray-400 py-8">
          <p class="text-lg mb-2">No player panels yet</p>
          <p class="text-sm">Create a panel to store player names for quick selection during matches.</p>
        </div>
      `;
      return;
    }
    
    // Clear container and create panel cards using the same method as match cards
    container.innerHTML = '';
    
    appState.playerPanels.forEach(panel => {
      // Create panel card using exact same method as match cards
      const card = document.createElement('div');
      card.className =
        'match-card relative bg-gray-800 border border-gray-700 rounded-lg p-4 cursor-pointer hover:bg-gray-700 flex flex-col space-y-1 text-left';
      card.addEventListener('click', () => showPanelEditor(panel.id));

      // Panel name line (same as competition line in match cards)
      const nameEl = document.createElement('div');
      nameEl.className = 'text-gray-100 font-semibold text-lg';
      nameEl.textContent = panel.name;
      card.appendChild(nameEl);

      // Players count line (same as teams line in match cards)
      const playersEl = document.createElement('div');
      playersEl.className = 'text-gray-400 text-sm';
      playersEl.textContent = `${panel.players.length} players`;
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
      // Initialize empty players list for new panel
      window.tempPanelPlayers = [];
    }
    
    renderPanelPlayersList();
    // nameInput.focus(); // Removed to prevent keyboard popup on mobile
  }
  
  // Render the list of players in the panel editor
  function renderPanelPlayersList() {
    const container = document.getElementById('panel-players-list');
    if (!container) return;
    
    const panelId = appState.editingPanelId;
    let players = [];
    
    if (panelId) {
      const panel = appState.playerPanels.find(p => p.id === panelId);
      players = panel ? panel.players : [];
    } else {
      // For new panels, use temporary players
      players = window.tempPanelPlayers || [];
    }
    
    if (players.length === 0) {
      container.innerHTML = `
        <div class="text-center text-gray-400 py-4">
          <p>No players added yet. Click "Add Player" to start.</p>
        </div>
      `;
      return;
    }
    
    container.innerHTML = players.map((player, index) => `
      <div class="flex justify-between items-center bg-gray-600 p-2 rounded">
        <input type="text" value="${player.name || ''}" 
               onchange="updatePanelPlayerName(${index}, this.value)"
               class="flex-1 mr-3 p-1 bg-gray-700 text-gray-100 border border-gray-500 rounded text-sm"
               placeholder="Player name" />
        <button onclick="removePanelPlayer(${index})" 
                class="cursor-pointer hover:opacity-70 flex-shrink-0" title="Remove Player">
          <img src="icons/delete.svg" alt="Remove Player" class="w-6 h-6" />
        </button>
      </div>
    `).join('');
  }
  
  // Add a new player to the current panel being edited
  function addPlayerToPanel() {
    const panelId = appState.editingPanelId;
    let panel;
    
    if (panelId) {
      panel = appState.playerPanels.find(p => p.id === panelId);
      if (!panel) return;
    } else {
      // If not editing an existing panel, create a temporary structure
      if (!window.tempPanelPlayers) window.tempPanelPlayers = [];
      window.tempPanelPlayers.push({ id: generateId(), name: '' });
      renderPanelPlayersList();
      // Focus on the newly added player input (last one in temp list)
      setTimeout(() => {
        const inputs = document.querySelectorAll('#panel-players-list input[type="text"]');
        if (inputs.length > 0) {
          inputs[inputs.length - 1].focus();
        }
      }, 50);
      return;
    }
    
    panel.players.push({ id: generateId(), name: '' });
    renderPanelPlayersList();
    // Focus on the newly added player input (last one in the list)
    setTimeout(() => {
      const inputs = document.querySelectorAll('#panel-players-list input[type="text"]');
      if (inputs.length > 0) {
        inputs[inputs.length - 1].focus();
      }
    }, 50);
  }
  
  // Remove a player from the current panel being edited
  function removePanelPlayer(index) {
    const panelId = appState.editingPanelId;
    
    if (panelId) {
      const panel = appState.playerPanels.find(p => p.id === panelId);
      if (!panel) return;
      
      panel.players.splice(index, 1);
    } else {
      if (window.tempPanelPlayers) {
        window.tempPanelPlayers.splice(index, 1);
      }
    }
    
    renderPanelPlayersList();
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
    const nameInput = document.getElementById('panel-name');
    const panelName = nameInput.value.trim();
    
    if (!panelName) {
      alert('Please enter a panel name.');
      // nameInput.focus(); // Removed to prevent keyboard popup on mobile
      return;
    }
    
    const panelId = appState.editingPanelId;
    
    if (panelId) {
      // Editing existing panel
      const panel = appState.playerPanels.find(p => p.id === panelId);
      if (!panel) return;
      
      panel.name = panelName;
      // Sort players alphabetically by name (case-insensitive)
      panel.players = panel.players
        .filter(p => p.name.trim() !== '') // Remove empty names
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    } else {
      // Creating new panel
      const players = window.tempPanelPlayers || [];
      const sortedPlayers = players
        .filter(p => p.name.trim() !== '') // Remove empty names
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())); // Sort alphabetically
      
      const newPanel = {
        id: generateId(),
        name: panelName,
        players: sortedPlayers,
        createdDate: new Date().toISOString()
      };
      
      appState.playerPanels.push(newPanel);
      window.tempPanelPlayers = null;
    }
    
    appState.editingPanelId = null;
    saveAppState();
    showPlayerPanelsView();
  }
  
  // Cancel panel editing
  function cancelPanelEditor() {
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
  window.addPlayerToPanel = addPlayerToPanel;
  window.removePanelPlayer = removePanelPlayer;
  window.updatePanelPlayerName = updatePanelPlayerName;

  /* Data Management UI Functions */
  
  function showDataManagementModal() {
    const modal = document.getElementById('data-management-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    
    // Load storage info
    loadStorageInfo();
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
  
  function exportData() {
    const statusDiv = document.getElementById('export-status');
    const result = DataManager.exportData();
    
    statusDiv.textContent = result.message;
    statusDiv.className = result.success ? 'text-sm text-green-400' : 'text-sm text-red-400';
    
    // Clear status after 3 seconds
    setTimeout(() => {
      statusDiv.textContent = '';
      statusDiv.className = 'text-sm text-gray-400';
    }, 3000);
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
      if (match.matchType === 'football' || match.matchType === 'ladies_football') {
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
          display: match.matchType === 'football' || match.matchType === 'ladies_football' 
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
    const isFootball = stats.match.matchType === 'football' || stats.match.matchType === 'ladies_football';
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
    
    const isFootball = stats.match.matchType === 'football' || stats.match.matchType === 'ladies_football';
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
  
  // Generate match share image using Canvas
  function generateMatchShareImage(match, team1Score, team2Score) {
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
      ctx.font = 'bold 42px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(match.competition || 'Match Update', canvas.width / 2, 100);
      
      // Team names and scores
      const team1Y = 300;
      const team2Y = 400;
      
      // Team 1
      ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(match.team1.name, 80, team1Y);
      
      ctx.textAlign = 'right';
      const scoreText1 = `${team1Score.goals}-${team1Score.points}`;
      ctx.fillText(scoreText1, canvas.width - 150, team1Y);
      
      // Team 1 points total (to the right of main score)
      ctx.font = '28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.fillText(`(${team1Score.total})`, canvas.width - 80, team1Y);
      
      // Team 2
      ctx.fillStyle = '#f3f4f6'; // gray-100
      ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(match.team2.name, 80, team2Y);
      
      ctx.textAlign = 'right';
      const scoreText2 = `${team2Score.goals}-${team2Score.points}`;
      ctx.fillText(scoreText2, canvas.width - 150, team2Y);
      
      // Team 2 points total (to the right of main score)
      ctx.font = '28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.fillText(`(${team2Score.total})`, canvas.width - 80, team2Y);
      
      // Separator line
      ctx.strokeStyle = '#4b5563'; // gray-600
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(80, 450);
      ctx.lineTo(canvas.width - 80, 450);
      ctx.stroke();
      
      // Timer and period info
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.font = '32px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`⏱️ ${formatTimeForSharing(match.elapsedTime)} - ${match.currentPeriod}`, canvas.width / 2, 520);
      
      // Venue (if available)
      if (match.venue) {
        ctx.fillText(`📍 ${match.venue}`, canvas.width / 2, 570);
      }
      
      // App branding with custom icon
      const brandingY = match.venue ? 650 : 620;
      
      // App branding - keep it simple and working
      ctx.fillStyle = '#60a5fa'; // blue-400  
      ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Alans Match Tracker', canvas.width / 2, brandingY);
      
      // Convert to blob
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png', 0.9);
    });
  }

  // Generate team scorer card share image using Canvas
  function generateScorerCardImage(match, teamName, teamStats, scorers) {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Calculate dynamic height based on number of scorers
      canvas.width = 800;
      const maxScorers = Math.min(scorers.length, 10);
      const headerHeight = 280; // Space for team name, score, and "Scorers" header
      const rowHeight = 95; // Increased to accommodate breakdown text below main score
      const scorersHeight = maxScorers * rowHeight;
      const footerHeight = 120; // Space for branding and bottom padding
      const extraHeight = scorers.length > maxScorers ? 40 : 0; // Space for "and X more" text
      
      canvas.height = Math.max(800, headerHeight + scorersHeight + footerHeight + extraHeight);
      
      // Background gradient
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, '#374151'); // gray-700
      gradient.addColorStop(1, '#1f2937'); // gray-800
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Team name header
      ctx.fillStyle = '#f3f4f6'; // gray-100
      ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(teamName, canvas.width / 2, 80);
      
      // Team score
      ctx.fillStyle = '#60a5fa'; // blue-400
      ctx.font = 'bold 64px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(teamStats.score.display, canvas.width / 2, 160);
      
      // Score total in parentheses
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.font = '32px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(`(${teamStats.score.total})`, canvas.width / 2, 200);
      
      // Scorers header
      if (scorers.length > 0) {
        ctx.fillStyle = '#10b981'; // green-500
        ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Scorers', 80, 280);
        
        // Scorer list with dividing lines
        let currentY = 340;
        const rowHeight = 95; // Increased space to accommodate breakdown text below main score
        const maxScorers = Math.min(scorers.length, 10); // Limit to top 10 scorers
        
        for (let i = 0; i < maxScorers; i++) {
          const scorer = scorers[i];
          const isFootball = match.matchType === 'football' || match.matchType === 'ladies_football';
          
          // Calculate text positions within the row - main score higher up to make room for breakdown below
          const mainScoreY = currentY + (rowHeight / 2) + 5; // Position main score with more space from divider above
          const breakdownY = currentY + (rowHeight / 2) + 25; // Position breakdown below main score
          
          // Player name - bigger for mobile readability
          ctx.fillStyle = '#f3f4f6'; // gray-100
          ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(scorer.name, 80, mainScoreY);
          
          // Build score display and breakdown
          const scoreDisplay = formatScoreDisplay(scorer.total, isFootball);
          
          // Breakdown (frees/penalties/two-pointers) 
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
          
          // Main score - positioned at the right edge
          ctx.fillStyle = '#f3f4f6'; // gray-100
          ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(scoreDisplay, canvas.width - 80, mainScoreY);
          
          // Position breakdown below main score if it exists (like scorecard layout)
          if (breakdowns.length > 0) {
            ctx.font = '22px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
            ctx.textAlign = 'left';
            
            // Build breakdown text piece by piece to handle coloring properly
            let currentX = canvas.width - 80;
            
            // Start with closing parenthesis (since we're building right to left)
            ctx.fillStyle = '#9ca3af'; // gray-400
            const closeParen = ')';
            const closeParenWidth = ctx.measureText(closeParen).width;
            currentX -= closeParenWidth;
            ctx.fillText(closeParen, currentX, breakdownY);
            
            // Draw breakdown items from right to left
            for (let i = breakdowns.length - 1; i >= 0; i--) {
              const breakdown = breakdowns[i];
              
              // Add comma separator if not the last item
              if (i < breakdowns.length - 1) {
                ctx.fillStyle = '#9ca3af';
                const separator = ', ';
                const separatorWidth = ctx.measureText(separator).width;
                currentX -= separatorWidth;
                ctx.fillText(separator, currentX, breakdownY);
              }
              
              if (breakdown.startsWith('2p:')) {
                // Handle two-pointer breakdown with orange "2p:" and gray count
                const count = breakdown.split(':')[1];
                
                // Draw count in gray
                ctx.fillStyle = '#9ca3af';
                const countWidth = ctx.measureText(count).width;
                currentX -= countWidth;
                ctx.fillText(count, currentX, breakdownY);
                
                // Draw "2p:" in orange
                ctx.fillStyle = '#f97316'; // orange-500
                const twoPointerText = '2p:';
                const twoPointerWidth = ctx.measureText(twoPointerText).width;
                currentX -= twoPointerWidth;
                ctx.fillText(twoPointerText, currentX, breakdownY);
              } else {
                // Draw regular breakdown in gray
                ctx.fillStyle = '#9ca3af';
                const breakdownWidth = ctx.measureText(breakdown).width;
                currentX -= breakdownWidth;
                ctx.fillText(breakdown, currentX, breakdownY);
              }
            }
            
            // Draw opening parenthesis (since we're building right to left, this comes last)
            ctx.fillStyle = '#9ca3af';
            const openParen = '(';
            const openParenWidth = ctx.measureText(openParen).width;
            currentX -= openParenWidth;
            ctx.fillText(openParen, currentX, breakdownY);
          }
          
          // Add dividing line between entries (except for last entry)
          if (i < maxScorers - 1) {
            ctx.strokeStyle = '#9ca3af'; // gray-400
            ctx.lineWidth = 1;
            ctx.beginPath();
            // Position divider at the bottom of the row
            ctx.moveTo(80, currentY + rowHeight);
            ctx.lineTo(canvas.width - 80, currentY + rowHeight);
            ctx.stroke();
          }
          
          // Move to next row with more space
          currentY += rowHeight;
        }
        
        // Show "and X more" if there are additional scorers
        if (scorers.length > maxScorers) {
          ctx.fillStyle = '#9ca3af'; // gray-400
          ctx.font = '20px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`...and ${scorers.length - maxScorers} more`, canvas.width / 2, currentY);
        }
      } else {
        // No scorers message
        ctx.fillStyle = '#9ca3af'; // gray-400
        ctx.font = '24px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No scorers yet', canvas.width / 2, 320);
      }
      
      // App branding - position relative to bottom of canvas
      ctx.fillStyle = '#60a5fa'; // blue-400  
      ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Alans Match Tracker', canvas.width / 2, canvas.height - 40);
      
      // Convert to blob
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png', 0.9);
    });
  }

  // Generate team comparison card share image using Canvas
  function generateComparisonCardImage(match, comparisonStats) {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Set canvas size for social sharing
      canvas.width = 800;
      canvas.height = 600;
      
      // Background gradient
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, '#374151'); // gray-700
      gradient.addColorStop(1, '#1f2937'); // gray-800
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Header
      ctx.fillStyle = '#f3f4f6'; // gray-100
      ctx.font = 'bold 40px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Team Shooting Accuracy', canvas.width / 2, 80);
      
      // Match info
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.font = '28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(`${match.team1.name} vs ${match.team2.name}`, canvas.width / 2, 130);
      
      // Team comparison section
      const team1X = canvas.width * 0.25;
      const team2X = canvas.width * 0.75;
      const statsY = 220;
      
      // Team 1
      ctx.fillStyle = '#f3f4f6'; // gray-100
      ctx.font = 'bold 32px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(comparisonStats.team1.name, team1X, statsY);
      
      // Team 1 accuracy with color coding
      const team1Color = comparisonStats.team1.accuracy >= 70 ? '#22c55e' : 
                         comparisonStats.team1.accuracy >= 50 ? '#eab308' : '#ef4444';
      ctx.fillStyle = team1Color;
      ctx.font = 'bold 64px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(`${comparisonStats.team1.accuracy}%`, team1X, statsY + 80);
      
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.font = '24px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(`${comparisonStats.team1.successful}/${comparisonStats.team1.total} shots`, team1X, statsY + 120);
      
      // Team 2
      ctx.fillStyle = '#f3f4f6'; // gray-100
      ctx.font = 'bold 32px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(comparisonStats.team2.name, team2X, statsY);
      
      // Team 2 accuracy with color coding
      const team2Color = comparisonStats.team2.accuracy >= 70 ? '#22c55e' : 
                         comparisonStats.team2.accuracy >= 50 ? '#eab308' : '#ef4444';
      ctx.fillStyle = team2Color;
      ctx.font = 'bold 64px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(`${comparisonStats.team2.accuracy}%`, team2X, statsY + 80);
      
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.font = '24px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(`${comparisonStats.team2.successful}/${comparisonStats.team2.total} shots`, team2X, statsY + 120);
      
      // Center divider line
      ctx.strokeStyle = '#6b7280'; // gray-500
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(canvas.width / 2, statsY - 30);
      ctx.lineTo(canvas.width / 2, statsY + 140);
      ctx.stroke();
      
      // App branding
      ctx.fillStyle = '#60a5fa'; // blue-400
      ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Alans Match Tracker', canvas.width / 2, canvas.height - 40);
      
      // Convert to blob
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png', 0.9);
    });
  }

  // Generate team player shooting card share image using Canvas
  function generatePlayerShootingCardImage(match, teamName, teamStats, playerStats) {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Calculate dynamic height based on number of shooting players
      canvas.width = 800;
      const maxPlayers = Math.min(playerStats.length, 10);
      const headerHeight = 280;
      const rowHeight = 90;
      const playersHeight = maxPlayers * rowHeight;
      const footerHeight = 120;
      const extraHeight = playerStats.length > maxPlayers ? 40 : 0;
      
      canvas.height = Math.max(600, headerHeight + playersHeight + footerHeight + extraHeight);
      
      // Background gradient
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, '#374151'); // gray-700
      gradient.addColorStop(1, '#1f2937'); // gray-800
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Team name header
      ctx.fillStyle = '#f3f4f6'; // gray-100
      ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${teamName} Shooting`, canvas.width / 2, 80);
      
      // Team accuracy
      ctx.fillStyle = '#60a5fa'; // blue-400
      ctx.font = 'bold 56px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(`${teamStats.accuracy}%`, canvas.width / 2, 160);
      
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.font = '28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.fillText(`${teamStats.successful}/${teamStats.total} shots`, canvas.width / 2, 200);
      
      // Players section
      if (playerStats.length > 0) {
        ctx.fillStyle = '#22c55e'; // green-500
        ctx.font = 'bold 32px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Player Shooting', 60, 260);
        
        const displayPlayers = playerStats.slice(0, maxPlayers);
        displayPlayers.forEach((player, index) => {
          const y = 320 + (index * rowHeight);
          
          // Player name
          ctx.fillStyle = '#f3f4f6'; // gray-100
          ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
          ctx.textAlign = 'left';
          const playerName = player.name || `Player ${player.jerseyNumber}`;
          ctx.fillText(playerName, 60, y);
          
          // Shooting stats
          ctx.fillStyle = '#f3f4f6'; // gray-100
          ctx.textAlign = 'right';
          ctx.fillText(`${player.accuracy}% (${player.successfulShots}/${player.totalShots})`, canvas.width - 60, y);
          
          // Shot breakdown - separate success and misses like UI format
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
            ctx.fillStyle = '#9ca3af'; // gray-400
            ctx.font = '20px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
            ctx.fillText(breakdownText, canvas.width - 60, y + 25);
          }
        });
        
        if (playerStats.length > maxPlayers) {
          const remainingY = 320 + (maxPlayers * rowHeight);
          ctx.fillStyle = '#9ca3af'; // gray-400
          ctx.font = '24px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`... and ${playerStats.length - maxPlayers} more players`, canvas.width / 2, remainingY);
        }
      } else {
        ctx.fillStyle = '#9ca3af'; // gray-400
        ctx.font = '32px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No shots taken yet', canvas.width / 2, 320);
      }
      
      // Legend - split into two lines for better readability
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.font = '20px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Success: G=Goals, P=Points, 2P=Two-Pointers', canvas.width / 2, canvas.height - 100);
      ctx.fillText('Misses: W=Wide, S=Saved, DS=Dropped Short, OP=Off Post', canvas.width / 2, canvas.height - 75);
      
      // App branding
      ctx.fillStyle = '#60a5fa'; // blue-400
      ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Alans Match Tracker', canvas.width / 2, canvas.height - 40);
      
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

    // Process events in chronological order (as they appear in the array)
    match.events.forEach((ev, index) => {
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
  }

  // Save matches using enhanced storage system
  async function saveAppState() {
    try {
      await StorageManager.saveData('matches', appState.matches);
      await StorageManager.saveData('playerPanels', appState.playerPanels);
      await StorageManager.saveData('lastSelectedPanels', appState.lastSelectedPanels);
    } catch (err) {
      console.error('Failed to save app state', err);
    }
  }

  // Find a match by ID
  function findMatchById(matchId) {
    return appState.matches.find((m) => m.id === matchId);
  }

  /**
   * Delete a match from the application state and update persistent storage.  This helper
   * removes the match with the given ID from the matches array, updates
   * localStorage and refreshes the match list view.  If the currently viewed
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

    filtered.forEach((match) => {
      // Create a card wrapper for each match item.  Use a vertical layout with
      // subtle spacing between lines.  The card is clickable to open match
      // details and has relative positioning so we can anchor the delete
      // button inside it.
      const card = document.createElement('div');
      card.className =
        'match-card relative bg-gray-800 border border-gray-700 rounded-lg p-4 cursor-pointer hover:bg-gray-700 flex flex-col space-y-1 text-left';
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
      v.style.display = v.id === viewId ? 'block' : 'none';
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

    // Process events in chronological order (as they appear in the array)
    match.events.forEach((ev, index) => {
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

  // Compute and render scoreboard for current match
  function updateScoreboard(match) {
    const team1Score = computeTeamScore(match, 'team1');
    const team2Score = computeTeamScore(match, 'team2');
    // Update team cards instead of old scoreboard
    const card1 = document.getElementById('team1-card');
    const card2 = document.getElementById('team2-card');
    if (card1) {
      card1.querySelector('.team-name').textContent = match.team1.name;
      card1.querySelector('.score-goals').textContent = team1Score.goals;
      card1.querySelector('.score-points').textContent = team1Score.points;
      card1.querySelector('.score-total').textContent = `(${team1Score.total})`;
    }
    if (card2) {
      card2.querySelector('.team-name').textContent = match.team2.name;
      card2.querySelector('.score-goals').textContent = team2Score.goals;
      card2.querySelector('.score-points').textContent = team2Score.points;
      card2.querySelector('.score-total').textContent = `(${team2Score.total})`;
    }

    // Show or hide the two‑pointer buttons based on the match type.  A two‑pointer is only available
    // in football (men's) matches.  Ladies football, hurling and camogie do not use two pointers.
    updateTwoPointerButtons(match);
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

  // Render the last event summary at bottom of the match details view
  function renderLastEvent(match) {
    const display = document.getElementById('last-event-display');
    if (!display) return;
    // If no events, hide
    if (!match || !match.events || match.events.length === 0) {
      display.innerHTML = '';
      display.classList.add('hidden');
      return;
    }
    // Latest event is the last one in the array because events are appended sequentially.
    const last = match.events[match.events.length - 1];
    if (!last) {
      display.innerHTML = '';
      display.classList.add('hidden');
      return;
    }
    // Compute the running score up to this last event to display the scoreboard
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
      if (ev.id === last.id) return;
    });
    // Prepare left and right sections similar to the events list styling
    display.innerHTML = '';
    // Left column
    const details = document.createElement('div');
    details.className = 'flex-1';
    // Team name line
    const teamName = document.createElement('div');
    teamName.className = 'font-semibold text-gray-200';
    const team = last.teamId ? (last.teamId === match.team1.id ? match.team1 : match.team2) : null;
    teamName.textContent = team ? team.name : '';
    details.appendChild(teamName);
    // Type/outcome line
    const typeLine = document.createElement('div');
    typeLine.className = 'text-gray-300 text-sm';
    let outcomeText = '';
    if (last.type === EventType.SHOT) {
      outcomeText = last.shotOutcome
        .replace(/([A-Z])/g, ' $1')
        .replace(/\b\w/g, (l) => l.toUpperCase());
    } else if (last.type === EventType.CARD) {
      outcomeText = `${last.cardType ? last.cardType.charAt(0).toUpperCase() + last.cardType.slice(1) : ''} Card`;
    } else if (last.type === EventType.FOUL_CONCEDED) {
      let foulText = `Foul${last.foulOutcome ? ' (' + last.foulOutcome.charAt(0).toUpperCase() + last.foulOutcome.slice(1) + ')' : ''}`;
      if (last.cardType) {
        foulText += ` + ${last.cardType.charAt(0).toUpperCase() + last.cardType.slice(1)} Card`;
      }
      outcomeText = foulText;
    } else if (last.type === EventType.KICKOUT) {
      outcomeText = `Kick‑out ${last.wonKickout ? 'Won' : 'Lost'}`;
    } else if (last.type === EventType.SUBSTITUTION) {
      outcomeText = 'Substitution';
    } else if (last.type === EventType.NOTE) {
      outcomeText = 'Note';
    }
    typeLine.textContent = outcomeText;
    details.appendChild(typeLine);
    // Scoreboard lines for scoring shots
    if (
      last.type === EventType.SHOT &&
      (last.shotOutcome === ShotOutcome.GOAL || last.shotOutcome === ShotOutcome.POINT || last.shotOutcome === ShotOutcome.TWO_POINTER)
    ) {
      const sbLine1 = document.createElement('div');
      sbLine1.className = 'text-blue-400 text-sm';
      sbLine1.textContent = `${match.team1.name}: ${t1Goals}-${t1Points}`;
      const sbLine2 = document.createElement('div');
      sbLine2.className = 'text-blue-400 text-sm';
      sbLine2.textContent = `${match.team2.name}: ${t2Goals}-${t2Points}`;
      details.appendChild(sbLine1);
      details.appendChild(sbLine2);
    }
    // Player and extra lines for shots
    const getPlayer = (playerId) => {
      if (!playerId) return null;
      return (
        match.team1.players.find((p) => p.id === playerId) ||
        match.team2.players.find((p) => p.id === playerId) ||
        null
      );
    };
    if (last.type === EventType.SHOT) {
      const player = getPlayer(last.player1Id);
      if (player) {
        const defaultName = `No.${player.jerseyNumber}`;
        const pLine = document.createElement('div');
        pLine.className = 'text-gray-300 text-sm';
        let line = `#${player.jerseyNumber}`;
        if (player.name && player.name !== defaultName) {
          line += ` ${player.name}`;
        }
        pLine.textContent = line;
        details.appendChild(pLine);
      }
      // Shot type line
      if (last.shotType) {
        const shotLine = document.createElement('div');
        shotLine.className = 'text-gray-400 text-sm';
        const shotTypeMap = {
          fromPlay: 'From Play',
          free: 'Free',
          penalty: 'Penalty',
          '45m65m': '45m/65m',
          sideline: 'Sideline',
          mark: 'Mark'
        };
        shotLine.textContent = shotTypeMap[last.shotType] || last.shotType
          .replace(/([A-Z])/g, ' $1')
          .replace(/\b\w/g, (l) => l.toUpperCase());
        details.appendChild(shotLine);
      }
    }
    // Substitution player lines
    if (last.type === EventType.SUBSTITUTION) {
      const outP = getPlayer(last.player1Id);
      const inP = getPlayer(last.player2Id);
      const subLine = document.createElement('div');
      subLine.className = 'text-gray-300 text-sm';
      const outStr = outP ? `#${outP.jerseyNumber}${outP.name && outP.name !== `No.${outP.jerseyNumber}` ? ' ' + outP.name : ''}` : '';
      const inStr = inP ? `#${inP.jerseyNumber}${inP.name && inP.name !== `No.${inP.jerseyNumber}` ? ' ' + inP.name : ''}` : '';
      subLine.textContent = `${outStr} ⟶ ${inStr}`;
      details.appendChild(subLine);
    }
    // Card/foul player line
    if (last.type === EventType.CARD || last.type === EventType.FOUL_CONCEDED) {
      const p = getPlayer(last.player1Id);
      if (p) {
        const defaultName = `No.${p.jerseyNumber}`;
        const pLine = document.createElement('div');
        pLine.className = 'text-gray-300 text-sm';
        let line = `#${p.jerseyNumber}`;
        if (p.name && p.name !== defaultName) {
          line += ` ${p.name}`;
        }
        pLine.textContent = line;
        details.appendChild(pLine);
      }
    }
    // Note text line for any event with notes
    if (last.noteText && last.noteText.trim()) {
      const nLine = document.createElement('div');
      nLine.className = 'text-gray-300 text-sm';
      nLine.textContent = last.noteText;
      details.appendChild(nLine);
    }
    // Ensure minimum 4 lines to prevent button overlap
    const currentLines = details.children.length;
    const minLines = 4;
    if (currentLines < minLines) {
      for (let i = currentLines; i < minLines; i++) {
        const spacer = document.createElement('div');
        spacer.className = 'text-gray-300 text-sm';
        spacer.innerHTML = '&nbsp;'; // Invisible content to maintain line height
        details.appendChild(spacer);
      }
    }
    // Append details to display
    display.appendChild(details);
    // Right column: time, period and list button
    const rightCol = document.createElement('div');
    rightCol.className = 'flex flex-col items-end ml-3 flex-shrink-0';
    const minutes = Math.floor(last.timeElapsed / 60);
    const timeStr = `${minutes} min`;
    const timeDiv = document.createElement('div');
    timeDiv.className = 'text-gray-200 text-sm font-medium';
    timeDiv.textContent = timeStr;
    rightCol.appendChild(timeDiv);
    const periodDiv = document.createElement('div');
    periodDiv.className = 'text-gray-400 text-xs';
    periodDiv.textContent = last.period;
    rightCol.appendChild(periodDiv);
    // Finish assembling right column and append to the display
    display.appendChild(rightCol);
    // Add an event‑list button positioned at the bottom right of the card.  This
    // button shows an icon of three bars.  The fill‑current attribute makes
    // the SVG adopt the current text colour (blue) from the class below.
    const listBtn = document.createElement('button');
    listBtn.id = 'show-events-btn';
    listBtn.className = 'absolute bottom-2 right-2 text-blue-400';
    listBtn.title = 'Show all events';
    listBtn.innerHTML = '<img src="icons/burger.svg" alt="Show all events" class="w-8 h-8" />';
    display.appendChild(listBtn);
    display.classList.remove('hidden');
    // Attach click handler for the list button to open the events list modal
    listBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showEventsView();
      display.classList.add('hidden');
    });
    // Attach click on display to edit last event (excluding the list button)
    display.onclick = (e) => {
      if (e.target.closest('button') === listBtn) return;
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

    // Build header with appropriate icon and label
    const label = document.createElement('span');
    let labelText;
    
    // Check if this is a miss event (any non-scoring outcome)
    const isMissEvent = outcome !== ShotOutcome.GOAL && outcome !== ShotOutcome.POINT && outcome !== ShotOutcome.TWO_POINTER;
    
    if (isMissEvent) {
      // For miss events, use the miss icon and generic "Miss" label
      const missIcon = document.createElement('img');
      missIcon.src = 'icons/miss.svg';
      missIcon.alt = 'Miss';
      missIcon.classList.add('w-6', 'h-6');
      titleEl.appendChild(missIcon);
      labelText = 'Miss';
    } else {
      // For scoring events, use the flag icon as before
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.classList.add('w-6', 'h-6');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('d', 'M3 2.25a.75.75 0 0 1 .75.75v.54l1.838-.46a9.75 9.75 0 0 1 6.725.738l.108.054A8.25 8.25 0 0 0 18 4.524l3.11-.732a.75.75 0 0 1 .917.81 47.784 47.784 0 0 0 .005 10.337.75.75 0 0 1-.574.812l-3.114.733a9.75 9.75 0 0 1-6.594-.77l-.108-.054a8.25 8.25 0 0 0-5.69-.625l-2.202.55V21a.75.75 0 0 1-1.5 0V3A.75.75 0 0 1 3 2.25Z');
      path.setAttribute('clip-rule', 'evenodd');
      // Fill color according to outcome
      if (outcome === ShotOutcome.GOAL) {
        path.setAttribute('fill', '#22C55E');
        labelText = 'Goal';
      } else if (outcome === ShotOutcome.TWO_POINTER) {
        path.setAttribute('fill', '#FB923C');
        labelText = '2 Pointer';
      } else {
        path.setAttribute('fill', '#FFFFFF');
        labelText = 'Point';
      }
      icon.appendChild(path);
      titleEl.appendChild(icon);
    }
    
    label.textContent = labelText;
    label.classList.add('text-xl', 'font-semibold');
    titleEl.appendChild(label);
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
        btn.textContent = label;
        btn.className = 'w-full text-left p-2 border border-gray-600 rounded text-sm';
        
        if (value === scoreModalData.selectedShotType) {
          btn.classList.add('bg-blue-600', 'text-white');
        } else {
          btn.classList.add('bg-gray-700', 'text-gray-100');
        }
        
        btn.addEventListener('click', () => {
          scoreModalData.selectedShotType = value;
          // Highlight selected shot type
          typeListEl.querySelectorAll('button').forEach((item) => {
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
    noneBtn.innerHTML = `<div class="flex items-center space-x-2"><span class="w-6 h-6 flex items-center justify-center bg-gray-600 border border-gray-500 rounded">--</span><span>None</span></div>`;
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
      btn.innerHTML = `<div class="flex items-center space-x-2"><span class="w-6 h-6 flex items-center justify-center bg-gray-600 border border-gray-500 rounded">${p.jerseyNumber}</span><span>${p.name}</span></div>`;
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
      // Section container styling for dark mode
      sec.className = 'team-players space-y-2';
      
      // Team header (name only)
      const header = document.createElement('h3');
      header.textContent = team.name;
      header.className = 'text-lg font-semibold text-gray-100 mb-2';
      sec.appendChild(header);
      
      // Panel selection moved to Select Player screen
      
      // Sort players numerically by jersey number for consistency.
      const playersSorted = [...team.players].sort((a, b) => a.jerseyNumber - b.jerseyNumber);
      playersSorted.forEach((player) => {
        const row = document.createElement('div');
        // Row styling: display label, input, and select button horizontally
        row.className = 'player-row flex items-center space-x-2';
        
        const label = document.createElement('label');
        label.textContent = player.jerseyNumber;
        label.className = 'w-10 text-gray-300';
        
        const input = document.createElement('input');
        input.type = 'text';
        input.value = player.name;
        // Persist player and team identifiers in data attributes
        input.dataset.playerId = player.id;
        input.dataset.teamKey = key;
        input.dataset.jerseyNumber = player.jerseyNumber;
        // Dark mode styling for player name input
        input.className = 'flex-1 p-2 border rounded bg-gray-700 text-gray-100 border-gray-600';
        
        // Add Select Player button
        const selectBtn = document.createElement('button');
        selectBtn.type = 'button';
        selectBtn.innerHTML = '<img src="icons/selectplayer.svg" alt="Select Player" class="w-6 h-6" />';
        selectBtn.className = 'cursor-pointer hover:opacity-70 disabled:opacity-30 disabled:cursor-not-allowed';
        selectBtn.title = 'Select Player from Panel';
        // Button is always enabled - panel selection happens on the Select Player screen
        selectBtn.dataset.teamKey = key;
        selectBtn.dataset.playerId = player.id;
        selectBtn.dataset.jerseyNumber = player.jerseyNumber;
        
        selectBtn.addEventListener('click', (e) => {
          // Use currentTarget to get the button element instead of potentially the img inside it
          const button = e.currentTarget;
          const teamKey = button.dataset.teamKey;
          const playerId = button.dataset.playerId;
          const jerseyNumber = button.dataset.jerseyNumber;
          showPlayerSelectionDropdown(teamKey, playerId, jerseyNumber, button);
        });
        
        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(selectBtn);
        sec.appendChild(row);
      });
      
      // Panel selection moved to Select Player screen - no restoration needed here
      
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
    
    // Set jersey info
    jerseyInfo.textContent = `Selecting player for Jersey #${jerseyNumber}`;
    
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
      .forEach(player => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'w-full text-left px-8 py-6 text-xl text-gray-100 bg-gray-700 hover:bg-gray-600 rounded border border-gray-600 transition-colors mb-4';
        button.textContent = player.name;
        
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

  // Make player panel functions globally accessible
  window.showPlayerSelectionDropdown = showPlayerSelectionDropdown;
  window.selectPlayerForJersey = selectPlayerForJersey;

  // Save player name changes
  function savePlayerChanges() {
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
    // Simply go back to match details view; no changes have been saved
    showView('match-details-view');
  }

  // Update timer display and buttons according to match state
  function updateTimerControls(match) {
    const display = document.getElementById('timer-display');
    if (display) {
      display.textContent = formatTime(match.elapsedTime);
    }
    // Also update the period text above the timer
    const periodElem = document.getElementById('period-display');
    if (periodElem) {
      periodElem.textContent = match.currentPeriod;
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
    // Display most recent events first by reversing the events array.  Events are added
    // sequentially, so the newest is at the end of the array.  Reversing ensures
    // the latest actions appear at the top of the list.
    const sorted = [...match.events].slice().reverse();
    if (sorted.length === 0) {
      const msg = document.createElement('li');
      msg.className = 'empty-message text-center text-gray-400 py-4';
      msg.textContent = 'No events yet.';
      list.appendChild(msg);
      return;
    }
    sorted.forEach((ev) => {
      const item = document.createElement('li');
      // Use a card-like appearance with border and subtle hover effect
      item.className = 'event-item px-4 py-3 mb-2 cursor-pointer bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg min-h-20 relative';
      
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
      } else if (ev.type === EventType.CARD) {
        outcomeText = `${ev.cardType ? ev.cardType.charAt(0).toUpperCase() + ev.cardType.slice(1) : ''} Card`;
      } else if (ev.type === EventType.FOUL_CONCEDED) {
        let foulText = `Foul${ev.foulOutcome ? ' (' + ev.foulOutcome.charAt(0).toUpperCase() + ev.foulOutcome.slice(1) + ')' : ''}`;
        if (ev.cardType) {
          foulText += ` + ${ev.cardType.charAt(0).toUpperCase() + ev.cardType.slice(1)} Card`;
        }
        outcomeText = foulText;
      } else if (ev.type === EventType.KICKOUT) {
        outcomeText = `Kick‑out ${ev.wonKickout ? 'Won' : 'Lost'}`;
      } else if (ev.type === EventType.SUBSTITUTION) {
        outcomeText = 'Substitution';
      } else if (ev.type === EventType.NOTE) {
        outcomeText = 'Note';
      }
      typeLine.textContent = outcomeText;
      details.appendChild(typeLine);
      // Scoreboard lines: only for scoring shots (goal/point/twoPointer)
      const scoreboard = scoreByEventId[ev.id];
      if (
        ev.type === EventType.SHOT &&
        (ev.shotOutcome === ShotOutcome.GOAL || ev.shotOutcome === ShotOutcome.POINT || ev.shotOutcome === ShotOutcome.TWO_POINTER)
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
      // Delete button: render a trash icon instead of an “X” and position it at the
      // bottom right of the event card.  Using absolute positioning allows the
      // icon to float to the card’s corner independent of the right column.
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
    document.getElementById('add-player-to-panel-btn').addEventListener('click', addPlayerToPanel);
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
    
    // Add match button
    document.getElementById('add-match-btn').addEventListener('click', showAddMatchForm);

    // Match list filter input - real-time filtering
    const matchFilterInput = document.getElementById('match-filter-input');
    if (matchFilterInput) {
      matchFilterInput.addEventListener('input', (e) => {
        renderMatchList(e.target.value);
      });
    }

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

  // Initialise application
  async function init() {
    await loadAppState();
    renderMatchList(); // Prepare match list data even though we don't show it initially
    initEventListeners();
    // Show home screen by default instead of match list
    showHomeView();
    // Hide the header by default since the home view does not display a title.  It will
    // be shown again when opening match details via showView().
    const header = document.querySelector('header');
    if (header) header.style.display = 'none';
  }

  // Kick off once DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();