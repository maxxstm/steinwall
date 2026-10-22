# SteinWall Lite for Codex

The hook-free edition of [SteinWall](https://github.com/maxxstm/steinwall) for OpenAI's plugin directory, which does not accept plugins with lifecycle hooks.

- **Daily briefing:** cost at API list prices, models, 5-hour and weekly limits, and what full SteinWall would have caught: stuck loops (the same command failing three times or more, with an estimate of what the extra rounds cost) and risky commands (recursive deletes, force pushes, reading secrets, piping downloads into a shell).
- **Extension scan:** checks skills, plugins and MCP servers for prompt injection, hidden shell commands and data exfiltration.

It runs only when you ask, reads Codex's own session logs (`~/.codex/sessions`), writes nothing and sends nothing.

## Full edition

The free full edition steps in automatically through hooks: cost brake, action guard, loop rescue, handoff before usage limits, and a check before every install.

```bash
codex plugin marketplace add maxxstm/steinwall
codex plugin add steinwall@steinwall
```

Then approve the hooks once with `/hooks`. SteinWall Pro adds more savings for Claude Code and Codex: https://steinwall.dev

## Building

The script in `skills/steinwall-lite/scripts/` is bundled from `src/lite/` by `npm run build` in the repository root. `npm run package:lite` writes the upload ZIP to `lite/steinwall-lite-codex.zip`.
