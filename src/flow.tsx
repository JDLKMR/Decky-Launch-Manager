import { fetchSgdbArt, forgetGameProfile, getSettings, listScripts, removeGame, setGameProfile, setRomGame, setScriptGame } from "./api";
import { promptPickGame } from "./LinkModals";
import { newLinkId } from "./links";
import {
  ActionMenuModal,
  ConfirmModal,
  FileBrowserModal,
  ProfilePickerModal,
  ScriptPickerModal,
  subStyle,
} from "./modals";
import { resolveProfile } from "./profiles";
import { ART_LABELS, addToCollection, applyArtwork, applyProfile, applyScript, basename, clearGame, createShortcut } from "./steam";
import { gameProfile } from "./store";
import { toast } from "./toast";
import type { Game, Profile, Settings, SgdbGame } from "./types";
import { showModal } from "./ui";

/** Called with the new settings after a change, so the Decky menu can refresh if it is open. */
type OnSettings = ((s: Settings) => void) | undefined;

/* ------------------------------------------------------------------ */
/* Choose ROM file                                                      */
/* ------------------------------------------------------------------ */
async function applyRom(game: Game, profile: Profile, romPath: string, onSettings: OnSettings): Promise<boolean> {
  try {
    await applyProfile(game, profile, romPath);
    const next = await setRomGame(game.appid, game.name, profile.id, profile.name, romPath, "added");
    onSettings?.(next);
    toast(`${profile.name} profile applied to ${game.name}`);
    return true;
  } catch (e) {
    console.error("[Launch Manager] apply ROM failed", e);
    toast(`Could not update ${game.name}`);
    return false;
  }
}

/**
 * What the New Game window decided about SteamGridDB: a game it matched (or the person picked),
 * `null` for "no match, skip the art", or `undefined` when there was no decision (the match was
 * still loading, or failed), in which case the title is searched for here instead.
 */
export type SgdbChoice = SgdbGame | null | undefined;

/**
 * With "Apply SteamGridDB art" on: apply the first Capsule, Wide Capsule, Hero, Logo and Icon of
 * the SteamGridDB game chosen for a game created by the new-game ROM flow. Never blocks or undoes
 * the ROM assignment. Silent when everything was applied, since the match was already confirmed
 * in the New Game window; it only speaks up when something was missing or failed.
 */
async function artNewRom(game: Game, choice: SgdbChoice) {
  try {
    const settings = await getSettings();
    if (!settings.sgdbArt) return;
    if (choice === null) return; // "No match" was picked on purpose
    if (!settings.sgdbKey) {
      toast("Add your SteamGridDB API key in Settings to fetch art.");
      return;
    }
    toast(`Fetching SteamGridDB art for ${game.name}…`);
    const found = await fetchSgdbArt(game.name, game.appid, choice?.id ?? 0, choice?.name ?? "");
    if (!found.ok) {
      toast(found.error ?? "Could not fetch SteamGridDB art.");
      return;
    }
    const { applied, failed } = await applyArtwork(game.appid, found.assets);
    const label = (kinds: string[]) => kinds.map((k) => ART_LABELS[k as keyof typeof ART_LABELS]).join(", ");
    const notes = [
      found.missing.length ? `none found: ${label(found.missing)}` : "",
      failed.length ? `failed: ${label(failed)}` : "",
    ].filter(Boolean);
    if (notes.length) {
      toast(`SteamGridDB art for ${game.name}${applied.length ? "" : " not applied"} (${notes.join("; ")}).`);
    }
  } catch (e) {
    console.error("[Launch Manager] SteamGridDB art failed", e);
    toast(`Could not apply SteamGridDB art to ${game.name}`);
  }
}

/**
 * With "Add ROMs to collections" on: put a game created by the new-game ROM flow into the
 * Steam collection named after its ROM profile. Never blocks or undoes the ROM assignment.
 */
async function collectNewRom(game: Game, profile: Profile) {
  try {
    if (!(await getSettings()).romCollections) return;
    if ((await addToCollection(game.appid, profile.name)) === "unsupported") {
      toast("This Steam client doesn't support adding games to collections.");
    }
  } catch (e) {
    console.error("[Launch Manager] add to collection failed", e);
    toast(`Could not add ${game.name} to the ${profile.name} collection`);
  }
}

