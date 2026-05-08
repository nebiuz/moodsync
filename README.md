# MoodSync

MoodSync is a live travel assistant for the **Time-Crunched Weekend Explorer** vertical. It is built for a traveler who has limited time, prefers highly rated local places, and needs the itinerary to repair itself when routes, weather, or energy change.

## Core Idea

Most travel apps generate a plan once. MoodSync keeps checking whether that plan still works.

The app asks for interests, start time, stop count, rating threshold, travel mode, and max travel hop. A city or area is optional if the user allows browser location access. MoodSync sends the browser-provided latitude, longitude, accuracy, and capture time to the backend so Gemini can reason from the user's real starting point.

## Google Services Used

- **Google Places API Text Search New:** finds real candidate stops for the user’s city and interests.
- **Google Routes API:** calculates live route duration between itinerary stops.
- **Google Weather API:** checks current precipitation risk for outdoor stops.
- **Gemini API:** selects the itinerary and chooses the best pivot option from real Places candidates.
- **Google Maps Embed:** previews the current route in the UI.
- **Browser Geolocation API:** captures the user's current position after permission and passes it into Gemini context.

API keys are never exposed in browser JavaScript. `server.js` acts as a small backend proxy.

## Decision Logic

MoodSync applies hard constraints before proposing a fix:

- place rating must meet the user’s minimum rating
- route time must stay under the user’s max hop time
- rainy conflicts prefer indoor places
- Low Battery mode prefers calmer stops like cafes, galleries, bookstores, and museums
- Gemini receives only real candidate places and must return JSON with one winning `place_id`

The local decision engine remains as a deterministic guardrail and test target if Gemini returns incomplete JSON.

## Setup

Create a `.env` or export these variables before running:

```bash
export GOOGLE_MAPS_API_KEY="your_google_maps_platform_key"
export GOOGLE_MAPS_BROWSER_KEY="your_http_referrer_restricted_maps_javascript_key"
export GEMINI_API_KEY="your_gemini_api_key"
export GEMINI_MODEL="gemini-2.5-flash"
```

The Google key should have these APIs enabled in Google Cloud:

- Places API
- Geocoding API
- Routes API
- Weather API
- Maps Embed API
- Maps JavaScript API

Use a separate browser key for `GOOGLE_MAPS_BROWSER_KEY`. Restrict it by HTTP referrer, for example `http://localhost:4173/*`, and restrict it to Maps JavaScript API only.

## Run

```bash
npm start
```

Open `http://localhost:4173`.

No dependency install is required; the app uses Node built-ins plus browser HTML/CSS/JS.

## Test

```bash
npm test
```

Tests cover the deterministic pivot guardrail: rain must choose indoor places, Low Battery mode should favor a nearby cafe, and invalid long-distance options are rejected.

## Demo Flow

1. Share your location if you want first-hop context.
2. Enter a destination city/area, interests, trip vibe, number of places, travel mode, and search area.
3. Run **Pulse check now** to refresh routes and weather.
4. Use **Refresh ideas** to request a different live set of places.
5. Switch to **Low Battery** to force a mood conflict.
6. Review Gemini’s pivot recommendation and accept it.

## Assumptions

- Users provide their own API keys and keep them outside source control.
- Current weather is enough for the hackathon demo; forecast-aware scheduling can be added with Google Weather forecast endpoints.
- The repository remains small because it avoids frameworks, bundled assets, and installed packages.
