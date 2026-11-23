# Sample configs

Each file is a complete, drop-in `config.json` showing one option. Replace
the placeholder JIDs (`120363...`, `1555...`) and playlist IDs (`PLxxxx`)
with your own. Copy the one you want, then:

```bash
copy examples\per-group-templates.json config.json
node index.js --dry-run   # safe: prints messages, writes no state
npm start
```

| File | Demonstrates |
|---|---|
| `basic.json` | Minimal setup: one channel, one group, one template |
| `per-group-templates.json` | Different message wording per group (group objects with `messageTemplate`, `shortsSuffix`, …) |
| `digest-per-group.json` | Group A gets a daily digest at 08:00, group B gets instant sends; another channel uses channel-level digest |
| `admin-commands.json` | Admin JID for `/status`, `/pause`, `/resume`, `/reload`, `/help` |
| `status-analytics.json` | Daily status report to a status group at `statusHour` (also writes `status.json`) |
| `watchdog.json` | Disconnect auto-restart with admin alerts |
| `multilanguage.json` | Hebrew group and English group using `languageTemplates` |
| `full.json` | Everything combined: languages, digest, filters, quiet hours, timing, watchdog, status |

Notes:

- `targetGroupJids` accepts a plain JID string **or** an object:
  `{ "jid": "...", "language": "he", "messageTemplate": "...", "digest": {...} }`.
- Group settings override channel settings; channel settings override
  global defaults.
- `status.json` is generated on every check tick; open `dashboard.html`
  through a local HTTP server (or GitHub Pages) to view it.
- Admin pause/resume/reload are in-memory — they reset on restart. Edit
  `config.json` to make a change permanent.
