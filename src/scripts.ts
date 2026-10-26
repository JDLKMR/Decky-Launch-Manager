// Finding .sh launch scripts in a game's launch fields, and the scan exclusions.
import type { Game } from "./types";
import { basename } from "./steam";

/** Pull the first `.sh` path out of a launch-options / target string. */
export function findScriptPath(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = text.match(/"([^"]+?\.sh)"|'([^']+?\.sh)'|(\S+?\.sh)(?=\s|$)/i);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

const escapeRe = (t: string) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Exclusion match against a script's file name (case-insensitive).
 * - No `*` in the keyword: plain substring match.
 * - With `*`: glob match against the WHOLE file name, `*` = any run of
 *   characters. So `test*` = starts with "test", `*_old.sh` = ends with
 *   "_old.sh", `ap_*_launch*` = contains ap_<anything>_launch.
 */
export function matchesExclusion(fileName: string, keyword: string): boolean {
  const f = fileName.toLowerCase();
  const k = keyword.toLowerCase();
  if (!k.includes("*")) return f.includes(k);
  const re = new RegExp("^" + k.split("*").map(escapeRe).join(".*") + "$");
  return re.test(f);
}

export function isExcluded(scriptPath: string, exclusions: string[]): boolean {
  const file = basename(scriptPath);
  return exclusions.some((k) => matchesExclusion(file, k));
}

/**
 * The .sh path a game's launch fields currently point at, or null if none.
 * Steam games: Launch Options. Shortcuts: Target, then Launch Options.
 */
export function scriptFromDetails(kind: Game["kind"], d: any): string | null {
  return kind === "steam"
    ? findScriptPath(d?.strLaunchOptions)
    : (findScriptPath(d?.strShortcutExe) ??
        findScriptPath(d?.strShortcutLaunchOptions) ??
        findScriptPath(d?.strLaunchOptions));
}
