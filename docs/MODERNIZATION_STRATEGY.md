# Altos Modernization Strategy

**Phase 1 deliverable — analysis only, no code changes in this commit.**

This document is the result of reading every edge function in `supabase/functions/`, the orchestration in `src/pages/FlightPlan.tsx`, the shared type modules in `src/lib/`, and the surrounding hooks/components. The goal: identify what's already strong, what's duplicated or conflicting, and what's genuinely missing — then sequence improvements so each step ships independently without breaking the rest.

The ten-phase ambition from the original prompt (dynamic routing, AI decision layer, digital twin, explainable AI, predictive airspace, etc.) is preserved as the north star in [§5](#5-roadmap--ranked-by-impactrisk), but split into shippable units rather than a single rewrite.

---

## 1. System inventory

### 1.1 Edge functions (Supabase, Deno)

| Function | Role | Notable state writes |
|---|---|---|
| `trajectory-analysis` | Entry point for the planner. Saves the `flight_intent`, does its own conflict scan, fetches weather, computes a `trajectory_score`. | inserts `flight_intents` |
| `route-optimizer` | Generates 5 candidate corridors (direct + 4 perpendicular offsets), scores each on 8 axes (time / wind / weather / turbulence / fuel / traffic / safety / efficiency), returns top 3. Loads & applies learned weights from `route_score_config` and OD history from `route_patterns`. | inserts `routes`, upserts `route_patterns` |
| `weather-intelligence` | Origin + destination current weather, 15- and 30-minute forecast, recommendation (proceed/delay/reroute), urban micro-weather adjustment. | none |
| `airspace-scheduler` | Allocates a `time_slot` in an altitude band based on capacity. | inserts `time_slots` |
| `vertiport-coordinator` | Matches origin/dest text to known vertiports, checks dep/arr capacity, allocates `vertiport_slots`. | inserts `vertiport_slots` |
| `trajectory-predictor` | Linearly interpolates positions of all active flights over the next 5 min, detects pair conflicts at <1.5 km separation in the same altitude band, picks a resolution type. | none |
| `flight-decision-engine` | Consumes outputs of the four above + the `route-optimizer` result, produces a single `GO` / `DELAY` / `REROUTE`. | inserts `flight_decisions` |
| `record-flight-outcome` | After landing: stores actuals, updates the OD pattern's outcome-adjusted score and systematic error, nudges global `route_score_config` weights by `learning_rate`. | upserts `flight_outcomes`, updates `route_patterns`, updates `route_score_config` |
| `pattern-learner` | Read-only OD lookup (used by the client to show historical priors). | none |
| `background-analyzer` | Periodic batch: groups routes from the last 30 days by OD+altitude, recomputes averages into `route_patterns`, and (separately) nudges `route_score_config.weight_safety` if global avg safety drops below 70. | updates `route_patterns`, updates `route_score_config` |

### 1.2 Client orchestration

`src/pages/FlightPlan.tsx` drives the pipeline in this order on the **Intent → Clearance** transition:

1. `trajectory-analysis` (serial — needs the `intent_id` for the rest)
2. `route-optimizer` and the **ATM bundle** (`weather-intelligence`, `airspace-scheduler`, `vertiport-coordinator`, `trajectory-predictor`) — fired in parallel via `Promise.allSettled`
3. `flight-decision-engine` — serial, consumes everything above
4. On **Clearance → Monitoring**: `FlightPlan.persistRoutePattern` runs in the client (a third writer of `route_patterns`)

`background-analyzer` and `record-flight-outcome` run out-of-band and are the system's two learning loops.

### 1.3 Data model (from `supabase/migrations/`)

Tables touched by the pipeline:

- `flight_intents` — the plan; status flows `analyzing → pending → approved → active → landed`.
- `routes` — one row per `route-optimizer` evaluation; carries scores + the full primary/alternate route objects.
- `route_patterns` — per-(origin_key, destination_key, altitude_band) running averages and outcome-adjusted score; the "learned prior" used to bias future scoring.
- `route_score_config` — global scoring weights tuned by both learning loops.
- `flight_decisions` — one row per decision-engine run.
- `flight_outcomes` — actuals captured after landing.
- `airspace_segments`, `time_slots`, `vertiports`, `vertiport_slots` — capacity ledgers.

---

## 2. Duplications and conflicts — concrete findings

Each item below is a real overlap, not a stylistic complaint. Numbers in parentheses are file:line references.

### 2.1 Four independent geocoding tables

| Function | Table name | Cities | Notes |
|---|---|---|---|
| [`route-optimizer/index.ts`](../supabase/functions/route-optimizer/index.ts) (19–37) | `LOCATION_COORDS` | 16 | Includes airport codes (JFK, LAX). |
| [`trajectory-predictor/index.ts`](../supabase/functions/trajectory-predictor/index.ts) (33–43) | `CITY_COORDS` | ~10 | Has odd "downtown"/"airport"/"east" generic keys that resolve to NYC by default. |
| [`trajectory-analysis/index.ts`](../supabase/functions/trajectory-analysis/index.ts) (25–38) | `LOCATION_COORDS` | 11 | Includes London/Paris/Tokyo. |
| [`weather-intelligence/index.ts`](../supabase/functions/weather-intelligence/index.ts) (10–20) | `CITY_COORDS` | 18 | Includes Singapore/Dubai. |

All four have a near-identical `parseTaggedCoords` + `getCoords` + Nominatim fallback wrapper. Consequence: **the same input string can resolve to different coordinates depending on which function receives it**, which means trajectory-analysis's conflict scan, route-optimizer's traffic penalty, and the trajectory-predictor's interpolation can disagree about where a flight actually is.

### 2.2 Three weather fetchers calling the same provider

- `route-optimizer` (149–168) — current only, one Open-Meteo call per ~5 km grid cell, with a per-request `WxCache`.
- `trajectory-analysis` (209–257) — current + hourly, no cache.
- `weather-intelligence` (138–145) — current + hourly for **both** origin and destination, no cache.

A single planner submission hits Open-Meteo ~3 × per request for the origin's current weather alone (once per function), with slightly different feature parsing each time. Beyond cost: the three risk-scoring functions disagree on thresholds (see 2.4).

### 2.3 Three independent conflict-detection algorithms producing three different numbers

| Function | Method | Output used as |
|---|---|---|
| `trajectory-analysis` (165–207) | window-overlap × same-altitude-band × OD string similarity | `conflicts` field on `flight_intents`, fed into `flight-decision-engine` |
| `route-optimizer` (574–601) | window-overlap × proximity ≤20 km to either endpoint | `conflictDensity` → `traffic_score` penalty on each candidate |
| `trajectory-predictor` (152–186) | per-minute great-circle interp × <1.5 km pair separation × same altitude band | `total_conflicts_detected` displayed in `TrajectoryConflictAlert` |

The decision engine uses the first count, the candidate scoring uses the second, the UI shows the third. They are not reconciled.

### 2.4 Risk scoring duplicated with incompatible scales

- `weather-intelligence.computeRisk` (83–104) — 0..100 score, "moderate" at ≥30, "high" at ≥60.
- `route-optimizer.weatherSeverity` (172–190) — 0..1 score, "elevated" at >0.4.
- `trajectory-analysis` (231–252) — boolean tier based on independent wind / gust / precip thresholds (e.g. moderate wind = >30 km/h here vs >20 km/h in `weather-intelligence`).

Same atmospheric conditions can be classified `low` by one function and `moderate` by another in the same request.

### 2.5 Three writers fighting over `route_patterns`

- `route-optimizer` (756–787) — per-flight: increments `flight_count` monotonically, blends running averages.
- `FlightPlan.persistRoutePattern` (453–493) — per-flight, **client-side**: also increments `flight_count` monotonically. **This double-counts every planning session** (route-optimizer already did it).
- `background-analyzer` (44–96) — periodic batch: **overwrites** `flight_count` with the count of `routes` rows in the last 30 days. This wipes out the lifetime counter that the other two maintain.

Result: `flight_count` is currently meaningless after the first batch run.

### 2.6 Two writers fighting over `route_score_config`

- `record-flight-outcome` (207–251) — per-outcome, scaled by `learning_rate`, nudges 4 weights based on the signed systematic error.
- `background-analyzer` (98–129) — periodic batch, fixed +0.02 step on `weight_safety` whenever the global 30-day avg safety drops below 70.

These can oscillate: outcomes nudge safety down because the model was being too cautious; the batch shoves it back up because the resulting safety scores look low.

### 2.7 Three decision models with unaligned thresholds

- `trajectory-analysis` (260–264) — `trajectory_score` start = 95, −10 per conflict, −20 for high weather, etc.
- `flight-decision-engine` (96–191) — decision tree branching on score <55, score <75, conflicts ≥3, etc.
- `FlightPlan.tsx` (260–278, 308–313) — client-side fallback "safety model": `tScore >= 75 && wRisk !== "high" && cCount === 0`.

The cutoffs aren't consistent (e.g. `trajectory-analysis` only penalizes ≥3 conflicts implicitly through count; the decision engine treats ≥3 as a hard rerouting trigger; the client fallback treats any conflict as not-GO). A score of 78 with one conflict can land in three different states depending on which model speaks last.

### 2.8 Three haversine implementations

`route-optimizer:84-94`, `trajectory-predictor:12-18`, `vertiport-coordinator:11-17` — all near-identical. Cheap to deduplicate.

### 2.9 Shared fleet constants hardcoded in 3 places

`EVTOL_BASE_SPEED_KMH = 90` (route-optimizer:82), `EVTOL_SPEED_KMH = 90` (trajectory-predictor:9), `90` literal (vertiport-coordinator:87). A change to one will silently desync the others.

---

## 3. What's already good (don't touch yet)

These are working and well-built — improvements should build on top, not replace.

- **`route-optimizer`'s scoring pipeline.** Multi-axis, weight-driven, with a coherent learning-loop hook via `route_patterns.outcome_adjusted_score`. The fact that weights tune over time is exactly the right shape.
- **Per-request `WxCache` in `route-optimizer`** (281–309). Grid-bucketed (~5 km cells), TTL'd, promise-deduped. The right primitive; it just needs to live in a shared module so the other functions can use it.
- **Aviation helpers in `src/lib/aviation.ts`.** Pilot-style callouts (clock position, cardinal, wind callout, resolution phrasing). This is the seed of the explainable-AI surface — it already speaks in regulator-readable terms.
- **`record-flight-outcome`'s closed loop.** Systematic-error tracking with rate-limited weight updates is the right approach. Just needs to be the *only* writer to `route_score_config`.
- **Client decoupling via `Promise.allSettled`.** The ATM bundle survives one engine failing — the fallback decision in `FlightPlan.tsx` is wisely defensive.

---

## 4. What's genuinely missing for the stated ambitions

These come from the original prompt's phase list, mapped against what exists.

| Capability | Current state | Gap |
|---|---|---|
| **Wind-optimized routing** | `route-optimizer` *scores* candidates against wind but **generates** candidates as 5 fixed perpendicular offsets, unaware of wind direction. | Candidate generator should bias offsets toward tailwind, away from headwind/turbulent corridors. |
| **Optimal altitude routing** | `altitude_band` (low/mid/high) is a user-picked enum. `weather-intelligence` applies a static multiplier (1.0 / 1.15 / 1.3). | No engine actually *picks* the altitude band based on wind/traffic/energy. Should be an output, not an input. |
| **Predictive airspace modeling** | `trajectory-predictor` interpolates active flights linearly for 5 min. | No future-state simulation of *proposed* flights against the predicted state of the airspace. No demand-surge forecast. |
| **Real digital twin** | none | A parallel sim environment that mirrors `flight_intents` state and runs forward trajectories for stress-test and counterfactual rerouting. |
| **Streaming telemetry** | one-shot pipeline | No `supabase.channel(...)` subscriptions in the client; the monitoring step pulls but doesn't push. |
| **Explainable AI** | each engine returns a `reason` string | No structured `{inputs, alternatives_rejected, confidence_breakdown, tradeoffs}` schema. Would graft cleanly onto `flight-decision-engine`'s `inputs_summary`. |
| **Multi-objective optimization** | weighted-sum collapses Pareto frontier | A single high-safety candidate that takes 30% longer is invisible when its overall score is mid. The system should at least *surface* Pareto-dominant alternatives. |
| **Emergency-aware rerouting** | `airspace-scheduler` reads `is_emergency` for slot priority | The decision engine has no emergency branch; the route optimizer has no emergency mode (e.g., direct-to-nearest-vertiport). |

---

## 5. Roadmap — ranked by impact/risk

Each item is sized to ship as one PR. Order is "highest-leverage / lowest-risk first" — not the order the original prompt listed them.

1. **Shared edge-function utilities** *(this is the first refactor; ships next.)*
   - `supabase/functions/_shared/geocode.ts` — single merged city table + `parseTaggedCoords` + Nominatim fallback.
   - `supabase/functions/_shared/weather.ts` — single Open-Meteo fetcher + the existing `WxCache` shape + one canonical `computeRisk`.
   - `supabase/functions/_shared/geo.ts` — `haversine`, `bearingDeg`.
   - `supabase/functions/_shared/constants.ts` — `EVTOL_BASE_SPEED_KMH`, separation minimums, capacity defaults.
   - Migrates 4 functions (`route-optimizer`, `trajectory-analysis`, `trajectory-predictor`, `weather-intelligence`, `vertiport-coordinator`) to import these. Fixes 2.1, 2.2, 2.4, 2.8, 2.9 in one step.

2. **Fix `route_patterns.flight_count` corruption (2.5).** Stop the client from writing patterns (route-optimizer already does it). Split `background-analyzer`'s recent count into a new column (`recent_routes_30d`) so it stops overwriting the lifetime counter. Smallest-possible migration.

3. **Single decision threshold module (2.7).** Pull the cutoffs into `supabase/functions/_shared/decisionThresholds.ts` and have `trajectory-analysis`, `flight-decision-engine`, and the client fallback import the same numbers. No behavior change in the median case; consistency at the edges.

4. **Single learning-loop owner for `route_score_config` (2.6).** Make `record-flight-outcome` the only writer. Convert `background-analyzer` to emit a *recommendation* row in a new table that `record-flight-outcome` reads and applies, rate-limited.

5. **Wind-aware candidate generation in `route-optimizer`.** Augment `buildCandidates` to (a) sample the great-circle midpoint wind once before generating, (b) bias one extra candidate toward the tailwind bearing. Keep all existing candidates so back-compat holds.

6. **Altitude as an engine output, not user input.** Add an `altitude-selector` step (could live inside `route-optimizer` as a pre-scoring sweep across {low, mid, high}) that picks the best band per-candidate. UI keeps the override.

7. **Structured explanation schema.** New `decision_explanations` table: `{ decision_id, inputs[], alternatives_rejected[], tradeoffs[], confidence_breakdown }`. `flight-decision-engine` already has `inputs_summary`; widen it.

8. **Pareto-front surface.** `route-optimizer` already evaluates 5 candidates; expose the Pareto-dominant subset alongside top-3-by-overall.

9. **Streaming monitoring.** `StepMonitoring` should subscribe via `supabase.channel('flight-intents')` for live updates instead of one-shot polling.

10. **Digital twin (deferred).** Materialize as a separate Deno function `digital-twin-sim` that takes a candidate flight intent + the current set of active flights + a forecast horizon, runs forward simulation, returns predicted conflicts/saturation. This is large enough to need its own design doc.

---

## 6. Notes on safety & rollout

- **Backwards compatibility.** The shared-utils refactor (item 1) keeps every function's HTTP contract identical — only internals change. Same for items 2–4.
- **One writer per table.** The consistent theme through items 2 and 4 is *single ownership* of state tables. Today, three writers update `route_patterns` and two update `route_score_config`. After items 2 and 4, both have exactly one writer.
- **No destructive migrations.** The migration in item 2 adds a column; the one in item 4 adds a table. No drops, no renames, no backfills required.
- **Test coverage.** `src/test/` has one example test. Each item above should add at least a unit test for the new shared module or a contract test for the function it touches.

---

## 7. Open questions for the user

These don't block item 1, but they shape items 5–10.

- **Altitude bands** — are `low`/`mid`/`high` mapped to specific AGL ranges anywhere? The migrations declare them as text; the multiplier in `weather-intelligence` hardcodes the impact. We'd want concrete numbers to do real altitude optimization.
- **Vertiport catalog** — the `vertiports` table is populated by migration; will it grow dynamically, or is the matcher in `vertiport-coordinator` (the fuzzy keyword fallback) the long-term plan?
- **Regulator output format** — for the explainability work (item 7), is there a target export format (e.g. ICAO/EASA-style)? Affects schema design.

---

*Phase 1 complete. Item 1 — shared edge-function utilities — ships in the next commit.*
