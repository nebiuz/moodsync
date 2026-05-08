const state = {
  profile: null,
  itinerary: [],
  weather: null,
  forecast: null,
  insights: [],
  mood: "high",
  pendingPivot: null,
  pulseTimer: null,
  currentLocation: null,
  mapsBrowserKey: null,
  googleMap: null,
  mapMarkers: [],
  discoverySeed: Date.now(),
  darkMode: localStorage.getItem("moodsync-dark") ?? "auto",
};

const els = {
  globalStatus: document.querySelector("#globalStatus"),
  pulseStamp: document.querySelector("#pulseStamp"),
  timeline: document.querySelector("#timeline"),
  tripTitle: document.querySelector("#tripTitle"),
  personaText: document.querySelector("#personaText"),
  locationText: document.querySelector("#locationText"),
  rulesText: document.querySelector("#rulesText"),
  mapFrame: document.querySelector("#mapFrame"),
  mapCanvas: document.querySelector("#mapCanvas"),
  assistantLog: document.querySelector("#assistantLog"),
  tripForm: document.querySelector("#tripForm"),
  useLocationBtn: document.querySelector("#useLocationBtn"),
  locationHint: document.querySelector("#locationHint"),
  refreshIdeas: document.querySelector("#refreshIdeas"),
  highEnergyBtn: document.querySelector("#highEnergyBtn"),
  lowBatteryBtn: document.querySelector("#lowBatteryBtn"),
  pulseNow: document.querySelector("#pulseNow"),
  resetTrip: document.querySelector("#resetTrip"),
  pivotSheet: document.querySelector("#pivotSheet"),
  pivotReason: document.querySelector("#pivotReason"),
  pivotTitle: document.querySelector("#pivotTitle"),
  pivotCopy: document.querySelector("#pivotCopy"),
  candidateList: document.querySelector("#candidateList"),
  acceptPivot: document.querySelector("#acceptPivot"),
  dismissPivot: document.querySelector("#dismissPivot"),
  darkModeToggle: document.querySelector("#darkModeToggle"),
  shareTrip: document.querySelector("#shareTrip"),
  exportTrip: document.querySelector("#exportTrip"),
};

applyDarkMode();
renderEmpty();
wireEvents();
checkConfig();

function wireEvents() {
  els.useLocationBtn.addEventListener("click", captureCurrentLocation);
  els.tripForm.addEventListener("submit", buildTrip);
  els.refreshIdeas.addEventListener("click", refreshIdeas);
  els.highEnergyBtn.addEventListener("click", () => setMood("high"));
  els.lowBatteryBtn.addEventListener("click", () => setMood("low"));
  els.pulseNow.addEventListener("click", runPulseCheck);
  els.resetTrip.addEventListener("click", resetTrip);
  els.acceptPivot.addEventListener("click", acceptPivot);
  els.dismissPivot.addEventListener("click", hidePivotSheet);
  els.darkModeToggle.addEventListener("click", toggleDarkMode);
  els.shareTrip.addEventListener("click", shareTrip);
  els.exportTrip.addEventListener("click", exportTrip);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hidePivotSheet();
  });
}

async function checkConfig() {
  const config = await apiGet("/api/config");
  state.mapsBrowserKey = config.mapsBrowserKey;
  if (!config.ready) {
    setStatus("Setup needed", true);
    log(`Missing server environment variables: ${config.missing.join(", ")}.`);
  } else if (!config.mapsBrowserKey) {
    log("Add GOOGLE_MAPS_BROWSER_KEY to show numbered map markers.");
  }
}

