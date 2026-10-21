---
description: Install the SteinWall status line in Claude Code (shows cost today, budget and blocked actions).
argument-hint: "[--force]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup-statusline $ARGUMENTS`

Report the result above to the user. If it says an existing status line was kept, tell them they can replace it with "/steinwall:setup --force" (the old one is backed up and restored by "steinwall remove-statusline").
