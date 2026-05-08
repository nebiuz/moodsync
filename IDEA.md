Here is the complete, detailed product blueprint for **Pivot**. This focuses strictly on the product vision, the user journey, the exact persona constraints to feed your AI, and how to pitch this to the judges to win.

### 1. The Core Pitch (The Problem & The Hook)

**The Problem:** Every existing travel app assumes a perfect world. They give you a list of places and tell you to have fun. But in the real world, it rains, museums close unexpectedly, traffic spikes, and users get tired.
**The Hook:** Pivot isn't an itinerary *generator*. It is an itinerary *healer*. It is a dynamic assistant that runs in the background, watches the real world using Google Maps/Places data, and autonomously rescues your day when things go wrong.

---

### 2. The Target Persona: "The Time-Crunched Weekend Explorer"

Hackathons require you to build for a specific vertical/persona. Do not make a generic app for "everyone." Build it for this specific persona.

**Persona Profile:**

* **Name:** Alex (30s, Professional).
* **Travel Style:** High-density. They only have 48 hours in a city and want to maximize it.
* **Pain Point:** A 45-minute delay ruins their entire interconnected schedule.
* **Vibe:** Prefers highly-rated local spots, hates tourist traps, needs transit to be under 20 minutes between locations.

### 3. The Core Features (What to Actually Build)

To keep it under 10MB and finish on time, only build these three features:

* **Feature 1: The "Pulse Check" Dashboard**
Instead of a boring list, the main screen is a timeline of the day. Every 5 minutes, the app does a "Pulse Check" using the Google Routes API. If transit time between Node A and Node B suddenly spikes from 15 mins to 45 mins, the app turns the timeline segment red and alerts the user.
* **Feature 2: The Dynamic Vibe Slider**
Sometimes the environment doesn't break the trip; the user's mood does. Add a simple toggle at the top of the app: *"High Energy" vs. "Low Battery."* If the user switches to "Low Battery," the app automatically swaps their upcoming "3-hour walking tour" for a "highly-rated cafe nearby" using Google Places.
* **Feature 3: The "Pivot" Resolution (The Magic Moment)**
When a constraint breaks (weather, traffic, mood), the app slides up a card:
> *"Traffic to the Louvre is severely delayed. Pivoting... We found an indoor modern art gallery 3 blocks away. Gemini confirms it matches your 'local spots' preference. Update route?"*



---

### 4. The Decision Engine Logic (What to Prompt Gemini)

This is the most critical part of your hackathon submission. The judges want to see "logical decision making based on user context." Here is the exact system prompt logic you should use when sending data to Gemini to evaluate alternatives:

**The Gemini System Prompt Structure:**

> "You are the decision engine for a travel assistant.
> **User Persona Constraints:** The user only has 48 hours. They refuse to travel more than 20 minutes between locations. They prefer ratings over 4.5. They want indoor activities if it is raining.
> **The Conflict:** The user's 2:00 PM plan at [Original Location] is no longer viable due to [Traffic/Weather/Closed].
> **The Data:** Here are 5 nearby alternatives retrieved from the Google Places API: [JSON Array of Places].
> **Your Task:** Select the single best alternative from the list that strictly adheres to the User Persona Constraints. Return only a JSON object containing the `place_id` of the winner, and a snappy 2-sentence explanation of *why* this perfectly rescues their itinerary."

By forcing Gemini to evaluate raw Google Places data against strict persona constraints, you prove to the judges that your AI isn't just generating text—it is executing logical rules.

---

### 5. The Step-by-Step User Journey (For your Hackathon Demo)

When you record your demo video or write your README, walk through this exact scenario:

1. **Start (10:00 AM):** The user opens the app. It shows a perfect 3-stop itinerary in a city (e.g., Coffee -> Museum -> Park). The UI is calm and green.
2. **The Trigger (11:30 AM):** You (the developer) simulate a "Rain Event" or a "Traffic Spike" via a hidden admin button.
3. **The Alert:** The app interface immediately turns amber. A smooth CSS notification drops down: *"Weather alert: Rain detected. Park visit at 1:00 PM is compromised."*
4. **The Brain at Work:** A skeleton loader appears saying *"Finding dry alternatives within 10 minutes..."* (Behind the scenes, you fetch 5 nearby indoor cafes/museums from Google Places and send them to Gemini).
5. **The Fix:** The app proposes the winning alternative chosen by Gemini. The user clicks "Pivot," the timeline updates, the UI turns green again, and the map routing updates seamlessly.

### 6. Why This Idea Wins the Evaluation Criteria

* **Logical Decision Making:** You aren't just relying on AI to guess; you are feeding it real Google Places data and hard persona constraints.
* **Meaningful Google Integration:** You are using Maps/Routes to detect the problem, Places to find the solution, and Gemini to make the choice.
* **Practical Usability:** Every traveler has experienced a ruined plan. This solves a high-stress, real-world emotional problem.