async function buildTrip(event) {
  event.preventDefault();
  setBusy(true, "Building itinerary from Google Places, Routes, Weather, and Gemini...");
  try {
    const profile = profileFromForm();
    const result = await apiPost("/api/plan", profile);
    state.profile = result.profile;
    state.itinerary = result.itinerary;
    state.weather = result.weather;
    state.forecast = result.forecast ?? null;
    state.insights = result.insights ?? [];
    state.mood = result.profile.mood;
    els.shareTrip.disabled = false;
    els.exportTrip.disabled = false;
    await renderMap(result.itinerary, result.mapUrl);
    startPulseChecks();
    render("Live itinerary built. Pulse checks active every 5 min.");
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

async function runPulseCheck() {
  if (!state.itinerary.length) { log("Build an itinerary first."); return; }
  setBusy(true, "Running live pulse check...");
  try {
    const result = await apiPost("/api/pulse", { itinerary: state.itinerary, profile: state.profile });
    state.itinerary = result.itinerary;
    state.weather = result.weather;
    state.forecast = result.forecast ?? null;
    state.insights = result.insights ?? [];
    await renderMap(result.itinerary, result.mapUrl);
    render(result.conflicts.length ? result.conflicts[0].message : "Pulse check healthy.");
    if (result.conflicts.length) await resolveConflict(result.conflicts[0]);
  } catch (error) { showError(error.message); }
  finally { setBusy(false); }
}

function startPulseChecks() {
  window.clearInterval(state.pulseTimer);
  state.pulseTimer = window.setInterval(runPulseCheck, 5 * 60 * 1000);
}

async function setMood(mood) {
  state.mood = mood;
  els.highEnergyBtn.classList.toggle("active", mood === "high");
  els.lowBatteryBtn.classList.toggle("active", mood === "low");
  els.highEnergyBtn.setAttribute("aria-checked", mood === "high");
  els.lowBatteryBtn.setAttribute("aria-checked", mood === "low");
  if (!state.itinerary.length) return;
  state.profile = { ...state.profile, mood };
  if (mood === "low") {
    const stop = state.itinerary.find((s) => s.energy === "high") ?? state.itinerary[1];
    await resolveConflict({ kind: "low-battery", stopId: stop.id, message: `${stop.title} no longer matches low-battery mode.` });
  } else { render("Energy mode updated."); }
}

async function resolveConflict(conflict) {
  showPivotLoading(conflict.message);
  try {
    const result = await apiPost("/api/pivot", { conflict, itinerary: state.itinerary, profile: state.profile, mood: state.mood });
    state.pendingPivot = result;
    showPivotResolution();
  } catch (error) { showError(error.message); hidePivotSheet(); }
}

function acceptPivot() {
  const winner = state.pendingPivot?.winner;
  const conflict = state.pendingPivot?.conflict;
  if (!winner || !conflict) return;
  state.itinerary = state.itinerary.map((stop) => {
    if (stop.id !== conflict.stopId) return stop;
    return { ...winner, id: winner.place_id, title: winner.name, time: stop.time, rationale: state.pendingPivot.decision.explanation, energy: state.mood === "low" ? "low" : "medium", routeToNext: stop.routeToNext, insight: state.pendingPivot.decision.explanation };
  });
  state.pendingPivot = null;
  hidePivotSheet();
  render("Plan updated. Run a pulse check to refresh downstream routes.");
}

function showPivotLoading(label) {
  els.pivotSheet.classList.add("open");
  els.pivotSheet.setAttribute("aria-hidden", "false");
  els.pivotReason.textContent = "MoodSync resolution";
  els.pivotTitle.textContent = "Finding a real nearby alternative";
  els.pivotCopy.textContent = label;
  els.candidateList.innerHTML = `<div class="skeleton"></div><div class="skeleton short"></div>`;
  els.acceptPivot.disabled = true;
  els.acceptPivot.focus();
}

function showPivotResolution() {
  const { conflict, alternatives, decision, winner } = state.pendingPivot;
  els.acceptPivot.disabled = !winner;
  els.pivotReason.textContent = conflict.kind === "traffic" ? "Route conflict" : conflict.kind === "closed" ? "Closed venue" : "Context conflict";
  els.pivotTitle.textContent = winner ? `Update to ${winner.name}` : "No compliant update found";
  els.pivotCopy.textContent = decision.explanation;
  els.candidateList.innerHTML = alternatives.map((place) => {
    const selected = place.place_id === decision.place_id ? "selected" : "";
    const types = (place.types ?? []).slice(0, 2).join(", ");
    const reason = decision.reason_by_place?.[place.place_id] || place.reason || "Meets constraints.";
    const thumb = place.photos?.[0] ? `<img class="candidate-photo" src="${placePhotoUrl(place.photos[0])}" alt="${escapeHtml(place.name)}" loading="lazy" />` : "";
    return `<article class="candidate ${selected}">${thumb}<div><strong>${escapeHtml(place.name)}</strong><span>${types} · ${place.transitMinutes} min · ${place.rating}★</span><p>${escapeHtml(reason)}</p></div><small>${place.indoor ? "Indoor" : "Outdoor"}</small></article>`;
  }).join("");
}

function hidePivotSheet() {
  els.pivotSheet.classList.remove("open");
  els.pivotSheet.setAttribute("aria-hidden", "true");
}

function resetTrip() {
  window.clearInterval(state.pulseTimer);
  state.profile = null;
  state.itinerary = [];
  state.weather = null;
  state.forecast = null;
  state.insights = [];
  state.pendingPivot = null;
  state.currentLocation = null;
  state.discoverySeed = Date.now();
  els.mapFrame.src = locationMapUrl(null);
  els.shareTrip.disabled = true;
  els.exportTrip.disabled = true;
  resetGoogleMap();
  hidePivotSheet();
  renderEmpty();
}

/* ── Rendering ─────────────────────────────────────────────── */

function render(message) {
  const hasConflict = state.itinerary.some((s) => s.routeToNext?.status === "blocked");
  const hasClosed = state.itinerary.some((s) => s.openNow === false);
  setStatus(hasConflict || hasClosed ? "Needs pivot" : "Pulse healthy", hasConflict || hasClosed);
  els.tripTitle.textContent = state.profile?.city ? `${state.profile.city} live itinerary` : "Live trip";
  els.rulesText.textContent = `<${state.profile.maxTransitMinutes} min hops, ${state.profile.minRating}+ rating`;
  els.locationText.textContent = locationLabel(state.profile.currentLocation);
  els.pulseStamp.textContent = `Last pulse ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  log(message ?? weatherCopy());
  renderTimeline();
}

function renderTimeline() {
  els.timeline.innerHTML = renderPlaceCarousel() + renderTripSummary() + renderInsights() + state.itinerary.map(stopCard).join("");
}

function stopCard(stop, index) {
  const route = stop.routeToNext;
  const routeClass = route?.status === "blocked" ? "route blocked" : "route";
  const prevStop = index > 0 ? state.itinerary[index - 1] : null;
  const navFrom = prevStop ? `${prevStop.title || ""}` : (state.currentLocation ? `${state.currentLocation.latitude},${state.currentLocation.longitude}` : "");
  const navUrl = `https://www.google.com/maps/dir/${encodeURIComponent(navFrom)}/${encodeURIComponent(stop.address || stop.title)}`;
  const mapsUrl = stop.googleMapsUri || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.address || stop.title)}`;

  const badges = [];
  if (stop.openNow === true) badges.push(`<span class="badge open">✓ Open</span>`);
  else if (stop.openNow === false) badges.push(`<span class="badge closed">✗ Closed</span>`);
  if (stop.indoor) badges.push(`<span class="badge">🏠 Indoor</span>`);
  else badges.push(`<span class="badge">🌳 Outdoor</span>`);
  badges.push(`<span class="badge">${stop.energy} energy</span>`);

  const fc = stop.forecast;
  if (fc) {
    const rain = fc.precipitationProbability ?? 0;
    if (rain >= 40) badges.push(`<span class="badge rain">🌧 ${rain}% rain</span>`);
    else badges.push(`<span class="badge sunny">☀️ ${rain}%</span>`);
  }

  return `
    <article class="stop-card ${route?.status === "blocked" ? "at-risk" : ""}" style="--delay:${index * 70}ms" role="article" aria-label="Stop ${index + 1}: ${escapeHtml(stop.title)}">
      <div class="stop-time">${stop.time}</div>
      <div class="stop-body">
        <div class="stop-heading">
          <h3>${escapeHtml(stop.title)}</h3>
          <span>${Number(stop.rating || 0).toFixed(1)}★</span>
        </div>
        <p>${escapeHtml(stop.address || "Address unavailable")}</p>
        <div class="stop-meta">${badges.join("")}</div>
        <div class="why-line">${escapeHtml(stop.insight || stop.rationale || "Fits your active constraints.")}</div>
        <div class="stop-actions">
          <a href="${mapsUrl}" target="_blank" rel="noopener" aria-label="View ${escapeHtml(stop.title)} on Google Maps">📍 View</a>
          <a href="${navUrl}" target="_blank" rel="noopener" aria-label="Navigate to ${escapeHtml(stop.title)}">🧭 Navigate</a>
        </div>
        ${index < state.itinerary.length - 1
          ? `<div class="${routeClass}">Next hop: ${route?.currentMinutes ?? "?"} min <small>${route?.distanceMeters ? `${Math.round(route.distanceMeters / 100) / 10} km` : "route live"}</small></div>`
          : `<div class="route complete">Final stop</div>`}
      </div>
    </article>`;
}

function renderInsights() {
  if (!state.insights.length) return "";
  return `<div class="insight-grid">${state.insights.map((i) => `<div class="insight-card ${i.tone}"><span>${escapeHtml(i.label)}</span><strong>${escapeHtml(i.value)}</strong></div>`).join("")}</div>`;
}

function renderTripSummary() {
  if (!state.itinerary.length) return "";
  const totalTransit = state.itinerary.reduce((s, stop) => s + Number(stop.routeToNext?.currentMinutes || 0), 0);
  const avgRating = state.itinerary.reduce((s, stop) => s + Number(stop.rating || 0), 0) / state.itinerary.length;
  const indoor = state.itinerary.filter((s) => s.indoor).length;
  const outdoor = state.itinerary.length - indoor;
  const first = state.itinerary[0], last = state.itinerary[state.itinerary.length - 1];
  const span = first && last ? `${first.time} – ${last.time}` : "—";
  return `<div class="trip-summary" role="region" aria-label="Trip summary">
    <div class="summary-stat"><span class="stat-value">${state.itinerary.length}</span><span class="stat-label">Stops</span></div>
    <div class="summary-stat"><span class="stat-value">${span}</span><span class="stat-label">Time span</span></div>
    <div class="summary-stat"><span class="stat-value">${totalTransit}m</span><span class="stat-label">Transit</span></div>
    <div class="summary-stat"><span class="stat-value">${avgRating.toFixed(1)}★</span><span class="stat-label">Avg rating</span></div>
    <div class="summary-stat"><span class="stat-value">${indoor}/${outdoor}</span><span class="stat-label">In/Outdoor</span></div>
  </div>`;
}

function renderPlaceCarousel() {
  const withPhotos = state.itinerary.filter((s) => s.photos?.length);
  if (!withPhotos.length) return "";
  return `<section class="place-carousel" aria-label="Recommended place photos">${withPhotos.map((s) => `
    <article class="photo-tile">
      <img src="${placePhotoUrl(s.photos[0])}" alt="Photo of ${escapeHtml(s.title)}" loading="lazy" />
      <div><strong>${escapeHtml(s.title)}</strong><span>${Number(s.rating || 0).toFixed(1)}★ · ${escapeHtml(s.energy)} energy</span></div>
    </article>`).join("")}</section>`;
}

function renderEmpty() {
  setStatus("Awaiting setup", false);
  els.tripTitle.textContent = "Build a live trip";
  els.locationText.textContent = "Not shared yet";
  els.locationHint.textContent = "Start by sharing your location so MoodSync can pin you on the map and plan the first hop.";
  els.rulesText.textContent = "Waiting for trip inputs";
  els.timeline.innerHTML = `<article class="stop-card"><div class="stop-time">Now</div><div class="stop-body"><div class="stop-heading"><h3>Enter a city and interests</h3><span>Live</span></div><p>MoodSync will use Google Places, Routes, Weather, and Gemini to build and repair the day.</p><div class="route complete">No hardcoded itinerary loaded</div></div></article>`;
  log("Add trip inputs, then build a live itinerary.");
}

/* ── Dark mode ─────────────────────────────────────────────── */

function toggleDarkMode() {
  const html = document.documentElement;
  const isDark = html.classList.contains("dark");
  html.classList.toggle("dark", !isDark);
  html.setAttribute("data-theme", isDark ? "light" : "dark");
  state.darkMode = isDark ? "light" : "dark";
  localStorage.setItem("moodsync-dark", state.darkMode);
  els.darkModeToggle.textContent = isDark ? "🌙" : "☀️";
  els.darkModeToggle.setAttribute("aria-label", isDark ? "Switch to dark mode" : "Switch to light mode");
}

function applyDarkMode() {
  const pref = state.darkMode;
  if (pref === "dark") {
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-theme", "dark");
    els.darkModeToggle.textContent = "☀️";
  } else if (pref === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    els.darkModeToggle.textContent = "🌙";
  }
}

/* ── Share & export ────────────────────────────────────────── */

async function shareTrip() {
  if (!state.itinerary.length) return;
  const text = buildShareText();
  const title = `MoodSync trip: ${state.profile?.city || "My day"}`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
    } catch (e) {
      if (e.name !== "AbortError") log(`Share failed: ${e.message}`);
    }
  } else {
    await navigator.clipboard.writeText(text);
    log("Trip copied to clipboard!");
  }
}

async function exportTrip() {
  if (!state.itinerary.length) return;
  try {
    await navigator.clipboard.writeText(buildShareText());
    log("Trip itinerary copied to clipboard with Google Maps links!");
  } catch (e) { log(`Export failed: ${e.message}`); }
}

function buildShareText() {
  const city = state.profile?.city || "Today";
  const stops = state.itinerary.map((stop, i) => {
    const mapsLink = stop.googleMapsUri || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.address || stop.title)}`;
    return `${i + 1}. ${stop.time} \u2014 ${stop.title} (${Number(stop.rating || 0).toFixed(1)}\u2605)\n   ${mapsLink}`;
  }).join("\n\n");
  const weather = state.weather?.description ?? "N/A";
  return `\ud83d\uddfa\ufe0f MoodSync Itinerary \u2014 ${city}\n\n${stops}\n\nWeather: ${weather}`;
}

