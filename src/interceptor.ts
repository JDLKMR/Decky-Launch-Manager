// Intercepts game launches to show the profile prompt: for a game whose launch
// options / target point at a profile script (.sh with a PROFILE_NAMES table),
// and/or a game with game links.
import { removeGame, resolveScript, setGameProfile, setScriptGame, writeProfile } from "./api";
import { withProfileEnv, withoutProfileEnv } from "./launchOptions";
import { type LinkEntry, buildPromptEntries, hasLinks, pickDefaultKey } from "./links";
import { promptForProfile } from "./PromptModal";
import { isExcluded } from "./scripts";
import {
  basename,
  cancelLaunch,
  getGameByAppId,
  getGameId,
  getLaunchInfo,
  getOverview,
  msUntilKillsDone,
  resolveAppId,
  runGame,
  setLaunchOptions,
} from "./steam";
import { gameProfile, snapshot } from "./store";
import { toast } from "./toast";
import type { GameKind, ScriptInfo } from "./types";

/** appIds we relaunched ourselves: their next GameActionStart passes through. */
const bypass = new Set<string>();
/** appIds currently being prompted, so a double-fire cannot stack modals. */
const busy = new Set<string>();

const NO_SCRIPT: ScriptInfo = { path: "", exists: false, hasVariable: false, value: null, envAware: false, excluded: false, profiles: [] };

function notify(body: string) {
  try {
    toast(body);
  } catch {
    console.log(`[Launch Manager] ${body}`);
  }
}

export function registerLaunchInterceptor(): () => void {
  let registration: any;
  try {
    registration = (window as any).SteamClient.Apps.RegisterForGameActionStart(
      (_actionType: number, rawGameActionId: string, action: string) => {
        void onGameActionStart(rawGameActionId, action);
      },
    );
  } catch (e) {
    console.error("[Launch Manager] could not hook game launches", e);
    return () => {};
  }

  return () => {
    try {
      registration?.unregister?.();
    } catch {
      /* ignore */
    }
  };
}

async function onGameActionStart(rawGameActionId: string, action: string) {
  if (action !== "LaunchApp") return;

  // The value Steam hands this callback is a GameID, not an AppID (see
  // resolveAppId). Everything from here on keys off the real AppID.
  const appid = resolveAppId(rawGameActionId);
  if (typeof appid !== "number") {
    console.warn("[Launch Manager] couldn't resolve an AppID for game action", rawGameActionId);
    return;
  }
  const appId = String(appid);

  // Our own relaunch: let it through.
  if (bypass.has(appId)) {
    bypass.delete(appId);
    return;
  }
  if (busy.has(appId)) return;

  const s = snapshot();
  const config = gameProfile(appId);
  const links = hasLinks(config);
  // ROM games only ever prompt for their game links: their Target may itself
  // be a .sh (the 3DS profile) that isn't a profile script.
  const isRom = !!s?.romGames.some((g) => g.appid === appid);
  const listed = s?.scriptGames.find((g) => g.appid === appid);
  const scriptListed = !!listed && !isExcluded(listed.script, s?.exclusions ?? []);

  if (links || (scriptListed && !isRom)) {
    // Prompting switched off: do nothing.
    if (!(config?.enabled ?? s?.askByDefault ?? true)) return;

    // A script game, a game with game links, or both: stop the launch
    // immediately, then take our time.
    busy.add(appId);
    const gameId = getGameId(appid);
    cancelLaunch(gameId);
    try {
      await promptOrLaunch(appId, gameId);
    } finally {
      busy.delete(appId);
    }
    return;
  }

  if (isRom) return;

  // Everything else (never seen before, or last seen without a script) is
  // checked on every launch, so giving a game a profile script takes effect the
  // next time it starts, with no re-scan. The lookup runs alongside the launch
  // and only interrupts it if a script actually turns up; a game that has none
  // just carries on, so this costs nothing visible. The first launch after a
  // script appears is therefore killed a beat late; later ones are intercepted
  // immediately.
  busy.add(appId);
  try {
    const info = await getLaunchInfo(appid);
    const script = await resolveScript(info.exe, info.launchOptions);

    if (!script.path) return;

    const kind: GameKind = getGameByAppId(appid)?.kind ?? "steam";
    // A fresh detection starts from the default prompting setting, same as a scan does.
    const promptNew = snapshot()?.askByDefault ?? true;

    const record = async () => {
      await setScriptGame(appid, info.name, script.path, kind, "scan");
      await setGameProfile(appid, { name: info.name, enabled: promptNew });
    };

    // New games default to no prompt: just record the game and let this launch
    // carry on untouched.
    if (!promptNew) {
      await record();
      return;
    }

    // Stop the launch before anything else: the saves below are backend round
    // trips the script shouldn't get to run through.
    cancelLaunch(info.gameId);

    // The launch is already stopped, so a failed save mustn't abandon it:
    // carry on and prompt anyway.
    try {
      await record();
    } catch (e) {
      console.warn("[Launch Manager] could not save newly detected game", e);
    }

    await promptOrLaunch(appId, info.gameId);
  } catch (e) {
    // Only the lookup above can land here (promptOrLaunch handles its own
    // failures), and the launch hasn't been cancelled yet, so it just carries on.
    console.warn("[Launch Manager] script lookup failed for", appId, e);
  } finally {
    busy.delete(appId);
  }
}

/**
 * Run the prompt flow for a launch that has already been cancelled. If
 * anything throws partway, the game is down and nothing would bring it back,
 * so fall back to launching it unchanged rather than leaving a dead launch.
 */
