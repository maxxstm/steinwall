---
description: Check skills, plugins and MCP servers for malicious patterns (prompt injection, hidden shell commands, data exfiltration). Use before installing an extension, e.g. "/steinwall:scan ./some-skill" or "--installed" for everything installed.
argument-hint: "<path...> | --installed"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" scan $ARGUMENTS`

Show the scan result above to the user. If anything is marked DO NOT INSTALL or SUSPICIOUS, explain the top findings in plain words and do not install it without the user's explicit decision.
