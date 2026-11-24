# Put NYC Parade Nav on the web

The site is one Node server: the page, the API and the live feed. Deploy it anywhere that runs a container. The steps below use **Google Cloud Run**, since your Maps key already lives in Google Cloud. Render works too.

## Option A: Google Cloud Run (about 10 minutes)

1. Install the gcloud CLI and sign in:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```
2. From the `nyc-nav` folder, deploy:
   ```bash
   gcloud run deploy nyc-parade-nav --source . --region us-east1 --allow-unauthenticated \
     --max-instances 1 --min-instances 1 --timeout 3600 \
     --set-env-vars GOOGLE_MAPS_BROWSER_KEY=YOUR_KEY,GOOGLE_ROUTES_SERVER_KEY=YOUR_KEY,GOOGLE_MAP_ID=DEMO_MAP_ID,CLOCK_MODE=sim
   ```
   - `--max-instances 1` keeps every visitor on the same server, so reports and live updates reach everyone. For more traffic, see "Scaling" below.
   - `--timeout 3600` keeps live-update connections open. Browsers reconnect on their own after that.
3. Cloud Run prints a URL like `https://nyc-parade-nav-xxxx.a.run.app`. That's your website.
4. **Lock the browser key to the site.** In Cloud Console go to Credentials, open your key, and add an HTTP-referrer restriction for `https://nyc-parade-nav-xxxx.a.run.app/*`. If the demo key can't be restricted, create a normal key for the public site.
5. Optional extras:
   - **Screenshot reading:** add `ANTHROPIC_API_KEY=...`.
   - **Road events:** add `NY511_API_KEY=...`.
   - **The real day:** set `CLOCK_MODE=live` on Thanksgiving morning, so nobody can move the shared clock.
   - **Live parade position:** set `OPERATOR_TOKEN=...` to protect the endpoint your team uses to report it.

   Put keys in Secret Manager (`--set-secrets`) instead of plain env vars once others can see the project.

## Option B: Render

Create a new **Web Service** from the folder (push it to a GitHub repo first). Use runtime Docker, or Node with start command `node server.js`. Add the same env vars and pick one instance.

## Before you share the link

- [ ] The map loads and a scenario plans (this checks the keys and referrer restriction).
- [ ] Post a test report from one phone and watch it appear on another within a second.
- [ ] Set a budget alert in Google Cloud Billing, and in the Claude Console if vision is on.
- [ ] `CLOCK_MODE=live` for the real day. Keep a second deploy on `sim` for demos.

## Scaling past one instance

Reports and watched trips live in memory today, and `REPORTS_FILE` keeps reports across restarts on one instance. To run several instances, move reports to Firestore or Redis and fan out live events with Redis pub/sub. The `lib/reports.js` interface (`add`, `confirm`, `active`, `onChange`) is the only thing to swap.