async function promptOrLaunch(appId: string, gameId: string) {
  try {
    await handleLaunch(appId, gameId);
  } catch (e) {
    console.error("[Launch Manager] launch handling failed; launching unchanged", e);
    notify("Something went wrong with the profile prompt. Launching unchanged.");
    relaunch(appId, gameId);
  }
}

async function handleLaunch(appId: string, knownGameId?: string) {
  const settings = snapshot();
  const variable = settings?.variable ?? "PROFILE";
  const appid = Number(appId);

  const info = await getLaunchInfo(appid);
  const gameId = knownGameId ?? info.gameId;
  const isRom = !!settings?.romGames.some((g) => g.appid === appid);

  // Re-resolve every time: launch options may have changed since we cached,
  // and the script's own PROFILE_NAMES table is the live source of truth for
  // which profiles exist, their names, and their order. It is never cached
  // here, so an edit to the script shows up on the very next launch.
  const script = isRom ? NO_SCRIPT : await resolveScript(info.exe, info.launchOptions);

  const config = gameProfile(appId);
  const links = config?.links ?? [];
  const scriptUsable = !!script.path && script.exists && script.profiles.length > 0;

  if (!scriptUsable && !links.length) {
    // Nothing to offer: launch normally, saying why if there's something to fix.
    if (!script.path) {
      // The script is gone from the launch fields: drop the game from the list.
      // (It is still re-checked on every launch, so a script added later is picked up on its own.)
      if (settings?.scriptGames.some((g) => g.appid === appid)) await removeGame(appid);
    } else if (!script.exists) {
      notify(`Script not found: ${script.path}`);
    } else {
      notify(`No PROFILE_NAMES table found in ${basename(script.path)}. Launching unchanged.`);
    }
    relaunch(appId, gameId);
    return;
  }

  // The game links are still worth offering, but a script that's
  // referenced and missing is worth flagging.
  if (script.path && !script.exists) {
    notify(`Script not found: ${script.path}`);
  }

  // One list: the script's profiles in table order, then game links
  // (each placed by its number override, or last, alphabetically).
  const entries = buildPromptEntries(scriptUsable ? script.profiles : [], links, config?.defaultName);
  const defaultKey = pickDefaultKey(entries, config);

  const choice = await promptForProfile({ entries, defaultKey });

  const picked = choice.entry;
  await setGameProfile(appid, {
    name: info.name,
    enabled: choice.keepAsking,
    ...(picked?.kind === "profile" ? { lastProfile: picked.value, lastLinkId: null } : {}),
    ...(picked?.kind === "default" ? { lastLinkId: null } : {}),
    ...(picked?.kind === "link" ? { lastLinkId: picked.linkId } : {}),
  });

  if (!picked) return; // cancelled: leave the game closed

  if (picked.kind === "link") {
    launchLink(picked);
    return;
  }

  if (picked.kind === "default") {
    // Just this game, opened normally: no script to touch.
    relaunch(appId, gameId);
    return;
  }

  if (!script.hasVariable) {
    notify(`No ${variable}= line in ${basename(script.path)}. Nothing to change.`);
    relaunch(appId, gameId);
    return;
  }

  if (script.envAware) {
    // The script takes PROFILE from the environment, so leave the file alone
    // and pass the choice through the launch options instead.
    try {
      if (!info.loaded) throw new Error("couldn't read this game's launch options");
      const next = withProfileEnv(info.launchOptions, variable, picked.value);
      if (next !== info.launchOptions) setLaunchOptions(appid, next);
    } catch (e) {
      notify(`Not launched. Could not update launch options: ${e}`);
      return;
    }
    relaunch(appId, gameId);
    return;
  }

  const result = await writeProfile(script.path, picked.value);
  if (!result.ok) {
    notify(`Not launched. ${result.error ?? "Could not update the script."}`);
    return;
  }

  // A game that used to pass its profile through launch options and now has
  // a plain assignment in its script: drop the leftover from the launch
  // options. The script's own line wins either way, so a failure here is
  // only untidy and never stops the launch.
  try {
    const cleaned = withoutProfileEnv(info.launchOptions, variable);
    if (info.loaded && cleaned !== info.launchOptions) {
      setLaunchOptions(appid, cleaned);
    }
  } catch (e) {
    console.warn("[Launch Manager] could not clear leftover launch options", e);
  }

  relaunch(appId, gameId);
}

/**
 * Open the linked game instead of running this game's script. Starting it
 * goes through the same launch hook as any other game, so if the linked game
 * has its own profile prompt, that prompt appears as usual.
 */
function launchLink(entry: LinkEntry) {
  if (!getOverview(entry.targetAppId)) {
    notify(`Game not found for game link: ${entry.label}`);
    return;
  }
  runGame(getGameId(entry.targetAppId));
}

function relaunch(appId: string, gameId: string) {
  bypass.add(appId);
  // Give Steam a moment to finish tearing down the cancelled game action, and
  // if cancelLaunch still has kill attempts scheduled (a relaunch with no
  // prompt in between, like a script with no profile table), wait for them
  // too, or one would terminate the game we're about to start.
  const delay = Math.max(400, msUntilKillsDone(gameId) + 150);
  setTimeout(() => {
    runGame(gameId);
    // Safety net: if the launch never reaches us, clear the bypass.
    setTimeout(() => bypass.delete(appId), 10000);
  }, delay);
}
