const state = {
  profile: null,
  itinerary: [],
  weather: null,
  insights: [],
  mood: "high",
  pendingPivot: null,
  pulseTimer: null,
  currentLocation: null,
  mapsBrowserKey: null,
  googleMap: null,
  mapMarkers: [],
  discoverySeed: Date.now(),
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
};

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
}

async function checkConfig() {
  const config = await apiGet("/api/config");
  state.mapsBrowserKey = config.mapsBrowserKey;
  if (!config.ready) {
    setStatus("Setup needed", true);
    log(`Missing server environment variables: ${config.missing.join(", ")}.`);
  } else if (!config.mapsBrowserKey) {
    log("Add GOOGLE_MAPS_BROWSER_KEY to show numbered map markers. Using iframe preview for now.");
  }
}

async function buildTrip(event) {
  event.preventDefault();
  setBusy(true, "Building itinerary from Google Places, Routes, Weather, and Gemini.");

  try {
    const profile = profileFromForm();
    const result = await apiPost("/api/plan", profile);
    state.profile = result.profile;
    state.itinerary = result.itinerary;
    state.weather = result.weather;
    state.insights = result.insights ?? [];
    state.mood = result.profile.mood;
    await renderMap(result.itinerary, result.mapUrl);
    startPulseChecks();
    render("Live itinerary built. Pulse checks are active.");
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

async function runPulseCheck() {
  if (!state.itinerary.length) {
    log("Build an itinerary before running a pulse check.");
    return;
  }

  setBusy(true, "Running live pulse check.");
  try {
    const result = await apiPost("/api/pulse", {
      itinerary: state.itinerary,
      profile: state.profile,
    });
    state.itinerary = result.itinerary;
    state.weather = result.weather;
    state.insights = result.insights ?? [];
    await renderMap(result.itinerary, result.mapUrl);
    render(result.conflicts.length ? result.conflicts[0].message : "Pulse check healthy.");

    if (result.conflicts.length) {
      await resolveConflict(result.conflicts[0]);
    }
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

function startPulseChecks() {
  window.clearInterval(state.pulseTimer);
  state.pulseTimer = window.setInterval(runPulseCheck, 5 * 60 * 1000);
}

async function setMood(mood) {
  state.mood = mood;
  els.highEnergyBtn.classList.toggle("active", mood === "high");
  els.lowBatteryBtn.classList.toggle("active", mood === "low");

  if (!state.itinerary.length) return;
  state.profile = { ...state.profile, mood };

  if (mood === "low") {
    const stop = state.itinerary.find((item) => item.energy === "high") ?? state.itinerary[1];
    await resolveConflict({
      kind: "low-battery",
      stopId: stop.id,
      message: `${stop.title} no longer matches low-battery mode.`,
    });
  } else {
    render("Energy mode updated.");
  }
}

async function resolveConflict(conflict) {
  showPivotLoading(conflict.message);

  try {
    const result = await apiPost("/api/pivot", {
      conflict,
      itinerary: state.itinerary,
      profile: state.profile,
      mood: state.mood,
    });
    state.pendingPivot = result;
    showPivotResolution();
  } catch (error) {
    showError(error.message);
    hidePivotSheet();
  }
}

function acceptPivot() {
  const winner = state.pendingPivot?.winner;
  const conflict = state.pendingPivot?.conflict;
  if (!winner || !conflict) return;

  state.itinerary = state.itinerary.map((stop) => {
    if (stop.id !== conflict.stopId) return stop;
    return {
      ...winner,
      id: winner.place_id,
      title: winner.name,
      time: stop.time,
      rationale: state.pendingPivot.decision.explanation,
      energy: state.mood === "low" ? "low" : "medium",
      routeToNext: stop.routeToNext,
      insight: state.pendingPivot.decision.explanation,
    };
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
}

function showPivotResolution() {
  const { conflict, alternatives, decision, winner } = state.pendingPivot;
  els.acceptPivot.disabled = !winner;
  els.pivotReason.textContent = conflict.kind === "traffic" ? "Route conflict" : "Context conflict";
  els.pivotTitle.textContent = winner ? `Update to ${winner.name}` : "No compliant update found";
  els.pivotCopy.textContent = decision.explanation;
  els.candidateList.innerHTML = alternatives
    .map((place) => {
      const selected = place.place_id === decision.place_id ? "selected" : "";
      const types = (place.types ?? []).slice(0, 2).join(", ");
      const geminiReason = decision.reason_by_place?.[place.place_id];
      const reason = geminiReason || place.reason || "Meets the active trip constraints.";
      const thumbnail = place.photos?.[0]
        ? `<img class="candidate-photo" src="${placePhotoUrl(place.photos[0])}" alt="${escapeHtml(place.name)}" loading="lazy" />`
        : "";
      return `
        <article class="candidate ${selected}">
          ${thumbnail}
          <div>
            <strong>${place.name}</strong>
            <span>${types} · ${place.transitMinutes} min · ${place.rating}★</span>
            <p>${escapeHtml(reason)}</p>
          </div>
          <small>${place.indoor ? "Indoor" : "Outdoor"}</small>
        </article>
      `;
    })
    .join("");
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
  state.insights = [];
  state.pendingPivot = null;
  state.currentLocation = null;
  state.discoverySeed = Date.now();
  els.mapFrame.src = locationMapUrl(null);
  resetGoogleMap();
  hidePivotSheet();
  renderEmpty();
}

function render(message) {
  const hasConflict = state.itinerary.some((stop) => stop.routeToNext?.status === "blocked");
  setStatus(hasConflict ? "Needs pivot" : "Pulse healthy", hasConflict);
  els.tripTitle.textContent = state.profile?.city ? `${state.profile.city} live itinerary` : "Live trip";
  els.rulesText.textContent = `<${state.profile.maxTransitMinutes} min hops, ${state.profile.minRating}+ rating`;
  els.locationText.textContent = locationLabel(state.profile.currentLocation);
  els.pulseStamp.textContent = `Last pulse ${new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
  log(message ?? weatherCopy());

  renderTimeline();
}

function stopCard(stop, index) {
  const route = stop.routeToNext;
  const routeClass = route?.status === "blocked" ? "route blocked" : "route";
  return `
    <article class="stop-card ${route?.status === "blocked" ? "at-risk" : ""}" style="--delay:${index * 70}ms">
      <div class="stop-time">${stop.time}</div>
      <div class="stop-body">
        <div class="stop-heading">
          <h3>${escapeHtml(stop.title)}</h3>
          <span>${Number(stop.rating || 0).toFixed(1)}★</span>
        </div>
        <p>${escapeHtml(stop.address || "Address unavailable")} · ${stop.indoor ? "Indoor" : "Outdoor"} · ${stop.energy} energy</p>
        <div class="why-line">${escapeHtml(stop.insight || stop.rationale || "Suggested because it fits your active constraints.")}</div>
        ${
          index < state.itinerary.length - 1
            ? `<div class="${routeClass}">Next hop: ${route?.currentMinutes ?? "?"} min <small>${route?.distanceMeters ? `${Math.round(route.distanceMeters / 100) / 10} km` : "route live"}</small></div>`
            : `<div class="route complete">Final stop</div>`
        }
      </div>
    </article>
  `;
}

function renderInsights() {
  if (!state.insights.length) return "";
  return `
    <div class="insight-grid">
      ${state.insights
        .map(
          (item) => `
            <div class="insight-card ${item.tone}">
              <span>${escapeHtml(item.label)}</span>
              <strong>${escapeHtml(item.value)}</strong>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderTimeline() {
  els.timeline.innerHTML =
    renderPlaceCarousel() + renderInsights() + state.itinerary.map(stopCard).join("");
}

function renderPlaceCarousel() {
  const placesWithPhotos = state.itinerary.filter((stop) => stop.photos?.length);
  if (!placesWithPhotos.length) return "";

  return `
    <section class="place-carousel" aria-label="Recommended place photos">
      ${placesWithPhotos
        .map(
          (stop) => `
            <article class="photo-tile">
              <img src="${placePhotoUrl(stop.photos[0])}" alt="${escapeHtml(stop.title)}" loading="lazy" />
              <div>
                <strong>${escapeHtml(stop.title)}</strong>
                <span>${Number(stop.rating || 0).toFixed(1)}★ · ${escapeHtml(stop.energy)} energy</span>
              </div>
            </article>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderEmpty() {
  setStatus("Awaiting setup", false);
  els.tripTitle.textContent = "Build a live trip";
  els.locationText.textContent = "Not shared yet";
  els.locationHint.textContent =
    "Start by sharing your location so MoodSync can pin you on the map and plan the first hop.";
  els.rulesText.textContent = "Waiting for trip inputs";
  els.timeline.innerHTML = `
    <article class="stop-card">
      <div class="stop-time">Now</div>
      <div class="stop-body">
        <div class="stop-heading"><h3>Enter a city and interests</h3><span>Live</span></div>
        <p>MoodSync will use Google Places, Routes, Weather, and Gemini to build and repair the day.</p>
        <div class="route complete">No hardcoded itinerary loaded</div>
      </div>
    </article>
  `;
  log("Add trip inputs, then build a live itinerary.");
}

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
    log("Browser geolocation is unavailable. Continuing without current location.");
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const currentLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: Math.round(position.coords.accuracy),
          capturedAt: new Date().toISOString(),
        };
        state.currentLocation = currentLocation;
        els.locationText.textContent = locationLabel(currentLocation);
        resolve(currentLocation);
      },
      () => {
        els.locationHint.textContent = "Location permission was not granted. You can still use a city or area.";
        log("Location permission was not granted. Continuing with city/area only.");
        resolve(null);
      },
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 60000,
      },
    );
  });
}

async function apiGet(path) {
  const response = await fetch(path);
  return parseApiResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? response.statusText);
  return data;
}

function setBusy(busy, message) {
  els.tripForm.querySelectorAll("button, input, select").forEach((node) => {
    node.disabled = busy;
  });
  if (message) log(message);
}

function setStatus(text, warning) {
  els.globalStatus.textContent = text;
  els.globalStatus.classList.toggle("warning", warning);
}

function showError(message) {
  setStatus("Needs attention", true);
  log(message);
}

function log(message) {
  els.assistantLog.textContent = message;
}

function weatherCopy() {
  if (!state.weather) return "Monitoring route pressure, weather fit, and energy mode.";
  return `${state.weather.description}. Precipitation probability: ${state.weather.precipitationProbability}%.`;
}

function locationLabel(location) {
  if (!location) return "Not shared";
  return `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)} ±${location.accuracyMeters ?? "?"}m`;
}

function locationMapUrl(location) {
  if (!location) return "https://www.google.com/maps?q=Share%20your%20location&output=embed";
  const query = `${location.latitude},${location.longitude}`;
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&z=15&output=embed`;
}

async function renderMap(stops, fallbackUrl) {
  els.mapFrame.src = fallbackUrl;
  if (!state.mapsBrowserKey) return;

  try {
    await ensureGoogleMaps();
    els.mapFrame.classList.add("hidden");
    els.mapCanvas.classList.add("active");

    const bounds = new google.maps.LatLngBounds();
    const center = stops[0]?.location ?? state.currentLocation ?? { latitude: 28.6139, longitude: 77.209 };
    const mapCenter = toMapLatLng(center);

    if (!state.googleMap) {
      state.googleMap = new google.maps.Map(els.mapCanvas, {
        center: mapCenter,
        zoom: stops.length ? 12 : 15,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
      });
    } else {
      state.googleMap.setCenter(mapCenter);
    }

    clearMapMarkers();

    if (state.currentLocation) {
      addMarker({
        position: toMapLatLng(state.currentLocation),
        label: "You",
        title: "Your current location",
        tone: "current",
      });
      bounds.extend(toMapLatLng(state.currentLocation));
    }

    stops.forEach((stop, index) => {
      if (!stop.location) return;
      const position = toMapLatLng(stop.location);
      addMarker({
        position,
        label: String(index + 1),
        title: stop.title,
        tone: stop.routeToNext?.status === "blocked" ? "risk" : "stop",
      });
      bounds.extend(position);
    });

    if (!bounds.isEmpty()) {
      state.googleMap.fitBounds(bounds, 56);
      if (stops.length < 2) state.googleMap.setZoom(15);
    }
  } catch (error) {
    els.mapFrame.classList.remove("hidden");
    els.mapCanvas.classList.remove("active");
    log(`Map markers unavailable: ${error.message}. Using iframe preview.`);
  }
}

function addMarker({ position, label, title, tone }) {
  const marker = new google.maps.Marker({
    position,
    map: state.googleMap,
    title,
    label: {
      text: label,
      color: "#ffffff",
      fontWeight: "900",
    },
    icon: markerIcon(tone),
  });
  state.mapMarkers.push(marker);
}

function markerIcon(tone) {
  const fill = tone === "current" ? "#1d5fd1" : tone === "risk" ? "#b42318" : "#1c7c54";
  return {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor: fill,
    fillOpacity: 1,
    strokeColor: "#ffffff",
    strokeWeight: 3,
    scale: 15,
  };
}

function clearMapMarkers() {
  state.mapMarkers.forEach((marker) => marker.setMap(null));
  state.mapMarkers = [];
}

function resetGoogleMap() {
  clearMapMarkers();
  state.googleMap = null;
  els.mapCanvas.classList.remove("active");
  els.mapFrame.classList.remove("hidden");
}

function ensureGoogleMaps() {
  if (window.google?.maps) return Promise.resolve();
  if (window.__pivotMapsPromise) return window.__pivotMapsPromise;

  window.__pivotMapsPromise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Google Maps JavaScript did not initialize. Check browser key restrictions."));
    }, 7000);
    window.gm_authFailure = () => {
      window.clearTimeout(timeout);
      reject(new Error("Google Maps browser key is not authorized for this site or API."));
    };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(state.mapsBrowserKey)}&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Google Maps JavaScript failed to load"));
    };
    document.head.append(script);
  });
  return window.__pivotMapsPromise;
}

function toMapLatLng(location) {
  return {
    lat: Number(location.latitude),
    lng: Number(location.longitude),
  };
}

function placePhotoUrl(name) {
  return `/api/place-photo?name=${encodeURIComponent(name)}&w=720`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return entities[char];
  });
}
