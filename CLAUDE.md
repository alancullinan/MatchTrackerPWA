# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MatchTrackerPWA is a mobile-friendly Progressive Web App for tracking Gaelic sports matches (Football, Hurling, Ladies Football, Camogie). The app provides real-time match tracking with timers, scoring, player management, and event logging.

## Development Commands

Since this is a vanilla JavaScript PWA with no build system:

- **Local Development**: Open `index.html` directly in browser or use a local server:
  - `python -m http.server 8000` (Python)
  - `npx live-server` (if live-server is installed)
  - `php -S localhost:8000` (PHP)
- **Testing PWA Features**: Must use HTTPS or localhost for service worker functionality
- **Tests**: `npm install` once, then `npm test` runs `test/sw-upgrade.test.js` and `test/storage.test.js` (individually: `npm run test:sw`, `npm run test:storage`). Puppeteer is the ONLY dependency in the project and it is test tooling - the app itself remains a zero-dependency vanilla PWA with no build step, and nothing from `node_modules` is ever served to a browser.
  - The suite covers the service worker **upgrade path**, because every serious caching bug here has been an upgrade bug: the app worked perfectly on a fresh install while serving a stale version forever to anyone who already had it. It installs an "old" release, deploys a "new" one, and asserts the client actually ends up running the new code. It serves a temp copy, never the working tree.
  - **Run it before any change to `sw.js` or the SW registration in `index.html`.** Both regressions that shipped (cache-first navigations, and a missing `ignoreSearch`) are covered - each was verified by reintroducing the bug and confirming the suite fails.
  - `test/storage.test.js` covers the **storage layer**, for the same reason: the dual-store data-loss bug only appeared on a device that already had data, never on a fresh install. It pins the original bug (a save masked by a stale localStorage copy), the one-time migration, its idempotence, and - most importantly - that a migration which cannot verify leaves localStorage intact. Each assertion was verified by reintroducing the corresponding bug. **Run it before any change to `StorageManager`.**
  - `test/backup.test.js` covers the **export path**, the only thing protecting against a lost or replaced phone. It stubs Web Share to pin that a completed share records `lastBackupAt` and hands over one round-trippable `.json`, that a **dismissed** share (AbortError) records nothing - otherwise the staleness indicator would claim a backup that never left the device - and that the download fallback still works. Verified by reintroducing each bug.
  - All three suites need `window.__mtTest` (the small test seam at the bottom of `script.js`) to reach code inside the IIFE.
- **Service Worker Updates**: When modifying cached files, increment `CACHE_NAME` in `sw.js` (currently v2.5.0) **and** bump the matching `?v=` query strings on `script.js`, `styles.css` and `tailwind-minimal.css` in `index.html`. Both are required: `caches.match()` keys on the full URL including the query string, so an unchanged `?v=` serves the old file from cache no matter what the cache version says
- **Icon Generation**: Use `create-icons.html` for creating and testing new SVG icons
- **Deployment Context**: Served from the root of `matchtracker.club` via GitHub Pages (custom domain set by the `CNAME` file at the repo root; `start_url` and `scope` in manifest.json are `/`). Deploys on push to `main` — no build step. The service worker registers `/sw.js` and precaches root-absolute paths, which only resolve correctly at a domain root; do not move the app back to a subpath without making those paths relative

## Architecture

This is a vanilla JavaScript single-page application with no external dependencies:

### Core Files
- **index.html** - Single HTML file containing all views and modals (~860 lines)
- **script.js** - All JavaScript logic in IIFE pattern (~6300+ lines)
- **styles.css** - Mobile-first CSS with Tailwind-like utilities and custom components
- **tailwind-minimal.css** - Local Tailwind CSS subset for offline functionality
- **sw.js** - Service worker for PWA caching (cache version: v2.5.0)
- **manifest.json** - PWA manifest with app shortcuts and icons

### View Architecture
JavaScript-controlled section visibility system using classes:
- **Home view** - Navigation hub with three main buttons (`#home-view`)
- **Match list view** - Browse all matches (`#match-list-view`)
- **Match form view** - Create/edit matches (`#match-form-view`)
- **Match details view** - Live tracking interface (`#match-details-view`)
- **Edit players view** - Team roster management (`#edit-players-view`)
- **Events view** - Full event history for a match (`#events-view`)
- **Time/Period editor view** - Edit match time and period during tracking (`#time-period-editor-view`)
- **Player panels view** - Manage reusable player rosters (`#player-panels-view`)
- **Panel editor view** - Create/edit player panels (`#panel-editor-view`)
- **Player selection view** - Select players from panels (`#player-selection-view`)