/**
 * A ROM chosen for a game that does not exist yet: the shortcut is created only
 * now (after the ROM and profile are settled), so cancelling earlier leaves nothing behind.
 */
async function applyRomToNew(
  name: string,
  profile: Profile,
  romPath: string,
  onSettings: OnSettings,
  sgdb: SgdbChoice,
) {
  let game: Game;
  try {
    game = await createShortcut(name, profile.target);
  } catch (e) {
    console.error("[Launch Manager] create shortcut failed", e);
    toast(`Could not create ${name}`);
    return;
  }
  // Only a game created here gets art and a collection: assigning a ROM to an existing game leaves both alone.
  if (await applyRom(game, profile, romPath, onSettings)) {
    await artNewRom(game, sgdb);
    await collectNewRom(game, profile);
  }
}

/**
 * Choose ROM file -> (profile chosen automatically by file type, or picked by
 * hand) -> `apply`. Shared by the existing-game and new-game flows.
 */
async function chooseRom(gameName: string, apply: (profile: Profile, romPath: string) => void) {
  try {
    const s = await getSettings();
    if (s.profiles.length === 0) {
      toast("Add a ROM profile first (ROM profiles, in the Launch Manager menu).");
      return;
    }
    showModal(
      <FileBrowserModal
        startPath={s.browserDir}
        onSelect={(romPath, chooseProfile) => {
          const romName = basename(romPath);
          const res = resolveProfile(romName, s.profiles);
          // The modal's toggle forces the picker even when the file type matches a profile.
          if (res.kind === "profile" && !chooseProfile) {
            apply(res.profile, romPath);
            return;
          }
          // Several profiles share this file type: offer only those. With the toggle on, or when
          // no profile matches, offer them all.
          const shared = !chooseProfile && res.kind === "ask" && res.candidates.length > 0;
          showModal(
            <ProfilePickerModal
              gameName={gameName}
              romName={romName}
              profiles={shared ? res.candidates : s.profiles}
              conflict={shared ? res.conflict : null}
              onPick={(p) => apply(p, romPath)}
            />,
          );
        }}
      />,
    );
  } catch (e) {
    console.error("[Launch Manager] could not start ROM flow", e);
    toast("Could not open the ROM browser.");
  }
}

/** ROM for a game that already exists. */
export const startRomFlow = (game: Game, onSettings?: OnSettings) =>
  chooseRom(game.name, (profile, romPath) => applyRom(game, profile, romPath, onSettings));

/** ROM for a brand-new Steam shortcut with the given title. */
export const startNewRomFlow = (name: string, onSettings?: OnSettings, sgdb?: SgdbChoice) =>
  chooseRom(name, (profile, romPath) => applyRomToNew(name, profile, romPath, onSettings, sgdb));

/* ------------------------------------------------------------------ */
/* Add script file                                                      */
/* ------------------------------------------------------------------ */
export async function startScriptFlow(game: Game, onSettings?: OnSettings) {
  try {
    const s = await getSettings();
    if (s.scriptDirs.length === 0) {
      toast("Add a scripts directory first (Script directories, in the Launch Manager menu).");
      return;
    }
    const scripts = await listScripts();
    // With several directories, say which one each script comes from.
    const multi = s.scriptDirs.length > 1;
    const short = (p: string) => p.replace(/^\/home\/deck(?=\/|$)/, "~");
    const where = (sc: { rel: string; dir: string }) =>
      multi ? (sc.rel ? `${short(sc.dir)}/${sc.rel}` : short(sc.dir)) : sc.rel || undefined;
    showModal(
      <ScriptPickerModal
        title="Choose Script File"
        scripts={scripts}
        where={where}
        emptyText={
          multi ? "No .sh files found in your script directories" : `No .sh files found in ${s.scriptDirs[0].path}`
        }
        onPick={async (path) => {
          try {
            await applyScript(game, path);
            const next = await setScriptGame(game.appid, game.name, path, game.kind, "added");
            onSettings?.(next);
            toast(`${basename(path)} assigned to ${game.name}`);
          } catch (e) {
            console.error("[Launch Manager] assign script failed", e);
            toast(`Could not assign a script to ${game.name}`);
          }
        }}
      />,
    );
  } catch (e) {
    console.error("[Launch Manager] could not start script flow", e);
    toast("Could not open the script list.");
  }
}

