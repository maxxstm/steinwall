# Changelog

## 0.1.0 – first public release

SteinWall runs next to Claude Code and Codex on your machine. Spend less. Break nothing.

### Free
- **Cost brake:** daily and monthly budget from the agent's own token counts, a warning at 80 %, a hard stop at the limit (opt-in on subscriptions, where costs are API-equivalent estimates). Live cost in the Claude Code status line.
- **Action guard:** asks or blocks before recursive deletes, force pushes and destructive git commands, reading secrets (`.env`, SSH keys, tokens) and piping downloads into a shell. Understands bash and PowerShell, including heredocs and here-strings, and `apply_patch` in Codex. In auto and bypass modes, where "ask" would be approved silently, it blocks instead.
- **Loop rescue:** hints after repeated identical failures, forces a change of strategy before a blind retry, and tells you when an agent is stuck.
- **Limit handoff:** writes a handoff file before the 5-hour or weekly limit runs out, so the next session or the other agent can continue.
- **Extension scanner:** checks skills, plugins, commands, agents and MCP servers for prompt injection, hidden instructions, download-and-run, encoded execution, exfiltration and known-malicious or typosquatted packages – before install and at session start.
- **Daily report** with costs, blocked actions, rescued loops and the measured savings.
- **Codex support** through the same hooks, plus **SteinWall Briefing**, a hook-free edition for OpenAI's plugin directory.
- **MCP server** (`steinwall mcp`) with status, report and scan.

### Pro (5-day trial, then $9/month, $90/year or the founder price)
- Cheaper subagent routing in Claude Code, context advisor, trimmed tool output in Codex, project rules, dashboard with history, cross-tool handoff.
- Offline-checked license key, emailed after purchase; self-service portal and a cancel button without login.

### Privacy
- No prompts, code, file paths or keys leave the machine. The only network calls are the license refresh (Pro, sends only the key) and an opt-in daily savings number.
