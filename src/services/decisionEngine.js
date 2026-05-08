const defaultPersona = {
  maxTransitMinutes: 20,
  minRating: 4.5,
  mood: "high",
  preferences: ["local spots", "efficient routes", "highly rated venues"],
};

export function buildGeminiDecisionPrompt({ conflict, alternatives, persona = defaultPersona }) {
  return {
    system:
      "You are the decision engine for a travel assistant. Select one alternative that strictly follows the user constraints and return only JSON.",
    user: {
      userPersonaConstraints: {
        maxTransitMinutes: persona.maxTransitMinutes,
        minRating: persona.minRating,
        preferences: persona.preferences ?? defaultPersona.preferences,
        indoorActivitiesWhenRaining: true,
      },
      conflict,
      googlePlacesAlternatives: alternatives,
      task:
        "Return a JSON object with place_id and a snappy two-sentence explanation of why it rescues the itinerary.",
    },
  };
}

export function chooseBestAlternative({
  alternatives,
  conflict,
  mood = "high",
  persona = defaultPersona,
}) {
  const constraints = { ...defaultPersona, ...persona };
  const viable = alternatives
    .filter((place) => place.rating >= constraints.minRating)
    .filter((place) => place.transitMinutes <= constraints.maxTransitMinutes)
    .filter((place) => (conflict.kind === "rain" ? place.indoor : true))
    .map((place) => ({
      ...place,
      score: scorePlace(place, mood, constraints),
    }))
    .sort((a, b) => b.score - a.score || a.transitMinutes - b.transitMinutes);

  const winner = viable[0] ?? null;

  if (!winner) {
    return {
      place_id: null,
      explanation:
        "No nearby option satisfies Alex's rating, transit, and weather constraints. Keeping the current plan is safer than forcing a weak recommendation.",
    };
  }

  return {
    place_id: winner.place_id,
    explanation: explainChoice(winner, conflict, mood),
    winner,
  };
}

export function rankPlacesForPlan({ places, profile = defaultPersona }) {
  return [...places]
    .filter((place) => (place.rating ?? 0) >= profile.minRating)
    .map((place) => ({
      ...place,
      score:
        (place.rating ?? 0) / 5 +
        (place.localSignal ?? 0.5) +
        (place.openNow === false ? -0.5 : 0) +
        (profile.mood === "low" && place.types?.includes("cafe") ? 0.25 : 0),
    }))
    .sort((a, b) => b.score - a.score);
}

function scorePlace(place, mood, persona) {
  const transitScore = (persona.maxTransitMinutes - place.transitMinutes) / persona.maxTransitMinutes;
  const ratingScore = (place.rating - persona.minRating) * 2;
  const localScore = place.localSignal ?? 0.5;
  const kind = place.type ?? place.types?.[0];
  const cafeBonus = mood === "low" && kind === "cafe" ? 0.35 : 0;
  const activityBonus =
    mood === "high" && ["museum", "gallery", "art_gallery"].includes(kind) ? 0.28 : 0;
  const indoorBonus = place.indoor ? 0.2 : 0;

  return transitScore + ratingScore + localScore + cafeBonus + activityBonus + indoorBonus;
}

function explainChoice(place, conflict, mood) {
  if (mood === "low" && place.type === "cafe") {
    return `${place.name} is a ${place.rating}-rated local cafe only ${place.transitMinutes} minutes away, so it protects the schedule without draining Alex. It replaces the high-effort stop with a low-battery reset that still feels specific to the neighborhood.`;
  }

  if (conflict.kind === "rain") {
    return `${place.name} is indoors, ${place.rating}-rated, and only ${place.transitMinutes} minutes away, so the rain no longer breaks the day. It keeps Alex in a local-feeling stop while preserving the next route window.`;
  }

  return `${place.name} keeps the hop to ${place.transitMinutes} minutes and clears Alex's 4.5+ rating rule. It rescues the itinerary with a nearby local alternative instead of sending them across town.`;
}