/* ------------------------------------------------------------------ */
/* Add shortcut profile                                                 */
/* ------------------------------------------------------------------ */
/**
 * Pick the game a new shortcut profile opens (and what it is called in the launch
 * prompt), then add it to this game's launch prompt.
 */
export async function startProfileFlow(game: Game, onSettings?: OnSettings) {
  try {
    const picked = await promptPickGame({
      title: "Add Shortcut Profile",
      description: "Pick a game for this one's launch prompt to open. It will show up alongside the other profiles.",
      confirmLabel: "Add",
      askName: true,
      excludeAppId: game.appid,
    });
    if (!picked) return;
    // Read the latest links from the cache, so two quick additions can't overwrite each other.
    const links = gameProfile(game.appid)?.links ?? [];
    const next = await setGameProfile(game.appid, {
      name: game.name,
      links: [...links, { id: newLinkId(), targetAppId: picked.appId, name: picked.name }],
    });
    onSettings?.(next);
    toast(`Shortcut profile "${picked.name}" added to ${game.name}`);
  } catch (e) {
    console.error("[Launch Manager] add shortcut profile failed", e);
    toast(`Could not add a shortcut profile to ${game.name}`);
  }
}

/* ------------------------------------------------------------------ */
/* Clear launch options                                                 */
/* ------------------------------------------------------------------ */
/**
 * Yes/No confirmation, then clear the game's launch fields and drop it from the
 * ROM and script games lists. The one clear flow: the trash buttons in the Decky menu and
 * "Clear launch options" on game pages both go through here. A game's shortcut
 * profiles are not launch options, so they are kept.
 */
export function confirmClear(
  game: { appid: number; name: string; kind: Game["kind"] },
  onSettings?: OnSettings,
  notify = false,
) {
  const kept = gameProfile(game.appid)?.links?.length ?? 0;
  showModal(
    <ConfirmModal
      title="Clear Launch Options?"
      body={
        <>
          Clear the launch options for <b>{game.name}</b>?
          {kept > 0 && (
            <div style={{ ...subStyle, fontSize: "0.85em", marginTop: "6px" }}>
              Its {kept} shortcut profile{kept === 1 ? "" : "s"} will be kept.
            </div>
          )}
        </>
      }
      onConfirm={async () => {
        try {
          clearGame(game);
          // Not `onSettings?.(await removeGame(...))`: that skips the call entirely
          // (and so never updates the lists) when there is no onSettings.
          const next = await removeGame(game.appid);
          onSettings?.(next);
          if (notify) toast(`Launch options cleared for ${game.name}`);
        } catch (e) {
          console.error("[Launch Manager] clear failed", e);
          toast(`Could not clear ${game.name}`);
        }
      }}
    />,
  );
}

/**
 * For a game that is only in the list because it has shortcut profiles (no ROM, no
 * script): there are no launch options to clear, so this removes the profiles instead.
 */
export function confirmRemoveProfiles(game: { appid: number; name: string }, onSettings?: OnSettings) {
  showModal(
    <ConfirmModal
      title="Remove Shortcut Profiles?"
      body={
        <>
          Remove all shortcut profiles from <b>{game.name}</b>? Its launch options are not changed.
        </>
      }
      onConfirm={async () => {
        try {
          const next = await forgetGameProfile(game.appid);
          onSettings?.(next);
        } catch (e) {
          console.error("[Launch Manager] remove shortcut profiles failed", e);
          toast(`Could not update ${game.name}`);
        }
      }}
    />,
  );
}

/* ------------------------------------------------------------------ */
/* The game page button                                                 */
/* ------------------------------------------------------------------ */
export function openLaunchMenu(game: Game) {
  showModal(
    <ActionMenuModal
      game={game}
      onRom={() => startRomFlow(game)}
      onScript={() => startScriptFlow(game)}
      onProfile={() => startProfileFlow(game)}
      onClear={() => confirmClear(game, undefined, true)}
    />,
  );
}
