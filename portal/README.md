# Renderer development

The portal is the packaged renderer for the Agent Usage Stat desktop application.

```bash
npm install
npm run dev:portal
```

Run these commands from the repository root. The renderer shares the application's dependency manifest and build path. Development uses Vite on port 4179. Production assets are built into `dist/portal/` and loaded through the desktop application's `aus://` protocol. Production does not start a localhost server.

Key files:

- `index.html`: application layout and visual system
- `portal.js`: aggregation, navigation, charts, tables, and detail interactions
- `../src/desktop/portal-data.ts`: typed ledger-to-renderer snapshot builder
- `scripts/build-data.mjs`: repository CLI adapter for that compiled builder