Views are toggled via `showView(viewName)` function that manages display states.

### Navigation Flow
The app follows this navigation hierarchy:
```
Home View
├── Matches → Match List → Match Form (create/edit)
│                       └→ Match Details → Events View
│                                       └→ Time/Period Editor (tap timer)
│                                       └→ Edit Players → Player Selection
│                                       └→ Statistics Modal
├── Player Panels → Panel Editor
└── Export/Import Data → Data Management Modal
```

## Key Features

- **Match Management**: Create, edit, and track multiple matches
- **Timer System**: Period-based timer (1st Half, Half Time, 2nd Half, Extra Time, etc.)
- **Timer Editing**: Click timer display to open editor for adjusting match time and period during live tracking
- **Scoring**: Goals, points, and two-pointers (for football) with different shot types
- **Event Tracking**: Cards, fouls, kickouts, substitutions, notes, period end events
- **Event Chronological Sorting**: Events always display in correct chronological order (by period + time), even after time/period edits
- **Event Sharing**: Share individual events as 800x800px images for social media
- **Player Management**: Auto-generated player rosters (1-30 for each team)
- **Player Panels**: Create reusable 30-slot player rosters that can be assigned to teams across multiple matches
- **Panel Import**: Import an entire panel into a match team in one action from the Edit Players screen. Only offered before throw-in (`MatchPeriod.NOT_STARTED`); the button is hidden once the match starts, since relabelling players would rewrite the names shown against already-recorded events. Overwrites all 30 names in place — player `id`s are never regenerated, so events keep resolving correctly
- **Match Statistics**: View detailed shooting accuracy, scorers breakdown, and team statistics
- **Data Management**: Export all matches to JSON file and import backups
- **Data Persistence**: IndexedDB via `StorageManager`, with a one-time migration off the legacy localStorage store
- **Match Filtering**: Real-time text filtering of match list by team names or competition

## Match Types & Scoring

- **Football/Ladies Football**: Goals (3 points), Points (1 point), Two-pointers (2 points)
- **Hurling/Camogie**: Goals (3 points), Points (1 point)

## Code Structure & Patterns

### JavaScript Architecture (script.js)
The entire application logic is contained in a single IIFE (Immediately Invoked Function Expression):

- **Enumerations**: Defined at the top (MatchPeriod, EventType, ShotOutcome, ShotType, CardType, etc.)
- **State Management**: All data stored in IndexedDB with automatic persistence
- **Event System**: Comprehensive event logging with timestamps and match periods
- **Function Organization**: ~125+ functions organized by feature area:
  - Match CRUD operations
  - Timer management and period transitions
  - Event recording (shots, fouls, cards, substitutions, notes, period end events)
  - Score calculation and display
  - Player management
  - UI rendering and view switching
  - Event sharing (canvas-based image generation for social media)

### Key JavaScript Patterns
- **Period-based Logic**: `isPlayingPeriod()` function controls when events can be recorded
- **Team Differentiation**: Functions often take team parameters (1 or 2) for dual-team operations
- **Modal System**: Extensive use of modals for data entry with consistent open/close patterns
- **Event Delegation**: Click handlers attached to dynamically generated content
- **Responsive Updates**: Real-time UI updates when match state changes

### Modal Architecture
The app uses multiple specialized modals for different event types:
- **Score Event Modal** (`#score-event-modal`) - Goal/Point/Two-pointer recording with shot type and player selection
- **Foul Event Modal** (`#foul-event-modal`) - Foul type (free/penalty), card type, and player selection
- **Kickout Event Modal** (`#kickout-event-modal`) - Kickout outcome (won/lost) and player selection
- **Substitution Event Modal** (`#substitution-event-modal`) - Player off/on selection
- **Note Event Modal** (`#note-event-modal`) - Free-text note entry
- **Event Type Modal** (`#event-type-modal`) - Initial event type selector (miss/sub/foul/kickout/note)
- **Period Confirm Modal** (`#period-confirm-modal`) - Confirm period transitions
- **Match Stats Modal** (`#match-stats-modal`) - Display shooting accuracy and scorers
- **Data Management Modal** (`#data-management-modal`) - Export/import interface

All modals follow a consistent pattern: Cancel button (left), title (center), Done/Add button (right)

