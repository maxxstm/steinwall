import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all local SteinWall data. STEINWALL_HOME overrides it (used by tests). */
export function steinwallHome(): string {
  return process.env.STEINWALL_HOME || join(homedir(), ".steinwall");
}

export const configFile = () => join(steinwallHome(), "config.json");
export const usageDir = () => join(steinwallHome(), "usage");
export const stateDir = () => join(steinwallHome(), "state");
export const cursorsFile = () => join(stateDir(), "cursors.json");
export const lockDir = () => join(steinwallHome(), ".lock");
export const errorLog = () => join(steinwallHome(), "logs", "errors.log");
/** Where the currently installed plugin lives; rewritten on every session start because the path changes per plugin version. */
export const pluginRootFile = () => join(steinwallHome(), "plugin-root");
export const statuslineLauncher = () => join(steinwallHome(), "bin", "statusline.mjs");
export const statuslineBackupFile = () => join(stateDir(), "statusline-backup.json");

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
