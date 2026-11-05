# Isadek apps

The app list for [Isadek OS](https://github.com/isaadac/Isadek). Computers running Isadek OS download
`apps.tsv` at each login and add any new apps to the Isadek Hub and menu.

## Add an app
Click `apps.tsv` → the pencil icon, add one line, and commit. Columns are separated by **tabs**:

| Column | Example |
|---|---|
| id (lowercase, dashes) | `prayer-journal` |
| Name | `Prayer Journal` |
| Link | `https://claude.ai/artifact/...` (only claude.ai links are accepted) |
| Menu category | `Utility`, `Education`, `Office`, `Game`, `Graphics`, `Network` or `AudioVideo` |
| Icon text | 1–3 characters, e.g. `PJ` |
| Icon colour | `#7c3aed` |
| Description | `Daily prayer notes` |
| Offline copy | `no` (offline copies are only possible in an ISO build) |

To remove an app, delete its line.