### CSS Structure (styles.css)
- **Mobile-first responsive design** with touch-optimized targets
- **Custom utility classes** mimicking Tailwind patterns
- **Component-based styling** for buttons, modals, forms
- **Dark theme throughout** (gray-900 background, blue accents)
- **Grid layouts** for match cards and statistics displays

## Data Structure

### Match Data
Matches are stored in IndexedDB with this structure:
- Match metadata (teams, competition, date, venue, referee, match type)
- Timer state (current period, elapsed time, running status)
- Events array (shots, fouls, cards, substitutions, notes)
- Player rosters for both teams

### Player Panel Data
Player panels are stored separately and can be reused across matches:
- Panel metadata (id, name, creation timestamp)
- Players array of **exactly 30 fixed slots** (`PANEL_SIZE`), mirroring a match roster: `{id, name, jerseyNumber}` where `jerseyNumber` is 1-30
- The slot **is** the jersey number, so duplicate numbers are impossible and a panel imports into a team 1:1
- Empty slots are meaningful and are preserved on save (names are never filtered out, and the list is never sorted alphabetically)
- `normalizePanel()` migrates legacy panels (which stored only `{id, name}`) into 30 slots, filling 1..N in stored order. It is idempotent and runs from `loadAppState()`, `DataManager.importData()`, and `showPanelEditor()`
- Panels are stored under the `playerPanels` key in IndexedDB

### Storage Architecture
The app uses **IndexedDB only**, via `StorageManager` (`MatchTrackerDB` / `matches` store, keyed by `key`).

It previously kept two stores - writing localStorage-first with an IndexedDB fallback, but *reading* localStorage-first. The stores are independent, so once localStorage hit quota, new saves diverted to IndexedDB while every launch kept returning the older localStorage copy: recently recorded matches vanished silently. **Do not reintroduce a second store** - a single store cannot have that bug. `test/storage.test.js` pins it.

- `saveData()` returns a **boolean**; it no longer swallows errors, and calls `showStorageWarning()` when a write genuinely fails
- `migrateFromLocalStorage()` runs once, before `loadAppState()` in `init()`. It writes all three keys, verifies them by reading back, and only then removes the localStorage originals - **never delete an unverified copy**. A `storageMigratedToIDB` flag (kept in localStorage) makes it idempotent
- `getStorageInfo()` uses `navigator.storage.estimate()`; `requestPersistence()` calls `navigator.storage.persist()` once at startup to reduce eviction risk
- Persistence is not eviction-proof: iOS clears storage for sites unused ~7 days, and a larger quota does not change that. Only an off-device export survives it
- Data is stored with timestamps for potential sync features

## UI Patterns

- Dark theme throughout (gray-900 background)
- Mobile-optimized touch targets
- Modal-based forms and event entry
- Real-time score updates
- Period-sensitive button states (disabled during non-playing periods)

## Critical Implementation Details

### Timer System
- **setInterval-based** timer with pause/resume functionality
- **Period transitions**: Automatic progression through match periods (1st Half → Half Time → 2nd Half → etc.)
- **State persistence**: Timer state saved to IndexedDB on every update
- **Period-sensitive UI**: Event buttons disabled during non-playing periods (Half Time, Full Time, etc.)
- **Live timer editing**: Click period/timer display to open editor view
  - Real-time sync: Timer continues running in background while editing
  - Time offset system: Adjustments (+/-) applied as offset to live match time
  - Cancel behavior: Restores original period only; time continues naturally
  - Warning: Static message about potential timeline discrepancies when adjusting time

### Event Recording Architecture
Events are stored as objects with this structure:
```javascript
{
  id: timestamp,
  type: EventType.SHOT, // or CARD, FOUL_CONCEDED, PERIOD_END, etc.
  teamId: teamId,
  player1Id: playerId,
  period: MatchPeriod.FIRST_HALF,
  timeElapsed: 900, // seconds
  // Event-specific data (e.g., shotOutcome, cardType, etc.)
}
```

**Event Sorting**: Events are sorted chronologically using `sortEventsByTime(events, reverse)`:
- Sorts by period order first (using `getPeriodOrder()` helper)
- Then by `timeElapsed` within each period
- `reverse = true` for event list view (newest first)
- `reverse = false` for export/share (oldest first, chronological)
- Ensures correct ordering even when time/period is edited

