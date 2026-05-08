import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseBestAlternative, rankPlacesForPlan } from "./src/services/decisionEngine.js";

const root = fileURLToPath(new URL(".", import.meta.url));
await loadDotEnv();
const port = Number(process.env.PORT ?? 4173);

/** @type {string} Unique build ID for cache-busting share links */
const BUILD_ID = Date.now().toString(36);

const config = {
  googleMapsKey: process.env.GOOGLE_MAPS_API_KEY,
  googleMapsBrowserKey: process.env.GOOGLE_MAPS_BROWSER_KEY,
  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
};

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

createServer(async (req, res) => {
  // Security headers on every response
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, statusFor(error), { error: error.message ?? "Unexpected server error" });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`MoodSync server running at http://127.0.0.1:${port}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      ready: Boolean(config.googleMapsKey && config.geminiKey),
      mapsBrowserKey: config.googleMapsBrowserKey ?? null,
      missing: [
        !config.googleMapsKey && "GOOGLE_MAPS_API_KEY",
        !config.geminiKey && "GEMINI_API_KEY",
      ].filter(Boolean),
      services: ["Google Geocoding", "Google Places", "Google Routes", "Google Weather", "Gemini"],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/place-photo") {
    requireKeys(["googleMapsKey"]);
    await proxyPlacePhoto(res, url);
    return;
  }

  assertMethod(req, "POST");
  const body = await readJson(req);

  if (url.pathname === "/api/plan") {
    requireKeys(["googleMapsKey", "geminiKey"]);
    sendJson(res, 200, await createPlan(body));
    return;
  }

  if (url.pathname === "/api/pulse") {
    requireKeys(["googleMapsKey"]);
    sendJson(res, 200, await pulseCheck(body));
    return;
  }

  if (url.pathname === "/api/pivot") {
    requireKeys(["googleMapsKey", "geminiKey"]);
    sendJson(res, 200, await resolvePivot(body));
    return;
  }

  if (url.pathname === "/api/share") {
    sendJson(res, 200, buildSharePayload(body));
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

async function createPlan(input) {
  const profile = normalizeProfile(input);
  const city = profile.city ? await resolveDestination(profile.city) : currentArea(profile.currentLocation);
  const candidates = await searchInterestCandidates(profile, city);
  const ranked = await selectPlanWithGemini({ profile, city, candidates });
  const stops = await hydrateSelectedStops({ selected: ranked, candidates, profile });
  const routes = await routeSegments(stops, profile);
  const weatherLocation = city?.location ?? profile.currentLocation;
  const [weather, forecast] = await Promise.all([
    currentWeather(weatherLocation),
    forecastWeather(weatherLocation),
  ]);
  const itinerary = attachRoutes(stops, routes).map((stop, index) => ({
    ...stop,
    insight: stop.insight ?? explainStop(stop, profile, routes[index]),
    openNow: stop.openNow ?? null,
    forecast: matchForecastToStop(stop, forecast),
  }));

  return {
    profile,
    city,
    weather,
    forecast: (forecast ?? []).slice(0, 6),
    insights: tripInsights({ itinerary, weather, profile }),
    itinerary,
    mapUrl: mapEmbedUrl(stops),
  };
}

async function pulseCheck({ itinerary, profile }) {
  if (!Array.isArray(itinerary) || itinerary.length < 1) {
    throw badRequest("itinerary is required");
  }

  const normalized = normalizeProfile(profile);
  const routes = await routeSegments(itinerary, normalized);
  const location = itinerary[0].location;
  const [weather, forecast] = await Promise.all([
    currentWeather(location),
    forecastWeather(location),
  ]);
  const updated = attachRoutes(itinerary, routes).map((stop, index) => ({
    ...stop,
    insight: explainStop(stop, normalized, routes[index]),
    forecast: matchForecastToStop(stop, forecast),
  }));
  const conflicts = detectConflicts({ itinerary: updated, weather, profile: normalized });

  return {
    weather,
    forecast: (forecast ?? []).slice(0, 6),
    itinerary: updated,
    conflicts,
    insights: tripInsights({ itinerary: updated, weather, profile: normalized }),
    status: conflicts.length ? "needs-pivot" : "healthy",
    mapUrl: mapEmbedUrl(updated),
  };
}

async function resolvePivot({ conflict, itinerary, profile, mood }) {
  if (!conflict || !Array.isArray(itinerary)) {
    throw badRequest("conflict and itinerary are required");
  }

  const normalized = normalizeProfile({ ...profile, mood: mood ?? profile?.mood });
  const target = itinerary.find((stop) => stop.id === conflict.stopId) ?? itinerary[0];
  const alternatives = await nearbyAlternatives({ conflict, target, profile: normalized });
  const decision = await choosePivotWithGemini({ conflict, alternatives, profile: normalized });
  const localDecision = chooseBestAlternative({
    alternatives,
    conflict,
    mood: normalized.mood,
    persona: normalized,
  });
  const chosenId = decision.place_id ?? localDecision.place_id;
  const winner = alternatives.find((place) => place.place_id === chosenId) ?? localDecision.winner;

  return {
    conflict,
    alternatives,
    decision: {
      ...decision,
      place_id: winner?.place_id ?? null,
      explanation: decision.explanation ?? localDecision.explanation,
    },
    winner,
  };
}

async function resolveDestination(cityName) {
  const geocoded = await geocodeDestination(cityName);
  if (geocoded) return geocoded;
  return findCity(cityName);
}

async function geocodeDestination(cityName) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", cityName);
  url.searchParams.set("key", config.googleMapsKey);
  const data = await fetchJson(url);
  const result = data.results?.find((item) =>
    (item.types ?? []).some((type) =>
      ["locality", "administrative_area_level_2", "administrative_area_level_1"].includes(type),
    ),
  );

  if (!result) return null;

  return {
    place_id: result.place_id,
    title: result.formatted_address,
    name: result.address_components?.[0]?.long_name ?? cityName,
    address: result.formatted_address,
    location: {
      latitude: result.geometry.location.lat,
      longitude: result.geometry.location.lng,
    },
    viewport: normalizeViewport(result.geometry.viewport),
    rating: 0,
    types: result.types ?? ["locality"],
    addressComponents: normalizeGeocodeAddressComponents(result.address_components ?? []),
    photos: [],
  };
}

async function findCity(cityName) {
  const data = await placesTextSearch({
    textQuery: cityName,
    fieldMask:
      "places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents",
    maxResultCount: 1,
  });
  const place = data.places?.[0];
  if (!place) throw badRequest(`No city found for "${cityName}"`);
  return normalizePlace(place);
}

/**
 * Search for candidate places matching the user's interests inside the
 * destination city.  When a city is specified we use `locationRestriction`
 * (hard fence) so Google Places never returns results outside the city —
 * this is the fix for the Gurgaon→Delhi bug.
 */
async function searchInterestCandidates(profile, city) {
  const batches = await Promise.all(
    profile.interests.map((interest) => {
      const body = {
        textQuery: profile.city ? `best ${interest} in ${profile.city}` : interest,
        fieldMask:
          "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.googleMapsUri,places.currentOpeningHours,places.photos,places.addressComponents",
        maxResultCount: 12,
      };

      // Use locationRestriction (hard boundary) when we have a destination city
      // so Places API cannot return results from the user's current city.
      if (profile.city && city?.viewport) {
        body.locationRestriction = {
          rectangle: toRectangle(expandViewport(city.viewport, profile.cityRadiusMeters)),
        };
      } else if (profile.city && city?.location) {
        body.locationRestriction = {
          rectangle: toRectangle(viewportFromCenter(city.location, profile.cityRadiusMeters)),
        };
      } else if (profile.currentLocation) {
        body.locationBias = {
          circle: {
            center: latLng(profile.currentLocation),
            radius: 5000,
          },
        };
      }

      return placesTextSearch(body);
    }),
  );

  const byId = new Map();
  for (const data of batches) {
    for (const place of data.places ?? []) {
      const normalized = normalizePlace(place);
      if (profile.city && !isInRequestedArea(normalized, profile, city)) continue;
      if ((normalized.rating ?? 0) >= profile.minRating) byId.set(normalized.place_id, normalized);
    }
  }

  const candidates = [...byId.values()];
  if (candidates.length < 2) {
    throw badRequest(
      `Not enough matching places found inside ${profile.city || "the selected area"}. Try broader interests, a lower rating, or a wider search area.`,
    );
  }
  return candidates;
}

async function selectPlanWithGemini({ profile, city, candidates }) {
  const prompt = {
    profile,
    currentUserLocation: profile.currentLocation,
    city,
    candidates: candidates.map(compactPlace),
    task:
      "Choose an efficient same-day itinerary inside the requested city/area. Do not replace the requested destination with currentUserLocation; use currentUserLocation only to reason about the first hop. Respect tripStyle, avoid repeating the same type too often, and prefer variety. Return only JSON: {\"stops\":[{\"place_id\":\"...\",\"scheduled_time\":\"HH:MM\",\"rationale\":\"...\"}]}",
  };
  const fallback = diversifyPlaces(
    rankPlacesForPlan({ places: rotateBySeed(candidates, profile.discoverySeed), profile }).sort(
      (a, b) => styleScore(b, profile.tripStyle) - styleScore(a, profile.tripStyle),
    ),
  )
    .slice(0, profile.stopCount)
    .map((place, index) => ({
      place_id: place.place_id,
      scheduled_time: addHours(profile.startTime, index * 2),
      rationale: "Selected because it matches rating, locality, and route-efficiency constraints.",
    }));

  const response = await geminiJson(prompt, { stops: fallback });
  const geminiStops = Array.isArray(response.stops) ? response.stops : [];
  return fillSelectedStops(geminiStops, fallback, profile.stopCount);
}

async function hydrateSelectedStops({ selected, candidates, profile }) {
  const byId = new Map(candidates.map((place) => [place.place_id, place]));
  const stops = selected
    .map((selection, index) => {
      const place = byId.get(selection.place_id);
      if (!place) return null;
      return {
        ...place,
        id: place.place_id,
        time: selection.scheduled_time || addHours(profile.startTime, index * 2),
        rationale: selection.rationale || "",
        insight: selection.rationale || explainStop(place, profile),
        energy: energyForTypes(place.types),
        indoor: isLikelyIndoor(place),
      };
    })
    .filter(Boolean);

  if (stops.length < profile.stopCount) {
    const selectedIds = new Set(stops.map((stop) => stop.place_id));
    const fallbackPlaces = diversifyPlaces(
      rankPlacesForPlan({ places: rotateBySeed(candidates, profile.discoverySeed), profile }),
    );
    for (const place of fallbackPlaces) {
      if (selectedIds.has(place.place_id)) continue;
      stops.push({
        ...place,
        id: place.place_id,
        time: addHours(profile.startTime, stops.length * 2),
        rationale: explainStop(place, profile),
        insight: explainStop(place, profile),
        energy: energyForTypes(place.types),
        indoor: isLikelyIndoor(place),
      });
      selectedIds.add(place.place_id);
      if (stops.length >= profile.stopCount) break;
    }
  }

  if (stops.length < 2) throw badRequest("Gemini did not return enough usable stops.");
  return stops.slice(0, profile.stopCount);
}

async function nearbyAlternatives({ conflict, target, profile }) {
  const includedTypes = typesForConflict(conflict, profile);
  const data = await placesNearbySearch({
    includedTypes,
    maxResultCount: 10,
    locationRestriction: {
      circle: {
        center: target.location,
        radius: 1800,
      },
    },
    fieldMask:
      "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.googleMapsUri,places.currentOpeningHours,places.photos,places.addressComponents",
  });

  const places = (data.places ?? [])
    .map(normalizePlace)
    .filter((place) => place.place_id !== target.place_id)
    .filter((place) => (place.rating ?? 0) >= profile.minRating);

  const routes = await Promise.all(
    places.map(async (place) => {
      const [route] = await routeSegments([target, place], profile);
      return {
        ...place,
        transitMinutes: route?.currentMinutes ?? 999,
        indoor: isLikelyIndoor(place),
        localSignal: localSignal(place),
        reason: explainAlternative(place, profile, route, conflict),
      };
    }),
  );

  return routes.filter((place) => place.transitMinutes <= profile.maxTransitMinutes);
}

async function choosePivotWithGemini({ conflict, alternatives, profile }) {
  return geminiJson(
    {
      userPersonaConstraints: profile,
      currentUserLocation: profile.currentLocation,
      conflict,
      googlePlacesAlternatives: alternatives.map(compactPlace),
      task:
        "Select the single best alternative that strictly follows the constraints. If currentUserLocation is present, factor the user's real position into the explanation and avoid awkward backtracking. Return only JSON with place_id, a two-sentence explanation, and an optional short reason_by_place object keyed by place_id.",
    },
    { place_id: null, explanation: "No compliant alternative was selected." },
  );
}

async function placesTextSearch({ fieldMask, ...body }) {
  return googlePost("https://places.googleapis.com/v1/places:searchText", body, { fieldMask });
}

async function placesNearbySearch({ fieldMask, ...body }) {
  return googlePost("https://places.googleapis.com/v1/places:searchNearby", body, { fieldMask });
}

async function proxyPlacePhoto(res, url) {
  const name = url.searchParams.get("name");
  const width = clamp(Number(url.searchParams.get("w") ?? 720), 240, 1200);
  if (!name || !name.startsWith("places/") || !name.includes("/photos/")) {
    throw badRequest("Valid Google Places photo name is required.");
  }

  const photoUrl = new URL(`https://places.googleapis.com/v1/${name}/media`);
  photoUrl.searchParams.set("key", config.googleMapsKey);
  photoUrl.searchParams.set("maxWidthPx", String(width));

  const response = await fetch(photoUrl);
  if (!response.ok) {
    throw Object.assign(new Error(`Photo fetch failed: ${response.statusText}`), {
      status: response.status,
    });
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(200, {
    "Content-Type": response.headers.get("content-type") ?? "image/jpeg",
    "Cache-Control": "public, max-age=86400",
  });
  res.end(body);
}

async function routeSegments(stops, profileOrMode = "TRANSIT") {
  const profile =
    typeof profileOrMode === "string"
      ? { travelMode: profileOrMode, maxTransitMinutes: 20 }
      : profileOrMode;
  const pairs = stops.slice(0, -1).map((origin, index) => [origin, stops[index + 1]]);
  return Promise.all(
    pairs.map(async ([origin, destination]) => {
      const data = await googlePost(
        "https://routes.googleapis.com/directions/v2:computeRoutes",
        {
          origin: waypoint(origin),
          destination: waypoint(destination),
          travelMode: profile.travelMode,
          computeAlternativeRoutes: false,
          languageCode: "en",
          units: "METRIC",
        },
        { fieldMask: "routes.duration,routes.distanceMeters,routes.localizedValues" },
      );
      const route = data.routes?.[0];
      return {
        from: origin.place_id,
        to: destination.place_id,
        currentMinutes: durationToMinutes(route?.duration),
        distanceMeters: route?.distanceMeters ?? null,
        status:
          durationToMinutes(route?.duration) > profile.maxTransitMinutes ? "blocked" : "clear",
      };
    }),
  );
}

async function currentWeather(location) {
  try {
    const url = new URL("https://weather.googleapis.com/v1/currentConditions:lookup");
    url.searchParams.set("key", config.googleMapsKey);
    url.searchParams.set("location.latitude", String(location.latitude));
    url.searchParams.set("location.longitude", String(location.longitude));
    const data = await fetchJson(url);
    return {
      description: data.weatherCondition?.description?.text ?? "Current conditions unavailable",
      precipitationProbability: data.precipitation?.probability?.percent ?? 0,
      precipitationType: data.precipitation?.type ?? "NONE",
      temperature: data.temperature,
    };
  } catch {
    return {
      description: "Weather data unavailable",
      precipitationProbability: 0,
      precipitationType: "NONE",
      temperature: null,
    };
  }
}

/**
 * Fetch hourly weather forecast for the next 12 hours.
 * Falls back gracefully if the forecast endpoint is unavailable.
 */
async function forecastWeather(location) {
  try {
    const url = new URL("https://weather.googleapis.com/v1/forecast/hours:lookup");
    url.searchParams.set("key", config.googleMapsKey);
    url.searchParams.set("location.latitude", String(location.latitude));
    url.searchParams.set("location.longitude", String(location.longitude));
    url.searchParams.set("hours", "12");
    const data = await fetchJson(url);
    return (data.forecastHours ?? []).map((hour) => ({
      time: hour.interval?.startTime ?? null,
      description: hour.weatherCondition?.description?.text ?? "",
      precipitationProbability: hour.precipitation?.probability?.percent ?? 0,
      temperature: hour.temperature,
      icon: hour.weatherCondition?.type ?? "CLEAR",
    }));
  } catch {
    return null;
  }
}

/**
 * Match a forecast hour to a stop's scheduled time.
 * Returns the closest forecast entry or null.
 */
function matchForecastToStop(stop, forecast) {
  if (!forecast || !stop.time) return null;
  const [h, m] = stop.time.split(":").map(Number);
  const stopMinutes = h * 60 + (m || 0);
  let best = null;
  let bestDiff = Infinity;
  for (const entry of forecast) {
    if (!entry.time) continue;
    const date = new Date(entry.time);
    const entryMinutes = date.getHours() * 60 + date.getMinutes();
    const diff = Math.abs(entryMinutes - stopMinutes);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
  }
  return best;
}

async function googlePost(url, body, { fieldMask }) {
  return fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.googleMapsKey,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
  });
}

