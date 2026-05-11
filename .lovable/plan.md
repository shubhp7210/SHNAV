## Plan: Altos system fixes & improvements

### 1. Persistent flight data + learning
- Flights already persist via `flight_intents`, `routes`, `flight_decisions`, `route_patterns`. Wire `pattern-learner` edge function to run automatically after each completed flight (call it from `FlightPlan.tsx` on submission/clearance acceptance).
- Ensure `route-optimizer` reads from `route_patterns` (already does via `historical_suggestion`) and biases new routes toward proven waypoints.

### 2. Remove altitude band
- Remove from `StepIntent.tsx` (UI selector + label).
- Remove `altitudeBand` field from `FlightPlanData` in `FlightPlan.tsx` and stop passing it to all edge functions.
- Drop column via migration on `flight_intents`, `airspace_segments`, `route_patterns` (or keep nullable with default for safety — preferred: keep DB columns nullable with default to avoid breaking historical rows, but stop sending from frontend and ignore in edge functions).

### 3. Decision engine stability — remove fallback
- In `StepClearance.tsx`, remove the "Decision engine unavailable — proceed with manual review" fallback panel.
- In `FlightPlan.tsx`, ensure decision engine call always succeeds: retry once on failure, and on hard failure produce a deterministic local "DELAY 10 min — recomputing" decision rather than null.
- Edge function `flight-decision-engine` already always returns; harden it with try/catch around DB insert so a DB failure doesn't 500.
- Remove any "manual override" UI references.

### 4. Alternative route selection
- In `RouteOptimizerCard.tsx`, make alternate route cards clickable → calls `onSelectRoute(route)`.
- Lift selection state into `FlightPlan.tsx` (`data.selectedRouteId`); when changed, re-run `flight-decision-engine` with the chosen route as primary.
- Trim alternate display to: label, ETA, distance, overall score, one-line reason.

### 5. Dashboard navigation
- Add a top nav bar / Home button to `Dashboard.tsx` linking back to `/`.

### 6. Real-time tracking (replace simulation)
- In `StepMonitoring.tsx`, replace the synthetic interval-driven position sweep with `navigator.geolocation.watchPosition`.
- Persist each update into `trajectory_updates` (with `flight_intent_id`, `aircraft_id`, lat/lon/speed/heading).
- Compute `is_on_route` + `deviation_meters` against route waypoints; trigger reroute via `route-optimizer` when deviation > threshold.
- Keep a "Demo simulation" toggle off by default for environments without GPS.

### 7. Cleaner recommendation output
- Simplify `FlightDecisionPanel.tsx` to show: Decision (GO/DELAY/REROUTE), departure time, delay (if any), one-line reason, confidence as a single bar. Move technical inputs behind a collapsible "Technical details".

### Technical notes
- Migration: add `is_on_route`/`deviation_meters` already exist on `trajectory_updates`. No new tables required.
- Edge functions to redeploy: `flight-decision-engine`, `route-optimizer`, `pattern-learner`, `trajectory-predictor`, `weather-intelligence`.
- Files to edit: `StepIntent.tsx`, `StepClearance.tsx`, `StepMonitoring.tsx`, `FlightPlan.tsx`, `RouteOptimizerCard.tsx`, `FlightDecisionPanel.tsx`, `Dashboard.tsx`, plus the listed edge functions.

Approve to proceed.