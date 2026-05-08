# MoodSync — Live Itinerary Rescue Assistant

**Vertical:** Time-Crunched Weekend Explorer

MoodSync is a dynamic travel assistant that doesn't just *plan* your day — it *heals* it. When weather shifts, traffic spikes, venues close, or your energy dips, MoodSync autonomously detects the problem and proposes a real, constraint-aware fix using live Google data and Gemini intelligence.

## How It Works

1. **Share your location** (optional) — browser geolocation captures your starting point
2. **Enter a destination city and interests** — "Delhi" + "coffee, museums, street food"
3. **MoodSync builds a live itinerary** — fetching candidates from Google Places, calculating routes via Google Routes, checking weather via Google Weather, and selecting the best stops with Gemini
4. **Pulse checks run every 5 minutes** — if a route gets blocked, rain threatens an outdoor stop, or a venue is closed, MoodSync alerts you
5. **The Pivot** — MoodSync finds nearby alternatives, sends them to Gemini with your hard constraints (rating ≥ threshold, transit ≤ max minutes, indoor if raining), and proposes the winning swap
6. **Low Battery mode** — tap to switch energy mode and MoodSync replaces high-effort stops with cafés and galleries

## Google Services Used

| Service | Purpose |
|---|---|
| **Google Places API (Text Search)** | Find real candidate stops in the destination city |
| **Google Places API (Nearby Search)** | Find pivot alternatives near a compromised stop |
| **Google Places Photos** | Display real venue photos in the UI |
| **Google Routes API** | Calculate live transit/drive/walk durations between stops |
| **Google Weather API (Current)** | Check real-time precipitation risk |
| **Google Weather API (Forecast)** | Per-stop hourly rain prediction badges |
| **Google Geocoding API** | Resolve destination city to coordinates + viewport |
| **Google Maps Embed API** | Route preview in the UI |
| **Google Maps JavaScript API** | Numbered markers with bounds fitting |
| **Gemini API** | Itinerary selection + pivot decision engine |

API keys are **never exposed** to the browser. `server.js` acts as a secure backend proxy.

## Decision Logic

MoodSync applies hard constraints before proposing a fix:

- Place rating must meet the user's minimum threshold
- Route time must stay under the user's max hop time
- Rain conflicts prefer indoor venues
- Closed venues are auto-flagged as conflicts
- Low Battery mode prefers calmer stops (cafés, galleries, bookstores)
- Gemini receives only real candidate data and must return JSON with one winning `place_id`
- A local deterministic engine serves as a guardrail if Gemini returns incomplete results

## Key Features

- **Live pulse checks** — routes, weather, and conflicts refresh every 5 minutes
- **Hourly weather forecast** — per-stop rain prediction badges (☀️ / 🌧)
- **Opening hours awareness** — closed venues auto-trigger pivot suggestions
- **Trip summary dashboard** — total stops, time span, transit time, avg rating, indoor/outdoor split
- **Share & export** — Web Share API or clipboard export with Google Maps links per stop
- **Google Maps navigation** — direct "Navigate" links from each stop
- **Dark mode** — respects system preference + manual toggle with localStorage persistence
- **Accessibility** — WCAG 2.2 AA: skip-to-content link, focus-visible outlines, ARIA roles/labels/live regions, keyboard navigation (Escape to close modals), `prefers-reduced-motion` support, 44px touch targets
- **Dynamic vibe slider** — High Energy ↔ Low Battery mood switching

## Setup & Deployment

Create a `.env` file (see `.env.example`):

```
GOOGLE_MAPS_API_KEY=your_google_maps_platform_key
GOOGLE_MAPS_BROWSER_KEY=your_http_referrer_restricted_maps_js_key
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
```

Enable these APIs in Google Cloud Console:

- Places API (New)
- Geocoding API
- Routes API
- Weather API
- Maps Embed API
- Maps JavaScript API

Use a separate browser key for `GOOGLE_MAPS_BROWSER_KEY`, restricted by HTTP referrer (e.g., `http://localhost:4173/*` and your Cloud Run URL) and limited to Maps JavaScript API only.

### Deploying to Google Cloud Run

MoodSync is fully stateless and runs perfectly on Cloud Run:

```bash
gcloud run deploy moodsync --source . --region us-central1 --allow-unauthenticated \
  --set-env-vars GOOGLE_MAPS_API_KEY=...,GEMINI_API_KEY=...,GOOGLE_MAPS_BROWSER_KEY=...
```

**CRITICAL AFTER DEPLOY**: You MUST go to your Google Cloud Console and add your new Cloud Run URL (e.g., `https://moodsync-*.a.run.app/*`) to the "Website Restrictions" list for your `GOOGLE_MAPS_BROWSER_KEY`. If you leave it as just `localhost`, the map will fail to load in production!

## Run

```bash
npm start
```

Open `http://localhost:4173`. No dependency install required — the app uses Node built-ins plus browser HTML/CSS/JS.

## Test

```bash
npm test
```

8 tests cover the deterministic decision engine: rain/indoor selection, low-battery café preference, traffic conflicts, constraint violations, explanation quality, plan ranking with closed-venue penalties, and edge cases.

## Assumptions

- Users provide their own API keys and keep them outside source control
- Weather forecast API gracefully degrades if not enabled
- The repository stays small by avoiding frameworks, bundled assets, and installed packages
- Browser geolocation is optional — users can enter any destination city manually
