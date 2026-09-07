# ops-dash

A single-page static dashboard. No build step, no dependencies, no backend.

Configuration (data repository and access token) is entered at runtime and
stored in the browser's own `localStorage`. Nothing is committed here.

## What's in this repo

- `index.html` — the entire application

## What's not in this repo

- No data of any kind
- No credentials
- No analytics, telemetry, or third-party scripts

All network requests go to `api.github.com` and nowhere else.