/* ── Form & location ───────────────────────────────────────── */

function profileFromForm() {
  const data = new FormData(els.tripForm);
  return {
    city: data.get("city"),
    interests: data.get("interests"),
    startTime: data.get("startTime"),
    stopCount: data.get("stopCount"),
    maxTransitMinutes: data.get("maxTransitMinutes"),
    minRating: data.get("minRating"),
    tripStyle: data.get("tripStyle"),
    cityRadiusMeters: data.get("cityRadiusMeters"),
    travelMode: data.get("travelMode"),
    mood: state.mood,
    currentLocation: state.currentLocation,
    discoverySeed: state.discoverySeed,
  };
}

function refreshIdeas() {
  state.discoverySeed = Date.now();
  els.tripForm.requestSubmit();
}

async function captureCurrentLocation() {
  els.useLocationBtn.disabled = true;
  els.locationHint.textContent = "Requesting precise browser location...";
  const location = await getCurrentLocation();
  els.useLocationBtn.disabled = false;
  if (location) {
    els.mapFrame.src = locationMapUrl(location);
    await renderMap([], locationMapUrl(location));
    els.locationHint.textContent = "Location pinned on the map and ready for Gemini planning.";
    setStatus("Location ready", false);
    log("Current location captured. Build an itinerary when your interests are set.");
  }
}

