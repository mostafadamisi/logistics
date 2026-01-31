# Tactical Logistics Optimizer

FastAPI backend with a static frontend dashboard.

## Render deploy
1) Push this repo to GitHub (or GitLab).
2) In Render, create a **New Web Service** and connect the repo.
3) Render will detect `render.yaml` and use it automatically.
4) Deploy and open the service URL. The dashboard is at `/frontend/index.html`.

Notes:
- The service expects the platform to provide a `PORT` environment variable.
- Health check endpoint: `/health`

