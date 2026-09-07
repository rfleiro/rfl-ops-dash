# dashboards

Static, dependency-free dashboards. No build step, no backend.

## Layout

    index.html          hub — lists the dashboards
    shared/
      core.js           engine: config, API client, state, sync, rendering
      style.css         design tokens and components
    <id>/
      index.html        one dashboard: its manifest only

Each dashboard has a short `id` that namespaces its stored settings, so they
never collide and each can point at a different data source.

## Adding a dashboard

1. Copy an existing `<id>/` folder to a new one
2. Edit the manifest in its `index.html` (`id`, `title`, data path, sections)
3. Add a row to the registry in the root `index.html`

## Configuration

The data repository and access token are entered at runtime, per dashboard, and
stored only in the browser's own `localStorage`. Nothing is committed here — no
data, no credentials, no analytics, no third-party scripts. All network requests
go to `api.github.com` and nowhere else.
