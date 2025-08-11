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

## Architecture

This is a vanilla JavaScript single-page application with no external dependencies:

### Core Files
- **index.html** - Single HTML file containing all views and modals (5000+ lines)
- **script.js** - All JavaScript logic in IIFE pattern (~5500+ lines, 121+ functions)
- **styles.css** - Mobile-first CSS with Tailwind-like utilities and custom components
- **tailwind-minimal.css** - Local Tailwind CSS subset for offline functionality
- **sw.js** - Service worker for PWA caching (cache version: v1.2.4)
- **manifest.json** - PWA manifest with app shortcuts and icons

### View Architecture
JavaScript-controlled section visibility system using classes:
- **Match list view** - Main screen (`#match-list-view`)  
- **Match form view** - Create/edit matches (`#match-form-view`)
- **Match details view** - Live tracking interface (`#match-details-view`)
- **Edit players view** - Team roster management (`#edit-players-view`)

Views are toggled via `showView(viewName)` function that manages display states.

## Key Features

- **Match Management**: Create, edit, and track multiple matches
- **Timer System**: Period-based timer (1st Half, Half Time, 2nd Half, Extra Time, etc.)
- **Scoring**: Goals, points, and two-pointers (for football) with different shot types
- **Event Tracking**: Cards, fouls, kickouts, substitutions, notes
- **Player Management**: Auto-generated player rosters (1-30 for each team)
- **Data Persistence**: All data stored in browser localStorage

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

### CSS Structure (styles.css)
- **Mobile-first responsive design** with touch-optimized targets
- **Custom utility classes** mimicking Tailwind patterns
- **Component-based styling** for buttons, modals, forms
- **Dark theme throughout** (gray-900 background, blue accents)
- **Grid layouts** for match cards and statistics displays

## Data Structure

Matches are stored in localStorage with this structure:
- Match metadata (teams, competition, date, venue, referee, match type)
- Timer state (current period, elapsed time, running status)
- Events array (shots, fouls, cards, substitutions, notes)
- Player rosters for both teams

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

### PWA Features
- **Service Worker**: Caches all static assets for offline functionality
- **App Shortcuts**: "New Match" shortcut in manifest.json
- **Standalone mode**: Runs as a native-like app when installed
- **Touch optimizations**: All interactions designed for mobile use