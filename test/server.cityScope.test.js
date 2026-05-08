import test from "node:test";
import assert from "node:assert/strict";

function mockJsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() {
      return JSON.stringify(payload);
    },
    headers: new Map(),
  };
}

test("findCity requests viewport in Places field mask", async () => {
  process.env.MOODSYNC_DISABLE_SERVER = "1";
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-gemini";

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("places.googleapis.com/v1/places:searchText")) {
      return mockJsonResponse({
        places: [
          {
            id: "city_1",
            displayName: { text: "Paris" },
            formattedAddress: "Paris, France",
            location: { latitude: 48.8566, longitude: 2.3522 },
            viewport: {
              low: { latitude: 48.80, longitude: 2.25 },
              high: { latitude: 48.90, longitude: 2.45 },
            },
            addressComponents: [],
          },
        ],
      });
    }
    return mockJsonResponse({});
  };

  const mod = await import("../server.js");
  const city = await mod.findCity("Paris");

  const placeCall = calls.find((c) => c.url.includes("places:searchText"));
  assert.ok(placeCall, "expected Places searchText call");
  assert.match(
    placeCall.options.headers["X-Goog-FieldMask"],
    /places\.viewport/,
    "field mask should include places.viewport",
  );
  assert.ok(city.viewport, "normalized city should include viewport");
});

test("searchInterestCandidates uses destination rectangle and filters out-of-city places", async () => {
  process.env.MOODSYNC_DISABLE_SERVER = "1";
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-gemini";

  const requests = [];
  global.fetch = async (url, options) => {
    if (String(url).includes("places.googleapis.com/v1/places:searchText")) {
      requests.push(JSON.parse(options.body));
      return mockJsonResponse({
        places: [
          {
            id: "in_city",
            displayName: { text: "Inside Cafe" },
            formattedAddress: "Inside Address",
            location: { latitude: 48.86, longitude: 2.35 },
            rating: 4.7,
            types: ["cafe"],
            googleMapsUri: "https://maps.google.com/?q=inside",
            addressComponents: [],
            photos: [],
          },
          {
            id: "in_city_2",
            displayName: { text: "Inside Gallery" },
            formattedAddress: "Inside Gallery Address",
            location: { latitude: 48.855, longitude: 2.38 },
            rating: 4.6,
            types: ["art_gallery"],
            googleMapsUri: "https://maps.google.com/?q=inside2",
            addressComponents: [],
            photos: [],
          },
          {
            id: "out_city",
            displayName: { text: "Outside Museum" },
            formattedAddress: "Outside Address",
            location: { latitude: 49.10, longitude: 2.35 },
            rating: 4.8,
            types: ["museum"],
            googleMapsUri: "https://maps.google.com/?q=outside",
            addressComponents: [],
            photos: [],
          },
        ],
      });
    }
    return mockJsonResponse({});
  };

  const mod = await import("../server.js");

  const profile = mod.normalizeProfile({
    city: "Paris",
    interests: ["coffee"],
    minRating: 4.0,
    cityRadiusMeters: 20000,
    currentLocation: { latitude: 12.9716, longitude: 77.5946 },
  });

  const city = {
    name: "Paris",
    location: { latitude: 48.8566, longitude: 2.3522 },
    viewport: { north: 48.90, south: 48.80, east: 2.45, west: 2.25 },
  };

  const candidates = await mod.searchInterestCandidates(profile, city);

  assert.equal(requests.length, 1);
  assert.ok(requests[0].locationRestriction, "expected a locationRestriction rectangle");
  assert.deepEqual(requests[0].locationRestriction.rectangle, mod.toRectangle(city.viewport));
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((c) => c.place_id).sort(),
    ["in_city", "in_city_2"].sort(),
  );
});