function getCurrentLocation() {
  if (!("geolocation" in navigator)) {
    log("Browser geolocation is unavailable.");
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyMeters: Math.round(pos.coords.accuracy), capturedAt: new Date().toISOString() };
        state.currentLocation = loc;
        els.locationText.textContent = locationLabel(loc);
        resolve(loc);
      },
      () => {
        els.locationHint.textContent = "Location permission not granted. You can still use a city or area.";
        log("Location permission not granted. Continuing with city/area only.");
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  });
}

/* ── API helpers ───────────────────────────────────────────── */

async function apiGet(path) { return parseApiResponse(await fetch(path)); }

async function apiPost(path, body) {
  return parseApiResponse(await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

async function parseApiResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? response.statusText);
  return data;
}

/* ── UI helpers ────────────────────────────────────────────── */

function setBusy(busy, msg) {
  els.tripForm.querySelectorAll("button, input, select").forEach((n) => { n.disabled = busy; });
  if (msg) log(msg);
}

function setStatus(text, warning) {
  els.globalStatus.textContent = text;
  els.globalStatus.classList.toggle("warning", warning);
}

function showError(msg) { setStatus("Needs attention", true); log(msg); }
function log(msg) { els.assistantLog.textContent = msg; }

function weatherCopy() {
  if (!state.weather) return "Monitoring route pressure, weather fit, and energy mode.";
  const temp = state.weather.temperature ? ` ${state.weather.temperature.degrees ?? ""}°` : "";
  return `${state.weather.description}${temp}. Precipitation: ${state.weather.precipitationProbability}%.`;
}

