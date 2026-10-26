import { matchRomGame, type RomMatch } from "./profiles";
import { isExcluded, scriptFromDetails } from "./scripts";
import { detailsUsable, forEachLimited, getAppDetails, getInstalledGames, liveName } from "./steam";
import type { Game, RomGame, ScriptGame, Settings } from "./types";

export interface ScanPlan {
  romAdd: RomGame[];
  romRemove: number[];
  scriptAdd: ScriptGame[];
  scriptRemove: number[];
  /** New entries / removed entries, for the "Done" message. */
  added: number;
  removed: number;
}

interface Probe {
  game: Game;
  usable: boolean;
  rom: RomMatch | null;
  script: string | null;
}

/**
 * Read-only: looks at every installed game (plus anything already listed) and
 * works out what the games lists should become. Never modifies a game.
 *
 * - A non-Steam shortcut whose Target / Launch Options fit a console profile is a
 *   ROM game. That takes priority over being a script game, because some
 *   profiles (the 3DS one) launch through a .sh file.
 * - Otherwise a game whose launch fields point at a .sh file is a script game,
 *   unless the file name matches an exclusion.
 * - Listed games that no longer fit are dropped, but only when Steam gave
 *   usable details for them, so a slow or failed lookup never removes anything.
 * - Exclusions only ever apply to the script side.
 */
export async function scanLibrary(s: Settings): Promise<ScanPlan> {
  const games = new Map<number, Game>();
  for (const g of getInstalledGames()) games.set(g.appid, g);
  for (const e of s.romGames) {
    if (!games.has(e.appid)) games.set(e.appid, { appid: e.appid, name: e.name, kind: "shortcut" });
  }
  for (const e of s.scriptGames) {
    if (!games.has(e.appid)) games.set(e.appid, { appid: e.appid, name: e.name, kind: e.kind });
  }

  const probes = new Map<number, Probe>();
  await forEachLimited([...games.values()], 6, async (game) => {
    const d = await getAppDetails(game.appid);
    if (!d) return;
    const rom = game.kind === "shortcut" ? matchRomGame(d, s.profiles) : null;
    const script = rom ? null : scriptFromDetails(game.kind, d);
    probes.set(game.appid, { game, usable: detailsUsable(game.kind, d), rom, script });
  });

  const plan: ScanPlan = { romAdd: [], romRemove: [], scriptAdd: [], scriptRemove: [], added: 0, removed: 0 };

  /* ---- ROM games ---- */
  const romKnown = new Map(s.romGames.map((e) => [e.appid, e]));
  for (const e of s.romGames) {
    const p = probes.get(e.appid);
    if (p?.usable && !p.rom) plan.romRemove.push(e.appid);
  }
  for (const p of probes.values()) {
    if (!p.rom) continue;
    const name = liveName(p.game.appid) ?? p.game.name;
    const e = romKnown.get(p.game.appid);
    const entry: RomGame = {
      appid: p.game.appid,
      name,
      profileId: p.rom.profile.id,
      profileName: p.rom.profile.name,
      rom: p.rom.rom,
      source: "scan",
    };
    if (!e) {
      plan.romAdd.push(entry);
      plan.added++;
    } else if (e.profileId !== entry.profileId || e.rom !== entry.rom || e.name !== entry.name) {
      plan.romAdd.push(entry); // refresh in place; keeps how it was first added
    }
  }

  /* ---- Script games ---- */
  const scriptKnown = new Map(s.scriptGames.map((e) => [e.appid, e]));
  for (const e of s.scriptGames) {
    // Scan-found entries that now match an exclusion are dropped from the list
    // (the game's launch options are left alone). Entries added by hand stay.
    if (e.source === "scan" && isExcluded(e.script, s.exclusions)) {
      plan.scriptRemove.push(e.appid);
      continue;
    }
    // No .sh path in the launch fields any more (cleared in Steam's own game
    // properties, or the game is now a ROM game).
    const p = probes.get(e.appid);
    if (p?.usable && !p.script) plan.scriptRemove.push(e.appid);
  }
  for (const p of probes.values()) {
    if (!p.script || isExcluded(p.script, s.exclusions)) continue;
    const e = scriptKnown.get(p.game.appid);
    if (!e) {
      plan.scriptAdd.push({
        appid: p.game.appid,
        name: p.game.name,
        script: p.script,
        kind: p.game.kind,
        source: "scan",
      });
      plan.added++;
    } else if (e.script !== p.script) {
      plan.scriptAdd.push({ ...e, script: p.script }); // path changed: update in place
    }
  }

  plan.removed = plan.romRemove.length + plan.scriptRemove.length;
  return plan;
}
