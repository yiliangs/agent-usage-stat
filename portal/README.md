# Renderer development

The portal is the packaged renderer for the Agent Usage Stat desktop application.

```bash
npm install
npm run dev
```

Development uses Vite on port 4179. Production assets are built into `dist/portal/` and loaded through the desktop application's `aus://` protocol. Production does not start a localhost server.

Key files:

- `index.html`: application layout and visual system
- `portal.js`: aggregation, navigation, charts, tables, and detail interactions
- `scripts/build-data.mjs`: shard normalization for renderer data
