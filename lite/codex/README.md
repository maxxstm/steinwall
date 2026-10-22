# SteinWall Briefing for Codex

The hook-free edition of [SteinWall](https://github.com/maxxstm/steinwall) for OpenAI's plugin directory, which does not accept plugins with lifecycle hooks.

- **Daily briefing:** cost at API list prices, models, 5-hour and weekly limits, and what an automatic guard would have caught: stuck loops (the same command failing three times or more, with an estimate of what the extra rounds cost) and risky commands (recursive deletes, force pushes, reading secrets, piping downloads into a shell).
- **Extension scan:** checks skills, plugins and MCP servers for prompt injection, hidden shell commands and data exfiltration.

It runs only when you ask, reads Codex's own session logs (`~/.codex/sessions`), writes nothing and sends nothing. It needs Node.js 20 or newer.

## Hook edition

SteinWall's hook edition steps in automatically: cost brake, action guard, loop rescue, handoff before usage limits, and a check before every install. It is installed outside the directory:

```bash
codex plugin marketplace add maxxstm/steinwall
codex plugin add steinwall@steinwall
```

Then approve the hooks once with `/hooks`. Overview of all editions: https://steinwall.dev

## Building

The script in `skills/steinwall-briefing/scripts/` is bundled from `src/lite/` by `npm run build` in the repository root. `npm run package:lite` writes the upload ZIP to `lite/steinwall-briefing-codex.zip`.