async function geminiJson(payload, fallback) {
  const model = config.geminiModel.startsWith("models/")
    ? config.geminiModel
    : `models/${config.geminiModel}`;
  const data = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.geminiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are MoodSync's decision engine. Follow constraints strictly. Return valid JSON only, with no markdown.",
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    },
  );
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";
  return parseJsonObject(text) ?? fallback;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? parseJsonObject(text) : {};
  if (!response.ok) {
    const message = data?.error?.message ?? data?.message ?? response.statusText;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function detectConflicts({ itinerary, weather, profile }) {
  const conflicts = [];
  itinerary.forEach((stop) => {
    if (stop.routeToNext?.status === "blocked") {
      conflicts.push({
        kind: "traffic",
        stopId: stop.id,
        message: `Route after ${stop.title} exceeds ${profile.maxTransitMinutes} minutes.`,
      });
    }
    // Check per-stop forecast first, then fall back to current weather
    const rainProb = stop.forecast?.precipitationProbability ?? weather.precipitationProbability;
    if (!stop.indoor && rainProb >= 40) {
      conflicts.push({
        kind: "rain",
        stopId: stop.id,
        message: `${stop.title} is outdoors and rain probability is ${rainProb}% at ${stop.time || "scheduled time"}.`,
      });
    }
    // Opening hours conflict
    if (stop.openNow === false) {
      conflicts.push({
        kind: "closed",
        stopId: stop.id,
        message: `${stop.title} is currently closed.`,
      });
    }
  });
  return conflicts;
}

function tripInsights({ itinerary, weather, profile }) {
  const blocked = itinerary.filter((stop) => stop.routeToNext?.status === "blocked").length;
  const avgRating =
    itinerary.reduce((sum, stop) => sum + Number(stop.rating || 0), 0) / Math.max(1, itinerary.length);
  const routeMinutes = itinerary.reduce(
    (sum, stop) => sum + Number(stop.routeToNext?.currentMinutes || 0),
    0,
  );

  return [
    {
      label: "Route pressure",
      value: blocked ? `${blocked} risk` : "Clear",
      tone: blocked ? "warning" : "good",
    },
    {
      label: "Weather",
      value: `${weather.precipitationProbability}% rain`,
      tone: weather.precipitationProbability >= 40 ? "warning" : "good",
    },
    {
      label: "Taste match",
      value: `${avgRating.toFixed(1)} avg`,
      tone: avgRating >= profile.minRating ? "good" : "warning",
    },
    {
      label: "Route time",
      value: `${routeMinutes} min`,
      tone: "neutral",
    },
  ];
}

function explainStop(stop, profile, route) {
  const reasons = [];
  if ((stop.rating ?? 0) >= profile.minRating) reasons.push(`${Number(stop.rating).toFixed(1)} rating`);
  if (stop.indoor) reasons.push("weather-safe");
  if (route?.currentMinutes) reasons.push(`${route.currentMinutes} min next hop`);
  if (profile.currentLocation) reasons.push("planned from your location");
  if (stop.rationale) return stop.rationale;
  return `Suggested because it fits ${reasons.slice(0, 3).join(", ")}.`;
}

function explainAlternative(place, profile, route, conflict) {
  const parts = [];
  if ((place.rating ?? 0) >= profile.minRating) parts.push(`clears ${profile.minRating}+ rating`);
  if ((route?.currentMinutes ?? 999) <= profile.maxTransitMinutes) {
    parts.push(`${route.currentMinutes} min away`);
  }
  if (conflict.kind === "rain" && isLikelyIndoor(place)) parts.push("keeps you indoors");
  if (profile.mood === "low" && energyForTypes(place.types) === "low") parts.push("low-effort fit");
  return parts.length ? parts.join(" · ") : "closest compliant alternative";
}

function attachRoutes(stops, routes) {
  return stops.map((stop, index) => ({
    ...stop,
    routeToNext: routes[index] ?? null,
  }));
}

function normalizeProfile(input = {}) {
  const interests = Array.isArray(input.interests)
    ? input.interests
    : String(input.interests ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 1);

  const currentLocation = normalizeLocation(input.currentLocation);

  return {
    city: String(input.city ?? "").trim(),
    startTime: input.startTime || "10:00",
    stopCount: clamp(Number(input.stopCount ?? 4), 2, 12),
    maxTransitMinutes: clamp(Number(input.maxTransitMinutes ?? 20), 5, 90),
    minRating: clamp(Number(input.minRating ?? 4.5), 0, 5),
    mood: input.mood === "low" ? "low" : "high",
    tripStyle: normalizeTripStyle(input.tripStyle),
    travelMode: ["DRIVE", "WALK", "BICYCLE", "TRANSIT"].includes(input.travelMode)
      ? input.travelMode
      : "TRANSIT",
    interests: interests.length ? interests : ["coffee", "museum", "gallery", "park"],
    currentLocation,
    cityRadiusMeters: clamp(Number(input.cityRadiusMeters ?? 20000), 5000, 60000),
    discoverySeed: Number(input.discoverySeed ?? 0),
  };
}

function currentArea(location) {
  if (!location) {
    throw badRequest("Enter a city/area or allow current location access.");
  }

  return {
    place_id: "current_location",
    title: "Current location",
    name: "Current location",
    address: "Browser-provided location",
    location,
    rating: 0,
    types: ["locality"],
  };
}

function normalizePlace(place) {
  return {
    place_id: place.id,
    title: place.displayName?.text ?? "Unnamed place",
    name: place.displayName?.text ?? "Unnamed place",
    address: place.formattedAddress ?? "",
    location: place.location,
    rating: place.rating ?? 0,
    types: place.types ?? [],
    googleMapsUri: place.googleMapsUri ?? "",
    openNow: place.currentOpeningHours?.openNow ?? null,
    addressComponents: normalizeAddressComponents(place.addressComponents ?? []),
    photos: (place.photos ?? [])
      .map((photo) => photo.name)
      .filter(Boolean)
      .slice(0, 3),
  };
}

function fillSelectedStops(geminiStops, fallback, targetCount) {
  const seen = new Set();
  const selected = [];

  for (const stop of geminiStops) {
    if (!stop?.place_id || seen.has(stop.place_id)) continue;
    selected.push(stop);
    seen.add(stop.place_id);
    if (selected.length >= targetCount) return selected;
  }

  for (const stop of fallback) {
    if (!stop?.place_id || seen.has(stop.place_id)) continue;
    selected.push(stop);
    seen.add(stop.place_id);
    if (selected.length >= targetCount) return selected;
  }

  return selected;
}

function normalizeAddressComponents(components) {
  return components
    .flatMap((component) => [
      component.longText,
      component.shortText,
      ...(component.types ?? []),
    ])
    .filter(Boolean);
}

function normalizeGeocodeAddressComponents(components) {
  return components
    .flatMap((component) => [
      component.long_name,
      component.short_name,
      ...(component.types ?? []),
    ])
    .filter(Boolean);
}

function normalizeViewport(viewport) {
  if (!viewport?.northeast || !viewport?.southwest) return null;
  return {
    north: Number(viewport.northeast.lat),
    east: Number(viewport.northeast.lng),
    south: Number(viewport.southwest.lat),
    west: Number(viewport.southwest.lng),
  };
}

function requestedAreaTokens(inputCity, city) {
  const raw = `${inputCity} ${city?.name ?? ""} ${city?.address ?? ""}`.toLowerCase();
  const tokens = raw
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2)
    .filter(
      (token) =>
        ![
          "india",
          "france",
          "united",
          "states",
          "city",
          "area",
          "district",
          "province",
          "state",
        ].includes(token),
    );

  return [...new Set(tokens)];
}

