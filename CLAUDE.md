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
- **Service Worker Updates**: When modifying cached files, increment the cache version in `sw.js` (currently v1.2.4)
- **Icon Generation**: Use `create-icons.html` for creating and testing new SVG icons
- **Deployment Context**: App is scoped to `/MatchTrackerPWA/` path (defined in manifest.json)

## Architecture

This is a vanilla JavaScript single-page application with no external dependencies:

### Core Files
- **index.html** - Single HTML file containing all views and modals (~860 lines)
- **script.js** - All JavaScript logic in IIFE pattern (~6300+ lines)
- **styles.css** - Mobile-first CSS with Tailwind-like utilities and custom components
- **tailwind-minimal.css** - Local Tailwind CSS subset for offline functionality
- **sw.js** - Service worker for PWA caching (cache version: v1.2.4)
- **manifest.json** - PWA manifest with app shortcuts and icons

### View Architecture
JavaScript-controlled section visibility system using classes:
- **Home view** - Navigation hub with three main buttons (`#home-view`)
- **Match list view** - Browse all matches (`#match-list-view`)
- **Match form view** - Create/edit matches (`#match-form-view`)
- **Match details view** - Live tracking interface (`#match-details-view`)
- **Edit players view** - Team roster management (`#edit-players-view`)
- **Events view** - Full event history for a match (`#events-view`)
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
│                                       └→ Edit Players → Player Selection
│                                       └→ Statistics Modal
├── Player Panels → Panel Editor
└── Export/Import Data → Data Management Modal
```

## Key Features

- **Match Management**: Create, edit, and track multiple matches
- **Timer System**: Period-based timer (1st Half, Half Time, 2nd Half, Extra Time, etc.)
- **Scoring**: Goals, points, and two-pointers (for football) with different shot types
- **Event Tracking**: Cards, fouls, kickouts, substitutions, notes
- **Player Management**: Auto-generated player rosters (1-30 for each team)
- **Player Panels**: Create reusable player rosters that can be assigned to teams across multiple matches
- **Match Statistics**: View detailed shooting accuracy, scorers breakdown, and team statistics
- **Data Management**: Export all matches to JSON file and import backups
- **Data Persistence**: Dual storage strategy with localStorage primary and IndexedDB fallback

## Match Types & Scoring

- **Football/Ladies Football**: Goals (3 points), Points (1 point), Two-pointers (2 points)
- **Hurling/Camogie**: Goals (3 points), Points (1 point)

## Code Structure & Patterns

### JavaScript Architecture (script.js)
The entire application logic is contained in a single IIFE (Immediately Invoked Function Expression):

- **Enumerations**: Defined at the top (MatchPeriod, EventType, ShotOutcome, ShotType, CardType, etc.)
- **State Management**: All data stored in browser localStorage with automatic persistence
- **Event System**: Comprehensive event logging with timestamps and match periods
- **Function Organization**: ~121 functions organized by feature area:
  - Match CRUD operations
  - Timer management and period transitions  
  - Event recording (shots, fouls, cards, substitutions, notes)
  - Score calculation and display
  - Player management
  - UI rendering and view switching

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
Matches are stored in localStorage with this structure:
- Match metadata (teams, competition, date, venue, referee, match type)
- Timer state (current period, elapsed time, running status)
- Events array (shots, fouls, cards, substitutions, notes)
- Player rosters for both teams

### Player Panel Data
Player panels are stored separately and can be reused across matches:
- Panel metadata (id, name, creation timestamp)
- Players array (jersey number, name, position)
- Panels are stored in `playerPanels` key in localStorage

### Storage Architecture
The app uses a dual-storage strategy via `StorageManager`:
- **Primary**: localStorage (faster, ~5-10MB quota)
- **Fallback**: IndexedDB (larger quota, used when localStorage is full)
- All saves attempt localStorage first, then automatically fall back to IndexedDB
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
- **State persistence**: Timer state saved to localStorage on every update
- **Period-sensitive UI**: Event buttons disabled during non-playing periods (Half Time, Full Time, etc.)

### Event Recording Architecture
Events are stored as objects with this structure:
```javascript
{
  id: timestamp,
  type: EventType.SHOT, // or CARD, FOUL_CONCEDED, etc.
  team: 1 or 2,
  player: playerObject,
  period: MatchPeriod.FIRST_HALF,
  matchTime: "15:30",
  // Event-specific data (e.g., shotOutcome, cardType, etc.)
}
```

### Player Management System
- **Auto-generation**: 30 players per team (jerseyNumber 1-30)
- **Naming convention**: "Player 1", "Player 2", etc. (editable)
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

### Data Management Features
- **Export**: Download all matches and player panels as a single JSON file
- **Import**: Restore data from backup JSON files
- **Storage Info**: View current localStorage usage and available space
- **Backup Strategy**: Users can manually export data before localStorage fills up

## Important Implementation Guidelines

### File Management
- This is a **single-file application** - avoid creating new files unless absolutely necessary
- All logic is contained in existing files: `index.html`, `script.js`, `styles.css`
- NEVER split code into multiple files or create new modules
- ALWAYS prefer editing existing files to maintain the vanilla JS architecture

### Development Workflow
- Test changes by opening `index.html` in browser (no build step required)
- For PWA features, use localhost or HTTPS (service worker requirement)
- When modifying cached files, increment cache version in `sw.js` (currently v1.2.4)
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
- **LocalStorage persistence**: All data is stored in browser localStorage with automatic saving
- **Mobile-first design**: All UI components are optimized for touch interaction