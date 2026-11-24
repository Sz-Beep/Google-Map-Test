# Parade-day agent: design notes

These notes cover the questions behind this build: what Google Maps misses, how the agent gets notified, how it spots blockers, which sources it trusts, and how it re-routes with Google.

## 1. What a consumer map misses on parade day

The NYPD, NYC DOT and MTA publish all of this ahead of time. Most of it is time-windowed, and a map that only shows "road closed" (or nothing) doesn't capture it.

| Gap | Example (2026 plan) | Why a route goes wrong |
|---|---|---|
| **Closures with start and end times** | CPW 72nd–88th closed from 2 a.m. Wed to 3 p.m. Thu; 7th Ave 32nd–42nd closed to 8 p.m. | A route is only wrong at certain times. "Closed" without "until when" gives the wrong answer at 12:30. |
| **Reopening at NYPD discretion** | West Side Rag reported that UWS streets generally stayed closed into Thursday afternoon, past the posted noon reopening | The posted end time is optimistic, so the agent adds a buffer and labels its confidence. |
| **Pedestrian barricades** | Spectators line CPW and 6th Ave from early morning. The NYPD keeps only a few designated crossings on 6th Ave (in past advisories: 58th, 52nd, 48th, 44th, 40th/41st, 39th, 37th). | Walking directions treat every crosswalk as open. This is Dev's "barricaded, crowds 10 deep" moment. |
| **Station closures and exit-only entrances** | 81 St-Museum of Natural History and 57 St (F) are closed 4–11 a.m. 72 St (B/C) is exit-only via 70 St until 11. Columbus Circle's north exits are closed. | Transit routing can board you at a closed station unless the MTA pushes it into the schedule feed. |
| **Bus frozen zones** | Buses can't cross the route, and the 79th St transverse is closed | A bus step that crosses the route is unusable even if the schedule says otherwise. |
| **The parade's live position** | Crossings reopen block by block as the tail passes | No public feed exists, so the agent models it and corrects with live reports. |

I couldn't find published reports of specific Google Maps failures at the 2025 parade, so treat the gaps above as what the agent must cover, not as documented incidents.

## 2. How the agent gets notified

These are polled server-side in `lib/feeds.js`. The health of each is shown in the app and at `/api/alerts`.

| Source | What it gives | Cadence | Key |
|---|---|---|---|
| MTA GTFS-rt alerts (`camsys/all-alerts.json`) | Planned and unplanned subway, bus and rail changes, by route and stop | 60 s | Optional |
| MTA elevator and escalator feed (`nyct_ene.json`) | Step-free access outages | 5 min | Optional |
| MTA Subway Stations dataset (data.ny.gov) | ADA flag per station | Daily | None |
| 511NY events API | NYC DOT and NYPD road events and special-event closures | 2 min | Free dev key |
| NYC Open Data: Permitted Event Information (CECM) | Permitted closures for the parade | Hourly | None |
| CECM / NYPD / MTA parade notices | Closure schedule, station rules and crossings, encoded with sources in `lib/parade.js` | Once, re-checked the night before | None |
| Live parade position | Head and tail reports (an operator, or a person watching the broadcast) via `POST /api/parade/position` | Ad hoc | None |

The user hears about changes this way: watching a trip opens a Server-Sent Events stream with browser notifications. In production the same events go out as push, SMS, or a message inside ChatGPT, Gemini or Claude through the MCP server described in the outline.

## 3. How the agent finds blockers

`lib/blockers.js` replays each Google route **at the time the traveler would reach each point**:

1. It decodes each step's polyline and times every vertex using the step durations, or the transit departure and arrival timestamps.
2. **On foot:** Does the route cross the parade line? If so, at what distance along the route and at what time? A crossing is blocked from 6 a.m. until the tail passes plus 20 minutes. At an NYPD crossing it becomes "expect about a 15 minute wait" instead. The CPW formation area (77th–86th) and walking along the crowd are checked too, and the crowd check is a hard blocker for wheelchair users.
3. **Car or bus:** Does the route cross a "wall" closure (CPW, CPS/59th, 6th Ave, 34th, Columbus formation) or run more than 50 m along any closed segment while it's closed?
4. **Subway or rail:** The boarding and exit stations are checked against the MTA station rules, active MTA alerts for that line, and, for wheelchair users, ADA status and elevator outages.

Every blocker carries a source link and a confidence label: `official`, `reported`, `prior-year`, `model` or `live`.

## 4. How the agent re-routes using the Google Routes API

The Routes API has no "avoid this area" option, and transit requests can't take intermediate waypoints. So the agent remaps by changing what it asks Google for (`lib/planner.js`):

| Mode | Strategy | Google call |
|---|---|---|
| Walk / bike | Force the route through an open NYPD crossing, or around the ends of the route (CPW & 90th, 6th & 30th) | `computeRoutes` with `intermediates: [{address, via: true}]` |
| Drive / rideshare | Force a corridor that stays open: the 97th St transverse, 6th Ave at 18th, or the West Side Highway | Same, with via waypoints |
| Transit | Drop buses if a bus is stuck. Otherwise **stitch** a walk to an open station (79 St on the 1, 72 St on the 1/2/3, 63 St-Lexington Av…) with a transit leg from there. | `transitPreferences.allowedTravelModes`, or two calls (WALK then TRANSIT, departing when the walk ends) |
| Any | **Wait**: if every blocker clears by itself, leave when it clears | Transit is re-asked with the new `departureTime`. Walk and drive reuse the same geometry. |

Each candidate is re-checked with the same blocker engine and ranked: clean routes first, then earliest arrival, then least walking. With an arrive-by time, the agent returns "leave by" with a 10-minute parade-day buffer. Each plan makes at most 8 Google calls. When nothing is blocked, it makes exactly one.

## 5. Community reports (photo or screenshot)

- **Posting:** Pin the spot and add a photo or screenshot. The image is sent to the Claude API, which returns `{kind, summary, where, until, lines, source_seen}`. The reporter checks the result and posts it, and it reaches every open browser over `/api/live` (SSE) right away.
- **Trust:** One report is a warning. A second report within 60 m, or a "Still there" tap from someone else, makes it a blocker. Two "Gone" votes, or the time running out (30–60 min by type), clears it.
- **Effect on routes:** A watched trip is re-checked the moment a report lands. Barricade and crowd reports affect walking legs, closure reports affect cars and buses, and station reports affect subway steps within 120 m.
- **Privacy:** Images are never stored, and the prompt tells the model not to transcribe faces, names or plates.
- **Abuse limits:** Posting is rate-limited per IP and limited to Manhattan. Reports only become blockers once a second person confirms them.

## 6. Guardrails (from the outline)

- **No bookings or payments in v1.** The test suite checks that no such capability exists.
- **Location is opt-in.** It's held only while a trip is watched and deleted when the trip ends or is stopped.
- **Every alert and blocker links to its source,** with a confidence label.
- **When unsure, the agent says so:** "No clean option found — walking directions with a live check are the fallback."

## 7. Known limits and what to do next

- Street geometry for closures uses a Manhattan-grid approximation (±50 m). That's enough to detect crossing or running along a street. To tighten it, geocode each closure endpoint once with Google's Geocoding API and cache the result.
- The parade clock is a model (8:30 step-off, head reaching Herald Square about 9:30, tail about noon). Wire in live reports on the day.
- The 2026 crossing list in the code comes from earlier years' NYPD advisories. Replace it when the NYPD publishes the 2026 traffic advisory.
- The 2026 closure times come from press coverage of the city notice. Verify them against the official CECM notice before relying on them.
