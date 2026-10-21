---
description: View or change the SteinWall budget, e.g. "/steinwall:budget --daily 30 --monthly 400", "--plan api", or "override" to lift today's stop.
argument-hint: "[--daily USD|off] [--monthly USD|off] [--plan api|subscription|auto] [override]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" budget $ARGUMENTS`

Report the result above to the user in one or two sentences. Do not run further commands and do not change the budget yourself.
