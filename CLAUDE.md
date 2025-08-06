# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MatchTrackerPWA is a mobile-friendly Progressive Web App for tracking Gaelic sports matches (Football, Hurling, Ladies Football, Camogie). The app provides real-time match tracking with timers, scoring, player management, and event logging.

## Architecture

This is a vanilla JavaScript single-page application with no build system or external dependencies:

- **index.html** - Single HTML file containing all views and modals
- **script.js** - All JavaScript logic (match management, timer, events, localStorage persistence)  
- **styles.css** - CSS styles optimized for mobile with dark theme
- **icons/** - SVG icons for various match events and UI elements
- **create-icons.html** - Utility for generating and testing icon designs

The app uses a view-based architecture with sections that are shown/hidden via JavaScript:
- Match list view (main screen)
- Match form view (create/edit matches)
- Match details view (live match tracking)
- Edit players view (team roster management)

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

## Development

Since this is a vanilla JavaScript app with no build system:

- **Testing**: Open index.html directly in a browser or use a local server (e.g., `python -m http.server` or `live-server`)
- **No build commands**: Files can be edited directly
- **Service Worker Updates**: When modifying cached files, update the cache version in sw.js
- **No package.json**: Uses local Tailwind CSS (tailwind-minimal.css) for offline functionality
- **Mobile-first**: Designed primarily for mobile devices
- **PWA Features**: Includes service worker (sw.js) for offline caching and manifest.json for app installation

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

## Technical Implementation

- **View Management**: JavaScript-controlled section visibility (view classes with display: none/block)
- **Timer System**: setInterval-based timer with pause/resume functionality and period transitions
- **Event System**: Comprehensive event logging with timestamps and detailed metadata
- **Data Export/Import**: JSON-based data management for backup and transfer
- **Service Worker**: Caches all static assets for offline functionality (cache version: v1.2.4)

## Core JavaScript Modules

- **Match Management**: CRUD operations for matches with localStorage persistence
- **Timer Logic**: Period-based match timing with automatic transitions
- **Event Recording**: Structured event logging (shots, cards, fouls, substitutions, notes)
- **Player Management**: Auto-generated 30-player rosters per team
- **Score Calculation**: Real-time score computation based on match type and events