#### Period End Events
- Automatically created when ending a period (Half Time, Full Time, Extra Time Half Time, Match Over)
- Display format: Period name (e.g., "Half Time") with time elapsed from the period that just ended
- Show current match score at the time the period ended
- Created in `endPeriod()` function when transitioning to non-playing periods

### Player Management System
- **Auto-generation**: 30 players per team (jerseyNumber 1-30)
- **Naming convention**: `No.1`, `No.2`, etc. (editable). This exact `No.N` string is a load-bearing sentinel — many render paths compare a player's name against it to decide whether to show a name alongside the jersey number, so resets must write it verbatim
- **Event tracking**: Each player accumulates statistics from events
- **Substitution support**: Players can be substituted during matches
- **Player Panels**: Reusable rosters that can be created once and assigned to teams across multiple matches
- **Panel Selection**: When editing players, can import from existing panels or create new ones
- **Last Selected Panels**: App remembers which panel was last used for each team in each match

### PWA Features
- **Service Worker**: Caches all static assets for offline functionality
- **App Shortcuts**: "New Match" shortcut in manifest.json
- **Standalone mode**: Runs as a native-like app when installed
- **Orientation Lock**: Portrait-primary orientation enforced in manifest.json
- **Touch optimizations**: All interactions designed for mobile use

### Event Sharing Features
- **Canvas-based Image Generation**: Creates 800x800px images suitable for social media sharing
- **Share Buttons**: Available on individual events in the events list and on the last event card in match details
- **Share Image Content**:
  - Competition name at top
  - Event outcome with colored flags for scoring events (Goal=green, Point=white, 2 Pointer=orange)
  - Team name (prominent, 48px font)
  - Player information (jersey number and name)
  - Shot type or other event details
  - Time elapsed and period (except for period end events which only show time)
  - Current match score (shown for all event types)
- **Web Share API**: Uses native sharing on supported devices, falls back to file download
- **Running Score Calculation**: Each shared event shows the match score at that point in time

### Data Management Features
- **Export**: Share or download all matches and player panels as a single JSON file. Prefers `navigator.share()` (the share sheet), falling back to `<a download>` - a synthetic download click is unreliable in an installed iOS PWA, which is the app's main target. Filenames are timestamped to the minute so same-day exports cannot collide. Only a **completed** export sets `lastBackupAt`; a dismissed share sheet rejects with `AbortError` and is treated as a cancellation, not a backup
- **Import**: Restore data from backup JSON files
- **Storage Info**: View real usage and quota via `navigator.storage.estimate()`
- **Backup Strategy**: Users manually export data; the only defence against a lost, wiped or replaced device, since on-device storage (however durable) does not survive one. The Data Management modal shows when the last backup happened, and steers users to "Save to Files"/iCloud Drive rather than a chat app

### Match List Filtering
- **Real-time Search**: Filter input at top of match list
- **Search Criteria**: Matches team1 name, team2 name, or competition name
- **Case-insensitive**: Search is not case-sensitive
- **Instant Updates**: List updates as you type

## Important Implementation Guidelines

### File Management
- This is a **single-file application** - avoid creating new files unless absolutely necessary
- All logic is contained in existing files: `index.html`, `script.js`, `styles.css`
- NEVER split code into multiple files or create new modules
- ALWAYS prefer editing existing files to maintain the vanilla JS architecture

### Development Workflow
- Test changes by opening `index.html` in browser (no build step required)
- For PWA features, use localhost or HTTPS (service worker requirement)
- When modifying cached files, increment cache version in `sw.js` (currently v2.5.0)
- All changes take effect immediately - no compilation or build process

### Code Integration Patterns
- New functions should be added inside the existing IIFE in `script.js`
- Follow existing naming conventions and code organization
- Maintain the period-based logic system for all new event types
- Use existing modal patterns for any new UI interactions
- Follow the team parameter convention (1 or 2) for dual-team operations
- Use `StorageManager.saveData()` and `StorageManager.loadData()` for all data persistence
- When adding new modals, follow the existing pattern: Cancel/Done buttons at top, content in middle

### Critical Implementation Notes
- **No external dependencies**: Project uses only vanilla JavaScript, HTML, and CSS
- **Single HTML file**: All views and modals are contained in `index.html` (~860 lines)
- **IIFE architecture**: All JavaScript is wrapped in a single Immediately Invoked Function Expression
- **IndexedDB persistence**: All data is stored in IndexedDB with automatic saving
- **Mobile-first design**: All UI components are optimized for touch interaction