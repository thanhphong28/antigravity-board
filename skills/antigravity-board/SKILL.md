---
name: antigravity-board
description: Open Antigravity Board by BreezeAI (Antigravity App, IDE & CLI session stats, agent time, tokens, estimated cost, and 12-week activity heatmap) right inside Antigravity or in the browser. Use when the user runs /antigravity-board or asks to view/open Antigravity Board or session stats.
---

# Antigravity Board

1. **In Antigravity App** (when the `antigravity-board_antigravity-board` MCP server is available): call its `open_antigravity_board` tool (pass `{"sync": true}` if the user asked to resync) so the interactive Antigravity Board opens directly in the side pane. Users can also open it full-page anytime from **Plugins -> Antigravity Board** in the left sidebar.
2. **Fallback (Antigravity IDE / CLI or external browser request)**: run the bundled sync script to refresh and open the standalone HTML board in the default browser:

```bash
node --no-warnings ~/.gemini/config/plugins/antigravity-board/dist/sync.mjs open
```