function normalizeTripStyle(style) {
  const allowed = new Set(["balanced", "hidden-gems", "food-first", "culture-heavy", "shopping"]);
  return allowed.has(style) ? style : "balanced";
}

function rotateBySeed(items, seed) {
  if (!items.length) return items;
  const offset = Math.abs(Math.floor(seed || 0)) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function diversifyPlaces(places) {
  const result = [];
  const seenTypes = new Map();

  for (const place of places) {
    const type = primaryType(place);
    if ((seenTypes.get(type) ?? 0) < 2) {
      result.push(place);
      seenTypes.set(type, (seenTypes.get(type) ?? 0) + 1);
    }
  }

  for (const place of places) {
    if (!result.includes(place)) result.push(place);
  }

  return result;
}

function styleScore(place, style) {
  const types = new Set(place.types ?? []);
  if (style === "food-first") {
    return types.has("restaurant") || types.has("cafe") || types.has("bakery") ? 1 : 0;
  }
  if (style === "culture-heavy") {
    return types.has("museum") || types.has("art_gallery") || types.has("historical_landmark") ? 1 : 0;
  }
  if (style === "shopping") {
    return types.has("shopping_mall") || types.has("market") || types.has("store") ? 1 : 0;
  }
  if (style === "hidden-gems") {
    return types.has("tourist_attraction") ? -0.5 : 0.4;
  }
  return 0;
}

function primaryType(place) {
  const ignored = new Set(["point_of_interest", "establishment"]);
  return (place.types ?? []).find((type) => !ignored.has(type)) ?? "place";
}

function isInRequestedArea(place, profile, city) {
  if (!place.location) return false;

  if (city?.viewport && isInsideViewport(place.location, expandViewport(city.viewport, profile.cityRadiusMeters))) {
    return true;
  }

  if (city?.viewport) return false;

  if (city?.location) {
    const distance = distanceMeters(city.location, place.location);
    if (distance > profile.cityRadiusMeters) return false;
  }

  // FIX: construct placeText from the place's address, title, and address components
  const placeText = [
    place.address ?? "",
    place.title ?? "",
    place.name ?? "",
    ...(place.addressComponents ?? []),
  ].join(" ").toLowerCase();
  const tokens = requestedAreaTokens(profile.city, city);

  if (!tokens.length) return true;
  return tokens.some((token) => placeText.includes(token));
}

function expandViewport(viewport, radiusMeters) {
  const extraKm = Math.max(0, (radiusMeters - 12000) / 1000);
  const latPad = extraKm / 111;
  const centerLat = (viewport.north + viewport.south) / 2;
  const lngPad = extraKm / (111 * Math.max(0.2, Math.cos(toRadians(centerLat))));

  return {
    north: viewport.north + latPad,
    south: viewport.south - latPad,
    east: viewport.east + lngPad,
    west: viewport.west - lngPad,
  };
}

function isInsideViewport(location, viewport) {
  const lat = Number(location.latitude);
  const lng = Number(location.longitude);
  return lat <= viewport.north && lat >= viewport.south && lng <= viewport.east && lng >= viewport.west;
}

function compactPlace(place) {
  return {
    place_id: place.place_id,
    name: place.name ?? place.title,
    rating: place.rating,
    types: place.types,
    transitMinutes: place.transitMinutes,
    indoor: place.indoor ?? isLikelyIndoor(place),
    localSignal: place.localSignal ?? localSignal(place),
    reason: place.reason,
    address: place.address,
    photos: place.photos ?? [],
  };
}

function normalizeLocation(location) {
  if (!location) return null;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    accuracyMeters: Number.isFinite(Number(location.accuracyMeters))
      ? Number(location.accuracyMeters)
      : null,
    capturedAt: location.capturedAt ?? null,
  };
}

