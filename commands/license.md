---
description: Show SteinWall Pro status (trial, license) or activate a license key, e.g. "/steinwall:license activate SW1....".
argument-hint: "[activate <key> | refresh]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" license $ARGUMENTS`

Show the result above to the user. If a referral code is shown, mention that each referred Pro user earns them one free month.
