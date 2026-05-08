import test from "node:test";
import assert from "node:assert/strict";
import { chooseBestAlternative } from "../src/services/decisionEngine.js";

const nearbyAlternatives = [
  {
    place_id: "place_carnavalet",
    name: "Musee Carnavalet",
    type: "museum",
    rating: 4.6,
    indoor: true,
    localSignal: 0.92,
    transitMinutes: 8,
  },
  {
    place_id: "place_fringe_cafe",
    name: "Fringe Coffee",
    type: "cafe",
    rating: 4.7,
    indoor: true,
    localSignal: 0.86,
    transitMinutes: 6,
  },
  {
    place_id: "place_tour_bus",
    name: "Classic Paris Bus Tour",
    type: "tourist_attraction",
    rating: 4.1,
    indoor: false,
    localSignal: 0.25,
    transitMinutes: 18,
  },
  {
    place_id: "place_far_museum",
    name: "Fondation Louis Vuitton",
    type: "museum",
    rating: 4.5,
    indoor: true,
    localSignal: 0.72,
    transitMinutes: 34,
  },
];

test("rain conflicts only choose indoor places within persona constraints", () => {
  const decision = chooseBestAlternative({
    alternatives: nearbyAlternatives,
    conflict: { kind: "rain", stopId: "park" },
    mood: "high",
  });

  assert.equal(decision.place_id, "place_carnavalet");
  assert.equal(decision.winner.indoor, true);
  assert.ok(decision.winner.transitMinutes <= 20);
  assert.ok(decision.winner.rating >= 4.5);
});

test("low battery mode favors a nearby high-rated cafe", () => {
  const decision = chooseBestAlternative({
    alternatives: nearbyAlternatives,
    conflict: { kind: "low-battery", stopId: "park" },
    mood: "low",
  });

  assert.equal(decision.place_id, "place_fringe_cafe");
  assert.equal(decision.winner.type, "cafe");
});

test("returns no winner when every alternative violates hard constraints", () => {
  const decision = chooseBestAlternative({
    alternatives: [
      {
        place_id: "bad_far",
        name: "Far Stop",
        type: "museum",
        rating: 4.9,
        indoor: true,
        localSignal: 1,
        transitMinutes: 40,
      },
    ],
    conflict: { kind: "traffic", stopId: "park" },
    mood: "high",
  });

  assert.equal(decision.place_id, null);
});
