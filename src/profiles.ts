import type { Profile } from "./types";

/** "SFC, .gb  gbc" -> [".sfc", ".gb", ".gbc"] (lower-case, leading dot, de-duplicated). */
export function normalizeFileTypes(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    let t = raw.trim().toLowerCase();
    if (!t || t === ".") continue;
    if (!t.startsWith(".")) t = "." + t;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export const describeFileTypes = (p: Profile) =>
  p.fileTypes.length ? p.fileTypes.join(", ") : "No file type";

/** Length of the longest of the profile's file types that `fileName` ends with (0 = none). */
function matchLength(fileName: string, p: Profile): number {
  const name = fileName.toLowerCase();
  return p.fileTypes.reduce((best, t) => (name.endsWith(t) && t.length > best ? t.length : best), 0);
}

export type Resolution =
  | { kind: "profile"; profile: Profile }
  /** `candidates`: the profiles sharing the file type (empty when none match). */
  | { kind: "ask"; conflict: string | null; candidates: Profile[] };

/**
 * Decide which profile a ROM file maps to.
 * - The longest matching file type wins, so ".xiso.iso" beats a plain ".iso".
 * - Exactly one profile owns that type: apply it without asking.
 * - Several profiles own the identical type (or none match): ask.
 *   `conflict` and `candidates` are set only for the several-profiles case, so the picker
 *   can say why and offer just the profiles that share the type.
 */
export function resolveProfile(fileName: string, profiles: Profile[]): Resolution {
  const name = fileName.toLowerCase();
  let best = 0;
  let owners: Profile[] = [];
  for (const p of profiles) {
    for (const t of p.fileTypes) {
      if (!name.endsWith(t)) continue;
      if (t.length > best) {
        best = t.length;
        owners = [p];
      } else if (t.length === best && !owners.includes(p)) {
        owners.push(p);
      }
    }
  }
  if (owners.length === 1) return { kind: "profile", profile: owners[0] };
  if (owners.length > 1) {
    const type = owners[0].fileTypes.find((t) => name.endsWith(t) && t.length === best) ?? "";
    return { kind: "ask", conflict: type, candidates: owners };
  }
  return { kind: "ask", conflict: null, candidates: [] };
}

/* ------------------------------------------------------------------ */
/* Recognising games that already use a profile (for the library scan) */
/* ------------------------------------------------------------------ */

/** Loose form for comparing what Steam stored with what a profile would write: quotes dropped, spaces collapsed. */
const canon = (s: string) => s.replace(/["']/g, "").replace(/\s+/g, " ").trim();
const escapeRe = (t: string) => t.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");

/** The ROM path if `launch` is what `template` produces for some ROM, else null. */
function extractRom(template: string, launch: string): string | null {
  const parts = canon(template).split("<rom_path>");
  if (parts.length < 2) return null; // a template without <rom_path> can't identify a ROM
  const m = launch.match(new RegExp("^" + parts.map(escapeRe).join("(\\/.+?)") + "$"));
  return m ? m[1] : null;
}

export interface RomMatch {
  profile: Profile;
  rom: string;
}

/**
 * Is this non-Steam shortcut set up like one of the profiles? Its Target must be
 * the profile's Target and its Launch Options must fit the profile's template
 * with a ROM path in place of `<rom_path>`. If several profiles fit, the one
 * whose file type matches the ROM wins.
 */
export function matchRomGame(
  details: { strShortcutExe?: string; strShortcutLaunchOptions?: string; strLaunchOptions?: string } | null,
  profiles: Profile[],
): RomMatch | null {
  const exe = canon(details?.strShortcutExe ?? "");
  if (!exe) return null;
  const launch = canon(details?.strShortcutLaunchOptions ?? details?.strLaunchOptions ?? "");
  const hits: RomMatch[] = [];
  for (const profile of profiles) {
    if (canon(profile.target) !== exe) continue;
    const rom = extractRom(profile.launchOptions, launch);
    if (rom) hits.push({ profile, rom });
  }
  if (hits.length <= 1) return hits[0] ?? null;
  const base = (p: string) => p.split("/").pop() ?? p;
  return [...hits].sort((a, b) => matchLength(base(b.rom), b.profile) - matchLength(base(a.rom), a.profile))[0];
}
