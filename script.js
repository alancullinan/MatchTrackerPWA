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
    editingMatchId: null // holds ID of match being edited via the form
  };

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

  // Load matches from localStorage into appState
  function loadAppState() {
    try {
      const stored = localStorage.getItem('matches');
      if (stored) {
        appState.matches = JSON.parse(stored);
      }
    } catch (err) {
      console.warn('Failed to load matches from localStorage', err);
      appState.matches = [];
    }
  }

  // Save matches to localStorage
  function saveAppState() {
    localStorage.setItem('matches', JSON.stringify(appState.matches));
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

  // Convert seconds to mm:ss string
  function formatTime(seconds) {
    const m = Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0');
    const s = Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0');
    return `${m}:${s}`;
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
  function renderMatchList() {
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
    sorted.forEach((match) => {
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

      // Teams line: display the two team names separated by “vs”.  Use
      // secondary colour to differentiate from the competition line.
      const teamsLine = document.createElement('div');
      teamsLine.className = 'text-gray-300';
      teamsLine.textContent = `${match.team1?.name || ''} vs ${match.team2?.name || ''}`;
      card.appendChild(teamsLine);

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
      del.className = 'absolute top-2 right-2 text-gray-300 hover:text-gray-100';
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
  }

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
      display.classList.add('hidden');
      return;
    }
    // Latest event is the last one in the array because events are appended sequentially.
    const last = match.events[match.events.length - 1];
    if (!last) {
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
    const wrapper = document.createElement('div');
    // Use relative positioning so we can place the event list (bars) button
    // absolutely in the bottom right corner.  The flex layout arranges the
    // details and time/period columns as before.
    wrapper.className = 'relative flex justify-between items-start bg-gray-800 border border-gray-700 rounded-lg px-3 py-2';
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
      outcomeText = `Foul${last.foulOutcome ? ' (' + last.foulOutcome.charAt(0).toUpperCase() + last.foulOutcome.slice(1) + ')' : ''}`;
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
    // Note text line
    if (last.type === EventType.NOTE) {
      const nLine = document.createElement('div');
      nLine.className = 'text-gray-300 text-sm';
      nLine.textContent = last.noteText;
      details.appendChild(nLine);
    }
    // Append details to wrapper
    wrapper.appendChild(details);
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
    // Finish assembling right column and append to the wrapper
    wrapper.appendChild(rightCol);
    // Add an event‑list button positioned at the bottom right of the card.  This
    // button shows an icon of three bars.  The fill‑current attribute makes
    // the SVG adopt the current text colour (blue) from the class below.
    const listBtn = document.createElement('button');
    listBtn.id = 'show-events-btn';
    listBtn.className = 'absolute bottom-2 right-2 text-blue-400';
    listBtn.title = 'Show all events';
    listBtn.innerHTML = '<img src="icons/burger.svg" alt="Show all events" class="w-6 h-6" />';
    wrapper.appendChild(listBtn);
    display.appendChild(wrapper);
    display.classList.remove('hidden');
    // Attach click handler for the list button to open the events list modal
    listBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showEventsModal();
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
   * Show the Events list modal.  When the user taps the list button in the
   * last event display, the full chronological list of events appears in
   * this modal.  The list allows editing and deleting events as before.
   */
  function showEventsModal() {
    const modal = document.getElementById('events-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    // Render events list for current match
    const match = findMatchById(appState.currentMatchId);
    if (match) {
      renderEventsList(match);
    }
  }

  /**
   * Hide the Events list modal.
   */
  function hideEventsModal() {
    const modal = document.getElementById('events-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    // When closing the events modal, reveal the last event display again
    const lastDisplay = document.getElementById('last-event-display');
    if (lastDisplay) lastDisplay.classList.remove('hidden');
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
    // Only allow scoring during playing periods
    if (!isPlayingPeriod(match.currentPeriod)) {
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
        btn.className = 'w-full text-left p-2 rounded-lg text-sm mb-1';
        
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
        btn.className = 'w-full text-left p-2 rounded-lg text-sm mb-1';
        
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
        btn.className = 'w-full text-left p-2 rounded-lg text-sm';
        
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
    noneBtn.className = 'w-full text-left p-2 rounded-lg text-sm mb-1 bg-gray-700 text-gray-100';
    noneBtn.innerHTML = `<div class="flex items-center space-x-2"><span class="w-6 h-6 flex items-center justify-center bg-gray-600 rounded-full">--</span><span>None</span></div>`;
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
      btn.innerHTML = `<div class="flex items-center space-x-2"><span class="w-6 h-6 flex items-center justify-center bg-gray-600 rounded-full">${p.jerseyNumber}</span><span>${p.name}</span></div>`;
      btn.className = 'w-full text-left p-2 rounded-lg text-sm mb-1 bg-gray-700 text-gray-100';
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
      const header = document.createElement('h3');
      header.textContent = team.name;
      header.className = 'text-lg font-semibold text-gray-100 mb-1';
      sec.appendChild(header);
      // Sort players numerically by jersey number for consistency.
      const playersSorted = [...team.players].sort((a, b) => a.jerseyNumber - b.jerseyNumber);
      playersSorted.forEach((player) => {
        const row = document.createElement('div');
        // Row styling: display label and input horizontally
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
        // Dark mode styling for player name input
        input.className = 'flex-1 p-2 border rounded bg-gray-700 text-gray-100 border-gray-600';
        row.appendChild(label);
        row.appendChild(input);
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
    // Display the edit players view
    showView('edit-players-view');
  }

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
      // Use a card‑like appearance with border and subtle hover effect.  The
      // overall layout uses flex with space between the left details and
      // right‑aligned time/period/actions.
      item.className =
        'event-item px-4 py-3 mb-2 flex justify-between items-start cursor-pointer bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg';
      // Left column (details)
      const details = document.createElement('div');
      details.className = 'event-details flex-1';
      // Right column (time and actions)
      const rightCol = document.createElement('div');
      rightCol.className = 'event-right flex flex-col items-end ml-4 flex-shrink-0';
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
        outcomeText = `Foul${ev.foulOutcome ? ' (' + ev.foulOutcome.charAt(0).toUpperCase() + ev.foulOutcome.slice(1) + ')' : ''}`;
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
      // For note events, show note text on separate line
      if (ev.type === EventType.NOTE) {
        const noteLine = document.createElement('div');
        noteLine.className = 'text-gray-300 text-sm';
        noteLine.textContent = ev.noteText;
        details.appendChild(noteLine);
      }
      // Append left column to item
      item.appendChild(details);
      // Build right column: time/period and delete button
      const timeDiv = document.createElement('div');
      timeDiv.className = 'text-gray-200 text-sm font-medium';
      timeDiv.textContent = timeStr;
      rightCol.appendChild(timeDiv);
      const periodDiv = document.createElement('div');
      periodDiv.className = 'text-gray-400 text-xs';
      periodDiv.textContent = ev.period;
      rightCol.appendChild(periodDiv);
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
        '<img src="icons/delete.svg" alt="Add Match" class="w-8 h-8" />';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this event?')) {
          match.events = match.events.filter((m) => m.id !== ev.id);
          updateScoreboard(match);
          renderEventsList(match);
          saveAppState();
        }
      });
      // Append the time/period column and the delete button to the event item.  The
      // item is marked as relative so the absolute positioning works correctly.
      item.appendChild(rightCol);
      item.appendChild(delBtn);
      item.classList.add('relative');
      list.appendChild(item);
      // Attach click handler to edit event when clicking on list item (excluding delete button)
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
    // If the event being edited is a shot, use the scoring modal instead of the generic form
    if (ev.type === EventType.SHOT) {
      // Determine which team key this event belongs to
      const teamKey = ev.teamId === match.team1.id ? 'team1' : 'team2';
      showScoreModal(teamKey, ev.shotOutcome, {
        shotType: ev.shotType,
        playerId: ev.player1Id != null ? ev.player1Id : null,
        isEdit: true,
        eventId: ev.id
      });
      return;
    }
    appState.editingEventId = eventId;
    // Populate edit fields based on existing event
    const fieldsContainer = document.getElementById('edit-event-fields');
    fieldsContainer.innerHTML = '';
    renderEditEventFields(ev);
    // Show modal
    const modal = document.getElementById('edit-event-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
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
    renderLastEvent(match);
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
    // Add match button
    document.getElementById('add-match-btn').addEventListener('click', showAddMatchForm);
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

    // Edit event modal buttons
    const saveEditEventBtn = document.getElementById('save-edit-event-btn');
    if (saveEditEventBtn) saveEditEventBtn.addEventListener('click', saveEditedEvent);
    const cancelEditEventBtn = document.getElementById('cancel-edit-event-btn');
    if (cancelEditEventBtn) cancelEditEventBtn.addEventListener('click', cancelEditEvent);

    // Close events list modal button
    const closeEventsBtn = document.getElementById('close-events-modal-btn');
    if (closeEventsBtn) {
      closeEventsBtn.addEventListener('click', () => hideEventsModal());
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
          } else {
            // For other event types, show the general add event modal with preselected type
            showAddEventModal(teamKey);
            // Set the event type in the modal
            const eventTypeSelect = document.getElementById('event-type');
            if (eventTypeSelect) {
              // Map our event types to the existing event type values
              const eventTypeMap = {
                'foul': 'foulConceded',
                'kickout': 'kickout', 
                'sub': 'substitution',
                'note': 'note',
                'card': 'card'
              };
              eventTypeSelect.value = eventTypeMap[eventType] || eventType;
              renderEventFields(eventTypeSelect.value);
            }
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
  function init() {
    loadAppState();
    renderMatchList();
    initEventListeners();
    // Hide the header by default since the list view does not display a title.  It will
    // be shown again when opening match details via showView().
    const header = document.querySelector('header');
    if (header) header.style.display = 'none';
  }

  // Kick off once DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();