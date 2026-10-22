// Entry point of SteinWall Lite for Codex (bundled into lite/codex/skills/steinwall-lite/scripts/).
import { main } from "../lite/codex-lite.js";

process.stdout.write(`${main(process.argv.slice(2))}\n`);
