// Entry point of SteinWall Briefing for Codex (bundled into lite/codex/skills/steinwall-briefing/scripts/).
import { main } from "../lite/codex-lite.js";

process.stdout.write(`${main(process.argv.slice(2))}\n`);
