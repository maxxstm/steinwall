---
description: Turn the anonymous contribution to SteinWall's public savings counter on or off ("on" / "off"). Opt-in, off by default.
argument-hint: "on | off"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" telemetry $ARGUMENTS`

Show the result above to the user in one sentence.
