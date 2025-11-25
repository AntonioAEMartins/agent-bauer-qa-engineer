# Agent Bauer — Parallel QA Pipeline

Agent Bauer is an agentic QA copilot built for teams that value unit tests but rarely have the time—or desire—to write them. During the YC 24h Hackathon we paired Mastra’s workflow engine with a GitHub app so users can connect a repository, hand the analysis to autonomous agents, and receive a fully formed PR containing the highest‑leverage Vitest file plus coverage telemetry. A production version of the experience runs at [agent-bauer.vercel.app](https://agent-bauer.vercel.app/).

---

### 1. What is Agent Bauer?

Agent Bauer is a plug‑and‑play QA pipeline for JavaScript/TypeScript monorepos. Once a repository is linked, agents fan out inside an isolated Docker container, map the codebase, plan the riskiest surface, write a Vitest file, and open a PR—no local tooling required. The goal is to collapse the time between “we should have tests” and “we just merged a meaningful suite,” while staying opinionated about safety (short‑lived branch, deterministic artifacts, coverage snapshots).

- **Problem today:** engineers know tests matter but they get deprioritized, especially in fast-moving teams where context switching is expensive.
- **With Agent Bauer:** attaching a repo triggers an entirely automated workflow that delivers context reports, planned targets, concrete tests, and coverage estimates back to the product dashboard and Mastra backend.

---

### 2. Goal of this repo

This repository hosts the Mastra backend that orchestrates the end-to-end workflow triggered by the frontend/back-office stack. It exposes a single `/start-full-pipeline` entry point, spins up ephemeral Docker runners, coordinates agents, and emits structured alerts so the user-facing dashboard can display progress and results.

#### 2.1 Why this workflow matters

- **Test debt shrinks automatically:** every run focuses on the most critical module instead of spreading effort thinly across the repo.
- **Trusted automation:** cloning happens inside a disposable container using a short-lived PAT, guaranteeing isolation from the Mastra host and the user’s infrastructure.
- **Continuous feedback:** descriptions, detected stacks, PR URLs, and coverage payloads are streamed to the frontend so teams see value while the workflow is still running.

#### 2.2 System architecture

- **Next.js frontend + Hono backend (repo #1):**
  - Users authenticate, install the GitHub app, and pick repositories.
  - The backend issues RPC calls that translate into HTTP requests against this Mastra server (repo #2) to start the workflow.
  - Alerts sent back by Mastra update the project dashboard in real time.
- **Mastra workflow backend (this repo):**
  - Exposes `/start-full-pipeline`, validates credentials, and writes `.docker.credentials` (with `GITHUB_PAT`) before launching the workflow.
  - Orchestrates each step via Mastra workflows, streaming progress through `notifyStepStatus` to the frontend backend.
- **Ephemeral Docker runner:**
  - Each run builds a minimal Ubuntu base image, injects credentials, and clones the selected repository.
  - All agentic steps execute inside the container; artifacts (tests, coverage JSON) are persisted or POSTed before the container is torn down.
- **GitHub app + alerts pipeline:**
  - The GitHub app supplies repo-level access for cloning and PR automation.
  - Alerts, PR URLs, coverage stats, and descriptions are posted to `${BASE_URL}/api/...` endpoints for the frontend to render.

---

### 3. How it works

The workflow lives in `src/mastra/index.ts` and composes typed sub-workflows under `src/mastra/workflows/test/`. Each major phase both logs to stdout (optionally in `alerts_only` mode) and emits alert payloads for the UI.

#### 3.1 Docker initialization & repository clone

1. **`dockerSetupStep`** – Builds the Ubuntu-based image, ensures Docker is warm, and mounts `agent.context.json`.
2. **`githubCloneStep`** – Copies `GITHUB_PAT` from `.docker.credentials`, clones the user-selected repository, and verifies HEAD.
3. **`postProjectDescriptionStep`** – Runs a fast repository scrape to summarize the project; the summary is POSTed to `${BASE_URL}/api/projects/:projectId/description`.
4. **`postProjectStackStep`** – Detects frameworks, libraries, build systems, and forwards the stack payload to the frontend.

#### 3.2 Knowledge construction phase

1. **`contextGatheringStartStep`** – Signals the frontend that deep analysis is underway.
2. **`analyzeRepositoryStep`** – Extracts structure (services, packages, main targets) and risk signals.
3. **`analyzeCodebaseStep`** – Scans source hotspots, dependency graphs, and recent churn.
4. **`analyzeBuildDeploymentStep`** – Inspects build commands, CI configs, and deployment manifests.
5. **`synthesizeContextStep`** – Blends the above into an executive summary and plan prerequisites.
6. **`saveContextStep`** – Persists context to `/app/agent.context.json` for downstream steps.
7. **`checkSavedPlanStep`** – Ensures a usable plan exists before moving on; otherwise retries or surfaces an alert.

#### 3.3 Unit test planning & GitHub PR

1. **`loadContextAndPlanStep`** – Loads the saved plan, ranks modules, and chooses the highest-priority surface.
2. **`generateTestCodeStep`** – Produces a Vitest file targeting the chosen module (TypeScript only).
3. **`finalizeTestsStep`** – Runs static checks/linting, validates imports, and saves the artifact in the repo.
4. **`prepareCommitStep`** – Creates a temporary Git branch, stages changes, and signs the commit.
5. **`createPullRequestStep`** – Pushes the branch via the GitHub app credentials and opens the PR.
6. **`postPrUrlStep`** – Sends the PR URL back to the frontend so users can review immediately.

#### 3.4 Coverage & finalization

1. **`runCoverageStep`** – Executes Vitest coverage (or falls back to estimation if Vitest isn’t available) and collates TypeScript metrics.
2. **`postCoverageStep`** – Posts the structured coverage response to `${BASE_URL}/api/coverage`.
3. **`fullPipelineOutputNormalizer`** – Normalizes the entire run result, ensures alerts are closed, and tears down the container.

---

### 4. Running locally (dev / debug)

Agent Bauer typically runs in the cloud, but you can reproduce the full experience locally to iterate on the workflow or connect a staging GitHub app.

#### 4.1 Mastra backend (this repo)

```bash
npm install
echo "GITHUB_PAT=ghp_your_token" > .docker.credentials
npm run dev
```

- Node.js ≥ 20.9 and Docker Desktop/daemon must be running.
- The Mastra dev server listens on `http://localhost:4111` and exposes `/api/start-full-pipeline`.
- Logs respect `MASTRA_LOG_LEVEL` and `LOG_MODE=alerts_only` if set.

#### 4.2 Frontend + GitHub app (companion repo)

1. Clone the Next.js + Hono repository (frontend/back-office).
2. Start the frontend:
   ```bash
   npm install
   npm run dev
   ```
3. Expose the frontend to GitHub via ngrok (for webhook + OAuth callbacks):
   ```bash
   ngrok http 3000
   ```
4. Update the GitHub app settings with the ngrok URL each time it changes.
5. Configure the frontend backend to call `http://localhost:4111/start-full-pipeline` for workflow runs.

#### 4.3 Quick smoke check

1. Launch Docker, the Mastra backend, the frontend, and ngrok.
2. Install the GitHub app through the UI, pick a repository, and trigger a run.
3. Watch alerts stream into the frontend as phases complete.
4. Inspect the resulting PR and coverage payload after the workflow finalizes.

---

### 5. Environment & credentials

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Enables Groq models for planning/context synthesis (optional fallback to OpenAI). |
| `OPENAI_API_KEY` | Default provider for Mastra agents. |
| `BASE_URL` | Backend base URL receiving project info, PR URLs, and coverage (defaults to `http://localhost:3000`). |
| `MASTRA_LOG_LEVEL` | (Optional) `fatal|error|warn|info|debug|trace|silent`, default `debug`. |
| `LOG_MODE`/`MASTRA_LOG_MODE` | (Optional) set to `alerts_only` to suppress verbose logs. |

**GitHub credentials:** store `GITHUB_PAT=<token>` inside `.docker.credentials` (or provide via Bearer header). The file is copied into the container, used for clone + push, and deleted before teardown.

---

### 6. Guardrails & scope

- **One test per run:** each execution delivers a single, high-impact Vitest file focused on the most critical module detected.
- **TypeScript + Vitest only:** repositories outside that stack are currently out of scope.
- **Isolated branch + PR:** the workflow never pushes to default branches; it creates a short-lived branch, opens the PR, and surfaces the URL for human review.
- **Immutable context:** all context artifacts live inside the container and are re-generated on every run to avoid stale plans.

---

### 7. Production

```bash
npm run build
npm run start
```

`mastra start` serves the bundled Hono app from `.mastra/output`, ready for the frontend/backend pair to call in production.

---

### 8. Key files

- `src/mastra/index.ts` – entry point registering workflows and HTTP routes.
- `src/mastra/workflows/full-pipeline-workflow.ts` – top-level orchestration.
- `src/mastra/workflows/test/01-docker-setup-workflow.ts` – Docker + cloning.
- `src/mastra/workflows/test/02-context-gathering-workflow.ts` – knowledge construction.
- `src/mastra/workflows/test/03-test-generation-workflow.ts` – planning + test synthesis.
- `src/mastra/workflows/test/04-github-pr-workflow.ts` – branch + PR automation.
- `src/mastra/workflows/test/05-coverage-analysis-workflow.ts` – coverage + reporting.