function waypoint(place) {
  if (place.place_id) return { placeId: place.place_id };
  return { location: { latLng: latLng(place.location) } };
}

function latLng(location) {
  return {
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

function distanceMeters(a, b) {
  const radius = 6371000;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRadians(value) {
  return (Number(value) * Math.PI) / 180;
}

function isLikelyIndoor(place) {
  const types = new Set(place.types ?? []);
  const outdoor = ["park", "campground", "tourist_attraction", "zoo", "amusement_park"];
  const indoor = ["museum", "art_gallery", "cafe", "restaurant", "book_store", "shopping_mall"];
  if (indoor.some((type) => types.has(type))) return true;
  if (outdoor.some((type) => types.has(type))) return false;
  return true;
}

function localSignal(place) {
  const touristHeavy = new Set(["tourist_attraction", "travel_agency"]);
  const types = place.types ?? [];
  const penalty = types.some((type) => touristHeavy.has(type)) ? 0.3 : 0;
  return Math.max(0, Math.min(1, (place.rating ?? 0) / 5 - penalty));
}

function energyForTypes(types = []) {
  if (types.includes("park") || types.includes("tourist_attraction")) return "high";
  if (types.includes("cafe") || types.includes("book_store")) return "low";
  return "medium";
}

function typesForConflict(conflict, profile) {
  if (profile.mood === "low" || conflict.kind === "low-battery") {
    return ["cafe", "book_store", "art_gallery", "museum"];
  }
  if (conflict.kind === "rain") return ["museum", "art_gallery", "cafe"];
  return ["museum", "art_gallery", "tourist_attraction", "cafe"];
}

function mapEmbedUrl(stops) {
  const query = stops.map((stop) => stop.title || stop.name).join(" to ");
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
}

/** Convert an expanded viewport to the rectangle format the Places API expects. */
function toRectangle(vp) {
  return {
    low: { latitude: vp.south, longitude: vp.west },
    high: { latitude: vp.north, longitude: vp.east },
  };
}

/** Synthesize a viewport from a center point + radius in meters. */
function viewportFromCenter(location, radiusMeters) {
  const km = radiusMeters / 1000;
  const latPad = km / 111;
  const lngPad = km / (111 * Math.max(0.2, Math.cos(toRadians(location.latitude))));
  return {
    north: location.latitude + latPad,
    south: location.latitude - latPad,
    east: location.longitude + lngPad,
    west: location.longitude - lngPad,
  };
}

/** Build a shareable trip summary payload. */
function buildSharePayload({ itinerary, profile, weather }) {
  if (!Array.isArray(itinerary) || !itinerary.length) {
    throw badRequest("No itinerary to share.");
  }
  const stops = itinerary.map((stop, i) => ({
    index: i + 1,
    name: stop.title || stop.name,
    time: stop.time,
    rating: stop.rating,
    address: stop.address,
    mapsLink: stop.googleMapsUri || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.address || stop.title)}`,
  }));
  const text = stops.map((s) => `${s.index}. ${s.time} — ${s.name} (${s.rating}★)\n   ${s.mapsLink}`).join("\n\n");
  return {
    title: `MoodSync trip: ${profile?.city || "My day"}`,
    text: `🗺️ MoodSync Itinerary — ${profile?.city || "Today"}\n\n${text}\n\nWeather: ${weather?.description ?? "N/A"}`,
    stops,
  };
}

function addHours(time, hours) {
  const [rawHour, rawMinute] = time.split(":").map(Number);
  const date = new Date(Date.UTC(2026, 0, 1, rawHour + hours, rawMinute || 0));
  return date.toISOString().slice(11, 16);
}

function durationToMinutes(duration = "0s") {
  return Math.ceil(Number(String(duration).replace("s", "")) / 60);
}

function clamp(number, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : min));
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);
  if (!filePath.startsWith(root)) throw Object.assign(new Error("Forbidden"), { status: 403 });
  const body = await readFile(filePath);
  res.writeHead(200, { "Content-Type": mime[extname(filePath)] ?? "application/octet-stream" });
  res.end(body);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function assertMethod(req, method) {
  if (req.method !== method) throw Object.assign(new Error("Method not allowed"), { status: 405 });
}

function requireKeys(keys) {
  const missing = keys.filter((key) => !config[key]);
  if (missing.length) {
    const names = missing.map((key) =>
      key === "googleMapsKey" ? "GOOGLE_MAPS_API_KEY" : "GEMINI_API_KEY",
    );
    throw Object.assign(new Error(`Missing environment variables: ${names.join(", ")}`), {
      status: 503,
    });
  }
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function statusFor(error) {
  if (error.code === "ENOENT") return 404;
  return error.status ?? 500;
}

async function loadDotEnv() {
  try {
    const text = await readFile(join(root, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (!key || process.env[key]) continue;
      process.env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