function locationLabel(loc) {
  if (!loc) return "Not shared";
  return `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)} ±${loc.accuracyMeters ?? "?"}m`;
}

function locationMapUrl(loc) {
  if (!loc) return "https://www.google.com/maps?q=Share%20your%20location&output=embed";
  return `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}&z=15&output=embed`;
}

/* ── Google Maps JavaScript ────────────────────────────────── */

async function renderMap(stops, fallbackUrl) {
  els.mapFrame.src = fallbackUrl;
  if (!state.mapsBrowserKey) return;
  try {
    await ensureGoogleMaps();
    els.mapFrame.classList.add("hidden");
    els.mapCanvas.classList.add("active");
    const bounds = new google.maps.LatLngBounds();
    const center = stops[0]?.location ?? state.currentLocation ?? { latitude: 28.6139, longitude: 77.209 };
    if (!state.googleMap) {
      state.googleMap = new google.maps.Map(els.mapCanvas, { center: toMapLatLng(center), zoom: stops.length ? 12 : 15, mapTypeControl: false, streetViewControl: false, fullscreenControl: true });
    } else { state.googleMap.setCenter(toMapLatLng(center)); }
    clearMapMarkers();
    if (state.currentLocation) {
      addMarker({ position: toMapLatLng(state.currentLocation), label: "You", title: "Your current location", tone: "current" });
      bounds.extend(toMapLatLng(state.currentLocation));
    }
    stops.forEach((stop, i) => {
      if (!stop.location) return;
      const pos = toMapLatLng(stop.location);
      addMarker({ position: pos, label: String(i + 1), title: stop.title, tone: stop.routeToNext?.status === "blocked" ? "risk" : "stop" });
      bounds.extend(pos);
    });
    if (!bounds.isEmpty()) { state.googleMap.fitBounds(bounds, 56); if (stops.length < 2) state.googleMap.setZoom(15); }
  } catch (e) {
    els.mapFrame.classList.remove("hidden");
    els.mapCanvas.classList.remove("active");
    log(`Map markers unavailable: ${e.message}`);
  }
}

