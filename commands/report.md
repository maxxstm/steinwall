---
description: SteinWall daily report - cost, savings, blocked actions and rescued loops. Optional "--date YYYY-MM-DD".
argument-hint: "[--date YYYY-MM-DD]"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" report $ARGUMENTS`

Show the SteinWall report above to the user as-is. Do not run further commands.