function addMarker({ position, label, title, tone }) {
  state.mapMarkers.push(new google.maps.Marker({ position, map: state.googleMap, title, label: { text: label, color: "#ffffff", fontWeight: "900" }, icon: markerIcon(tone) }));
}

function markerIcon(tone) {
  const fill = tone === "current" ? "#1d5fd1" : tone === "risk" ? "#b42318" : "#1c7c54";
  return { path: google.maps.SymbolPath.CIRCLE, fillColor: fill, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 3, scale: 15 };
}

function clearMapMarkers() { state.mapMarkers.forEach((m) => m.setMap(null)); state.mapMarkers = []; }

function resetGoogleMap() { clearMapMarkers(); state.googleMap = null; els.mapCanvas.classList.remove("active"); els.mapFrame.classList.remove("hidden"); }

function ensureGoogleMaps() {
  if (window.google?.maps) return Promise.resolve();
  if (window.__pivotMapsPromise) return window.__pivotMapsPromise;
  window.__pivotMapsPromise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Google Maps did not initialize.")), 7000);
    window.gm_authFailure = () => { window.clearTimeout(timeout); reject(new Error("Google Maps browser key unauthorized.")); };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(state.mapsBrowserKey)}&v=weekly`;
    s.async = true; s.defer = true;
    s.onload = () => { window.clearTimeout(timeout); resolve(); };
    s.onerror = () => { window.clearTimeout(timeout); reject(new Error("Google Maps failed to load")); };
    document.head.append(s);
  });
  return window.__pivotMapsPromise;
}

function toMapLatLng(loc) { return { lat: Number(loc.latitude), lng: Number(loc.longitude) }; }

function placePhotoUrl(name) { return `/api/place-photo?name=${encodeURIComponent(name)}&w=720`; }

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
}
