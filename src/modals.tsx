import { useEffect, useMemo, useRef, useState } from "react";
import { FaArrowUp, FaCheck, FaFile, FaFolder, FaGamepad, FaLink, FaPlus, FaTerminal, FaTrash } from "react-icons/fa";
import { deleteProfile, getSettings, listDir, saveProfile, searchSgdbGames, setExclusions } from "./api";
import { describeFileTypes, normalizeFileTypes } from "./profiles";
import type { DirListing, Game, Profile, ScriptFile, Settings, SgdbGame } from "./types";
import {
  DialogBody,
  DialogButton,
  DialogHeader,
  DropdownItem,
  Focusable,
  ModalRoot,
  TextField,
  ToggleField,
  showModal,
} from "./ui";

type CloseProps = { closeModal?: () => void };

export const itemStyle = {
  display: "block",
  width: "100%",
  textAlign: "left" as const,
  marginBottom: "8px",
};
export const subStyle = { fontSize: "0.75em", opacity: 0.6, wordBreak: "break-all" as const };
const labelStyle = { overflow: "hidden", textOverflow: "ellipsis" };
const rowStyle = { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 };
const ellipsis = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
};

// Buttons that share a row: DialogButton has a wide default minimum width, so four of them
// overflow the modal unless they are allowed to shrink and split the row evenly.
const editorButtonStyle = { flex: "1 1 0", minWidth: 0, padding: "10px 8px" };

const joinPath = (base: string, name: string) => `${base.replace(/\/$/, "")}/${name}`;

/* ------------------------------------------------------------------ */
/* Game page button: what do you want to do?                           */
/* ------------------------------------------------------------------ */
export function ActionMenuModal({
  game,
  onRom,
  onScript,
  onProfile,
  onClear,
  closeModal,
}: {
  game: Game;
  onRom: () => void;
  onScript: () => void;
  onProfile: () => void;
  onClear: () => void;
} & CloseProps) {
  const choose = (fn: () => void) => () => {
    closeModal?.();
    fn();
  };
  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>Add Launch Options</DialogHeader>
      <DialogBody>
        <div style={{ ...subStyle, fontSize: "0.9em", marginBottom: "12px" }}>{game.name}</div>
        {/* ROM launch options are written to a non-Steam shortcut's Target / Start In / Launch Options. */}
        {game.kind === "shortcut" && (
          <DialogButton style={itemStyle} onClick={choose(onRom)}>
            <div style={rowStyle}>
              <FaGamepad />
              <span style={ellipsis}>Choose ROM file</span>
            </div>
          </DialogButton>
        )}
        <DialogButton style={itemStyle} onClick={choose(onScript)}>
          <div style={rowStyle}>
            <FaTerminal />
            <span style={ellipsis}>Choose script file</span>
          </div>
        </DialogButton>
        {/* A shortcut profile is an entry in this game's launch prompt that opens another game. */}
        <DialogButton style={itemStyle} onClick={choose(onProfile)}>
          <div style={rowStyle}>
            <FaLink />
            <span style={ellipsis}>Add shortcut profile</span>
          </div>
        </DialogButton>
        <DialogButton style={itemStyle} onClick={choose(onClear)}>
          <div style={rowStyle}>
            <FaTrash />
            <span style={ellipsis}>Clear launch options</span>
          </div>
        </DialogButton>
      </DialogBody>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* Add ROM: a new Steam game, or an existing one?                      */
/* ------------------------------------------------------------------ */
export function AddRomModal({
  onNew,
  onExisting,
  closeModal,
}: {
  onNew: () => void;
  onExisting: () => void;
} & CloseProps) {
  const choose = (fn: () => void) => () => {
    closeModal?.();
    fn();
  };
  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>Add ROM</DialogHeader>
      <DialogBody>
        <DialogButton style={itemStyle} onClick={choose(onNew)}>
          <div style={rowStyle}>
            <FaPlus />
            <span style={ellipsis}>New Game</span>
          </div>
        </DialogButton>
        <DialogButton style={itemStyle} onClick={choose(onExisting)}>
          <div style={rowStyle}>
            <FaGamepad />
            <span style={ellipsis}>Existing Game</span>
          </div>
        </DialogButton>
      </DialogBody>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* New Game: title, and the SteamGridDB game its art comes from         */
/* ------------------------------------------------------------------ */
const MATCH_DELAY_MS = 500;

/**
 * A SteamGridDB game as "Title (year)": the title in the button's normal text color, the year
 * dimmed to gray. Neither sets a color of its own, so both invert with the button when it is
 * focused (white button text turns dark) instead of staying white on the white highlight.
 */
function SgdbGameLabel({ game }: { game: SgdbGame }) {
  return (
    <span style={ellipsis}>
      <span>{game.name}</span>
      {game.year ? <span style={{ opacity: 0.55 }}> ({game.year})</span> : null}
    </span>
  );
}

/** Search SteamGridDB by title and pick a game (or "No match", to skip the art). */
function SgdbMatchModal({
  initialQuery,
  selectedId,
  onPick,
  closeModal,
}: {
  initialQuery: string;
  /** The game currently chosen: undefined = none, so "No match" is the checked row. */
  selectedId: number | undefined;
  onPick: (game: SgdbGame | null) => void;
} & CloseProps) {
  const [query, setQuery] = useState(initialQuery);
  const [games, setGames] = useState<SgdbGame[]>([]);
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setGames([]);
      setStatus("done");
      return;
    }
    setStatus("loading");
    let cancelled = false;
    // Search straight away for the title it was opened with; wait for a pause in typing after that.
    const timer = setTimeout(
      async () => {
        try {
          const r = await searchSgdbGames(q);
          if (cancelled) return;
          if (r.ok) {
            setGames(r.games);
            setStatus("done");
          } else {
            setGames([]);
            setError(r.error ?? "Could not search SteamGridDB.");
            setStatus("error");
          }
        } catch (e) {
          if (cancelled) return;
          console.error("[Launch Manager] SteamGridDB search failed", e);
          setGames([]);
          setError("Could not search SteamGridDB.");
          setStatus("error");
        }
      },
      q === initialQuery.trim() ? 0 : MATCH_DELAY_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const choose = (game: SgdbGame | null) => () => {
    onPick(game);
    closeModal?.();
  };

  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>SteamGridDB Match</DialogHeader>
      <DialogBody>
        <TextField label="Search" value={query} onChange={(e: any) => setQuery(e.target.value)} />
        <div style={{ marginTop: "12px" }}>
          <DialogButton style={itemStyle} onClick={choose(null)}>
            <div style={rowStyle}>
              <span style={{ ...ellipsis, opacity: 0.8 }}>No match (skip art)</span>
              {selectedId === undefined && <FaCheck />}
            </div>
          </DialogButton>
          {games.map((g) => (
            <DialogButton key={g.id} style={itemStyle} onClick={choose(g)}>
              <div style={rowStyle}>
                <SgdbGameLabel game={g} />
                {g.id === selectedId && <FaCheck />}
              </div>
            </DialogButton>
          ))}
          {status === "loading" && <div style={{ opacity: 0.7 }}>Searching…</div>}
          {status === "error" && <div style={{ opacity: 0.7 }}>{error}</div>}
          {status === "done" && games.length === 0 && query.trim() && (
            <div style={{ opacity: 0.7 }}>No games found.</div>
          )}
        </div>
      </DialogBody>
    </ModalRoot>
  );
}

/**
 * Title for a new Steam shortcut. Nothing is created until a ROM and profile are chosen.
 *
 * With "Apply SteamGridDB art" on there is also a SteamGridDB match field: it follows the title
 * with the closest match until the person picks one themselves. `onSubmit` gets the chosen game,
 * `null` for "no match", or `undefined` when the option is off or no match was decided.
 */
export function NewGameModal({
  onSubmit,
  closeModal,
}: { onSubmit: (name: string, sgdb: SgdbGame | null | undefined) => void } & CloseProps) {
  const [name, setName] = useState("");
  const [sgdb, setSgdb] = useState<{ enabled: boolean; hasKey: boolean }>({ enabled: false, hasKey: false });
  const [match, setMatch] = useState<SgdbGame | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [manual, setManual] = useState(false); // the person picked a match, so stop following the title
  const trimmed = name.trim();

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((s) => alive && setSgdb({ enabled: s.sgdbArt, hasKey: !!s.sgdbKey }))
      .catch((e) => console.error("[Launch Manager] could not read settings", e));
    return () => {
      alive = false;
    };
  }, []);

  const searching = sgdb.enabled && sgdb.hasKey && !manual;
  useEffect(() => {
    if (!searching) return;
    if (!trimmed) {
      setMatch(null);
      setStatus("idle");
      return;
    }
    setStatus("loading");
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await searchSgdbGames(trimmed);
        if (cancelled) return;
        setMatch(r.ok ? (r.games[0] ?? null) : null);
        setStatus(r.ok ? "done" : "error");
      } catch (e) {
        if (cancelled) return;
        console.error("[Launch Manager] SteamGridDB match failed", e);
        setMatch(null);
        setStatus("error");
      }
    }, MATCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, searching]);

  const pick = () =>
    showModal(
      <SgdbMatchModal
        initialQuery={trimmed}
        selectedId={match?.id}
        onPick={(game) => {
          setManual(true);
          setMatch(game);
          setStatus("done");
        }}
      />,
      window,
    );

  const matchLabel = !sgdb.hasKey ? (
    <span style={{ ...ellipsis, opacity: 0.6 }}>Add your SteamGridDB API key in Settings</span>
  ) : match ? (
    <SgdbGameLabel game={match} />
  ) : status === "loading" ? (
    <span style={{ ...ellipsis, opacity: 0.6 }}>Searching…</span>
  ) : status === "error" ? (
    <span style={{ ...ellipsis, opacity: 0.6 }}>Could not search SteamGridDB</span>
  ) : (
    <span style={{ ...ellipsis, opacity: 0.6 }}>{trimmed || manual ? "No match" : "Enter a title first"}</span>
  );

  // A match is only passed on once it is settled (picked, or found and not still changing).
  const decided = manual || status === "done";
  const choice = sgdb.enabled && sgdb.hasKey && decided ? match : undefined;

  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>New Game</DialogHeader>
      <DialogBody>
        <TextField label="Title" value={name} onChange={(e: any) => setName(e.target.value)} />
        {sgdb.enabled && (
          <div style={{ marginTop: "12px" }}>
            <div style={{ ...subStyle, marginBottom: "6px", wordBreak: "normal", textTransform: "uppercase" }}>SteamGridDB Match</div>
            <DialogButton style={itemStyle} disabled={!sgdb.hasKey} onClick={pick}>
              <div style={rowStyle}>
                {matchLabel}
                <span style={{ opacity: 0.6 }}>▾</span>
              </div>
            </DialogButton>
          </div>
        )}
        <Focusable
          // @ts-ignore
          style={{ display: "flex", gap: "8px", marginTop: "16px" }}
        >
          <DialogButton
            disabled={!trimmed}
            onClick={() => {
              closeModal?.();
              onSubmit(trimmed, choice);
            }}
          >
            Continue
          </DialogButton>
          <DialogButton onClick={() => closeModal?.()}>Cancel</DialogButton>
        </Focusable>
      </DialogBody>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* Folder / file browser                                               */
/* ------------------------------------------------------------------ */

/** Large ROM folders are shown a page at a time so the list stays responsive. */
const PAGE = 150;

function useListing(startPath: string) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const latest = useRef(0);
  const load = async (p: string) => {
    const mine = ++latest.current;
    const next = await listDir(p);
    if (mine !== latest.current) return; // a newer navigation superseded this one
    setLimit(PAGE);
    setListing(next);
  };
  useEffect(() => {
    load(startPath);
  }, []);
  return { listing, load, limit, showMore: () => setLimit((n) => n + PAGE) };
}

export function FileBrowserModal({
  startPath,
  onSelect,
  closeModal,
}: {
  startPath: string;
  /** `chooseProfile` is true when the toggle asks to pick the ROM profile by hand. */
  onSelect: (path: string, chooseProfile: boolean) => void;
} & CloseProps) {
  const { listing, load, limit, showMore } = useListing(startPath);
  const [chooseProfile, setChooseProfile] = useState(false);
  const files = listing?.files.slice(0, limit) ?? [];
  const hidden = (listing?.files.length ?? 0) - files.length;
  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>Choose ROM File</DialogHeader>
      <DialogBody>
        <div style={{ marginBottom: "10px" }}>
          <ToggleField
            label="Choose different ROM profile on selection"
            checked={chooseProfile}
            onChange={(v: boolean) => setChooseProfile(v)}
          />
        </div>
        <div style={{ ...subStyle, marginBottom: "10px", fontSize: "0.9em" }}>{listing?.path ?? "Loading…"}</div>
        {listing?.parent && (
          <DialogButton style={itemStyle} onClick={() => load(listing.parent!)}>
            <div style={rowStyle}>
              <FaArrowUp />
              <span style={ellipsis}>Up one level</span>
            </div>
          </DialogButton>
        )}
        {listing?.dirs.map((d) => (
          <DialogButton key={`d:${d}`} style={itemStyle} onClick={() => load(joinPath(listing.path, d))}>
            <div style={rowStyle}>
              <FaFolder />
              <span style={ellipsis}>{d}</span>
            </div>
          </DialogButton>
        ))}
        {listing &&
          files.map((f) => (
            <DialogButton
              key={`f:${f}`}
              style={itemStyle}
              onClick={() => {
                closeModal?.();
                onSelect(joinPath(listing.path, f), chooseProfile);
              }}
            >
              <div style={rowStyle}>
                <FaFile />
                <span style={ellipsis}>{f}</span>
              </div>
            </DialogButton>
          ))}
        {hidden > 0 && (
          <DialogButton style={itemStyle} onClick={showMore}>
            Show more ({hidden} more files)
          </DialogButton>
        )}
        {listing && listing.dirs.length === 0 && listing.files.length === 0 && (
          <div style={{ opacity: 0.7 }}>This folder is empty.</div>
        )}
      </DialogBody>
    </ModalRoot>
  );
}

/** Folders only; used to choose where the ROM browser starts, and for script directories. */
export function DirectoryBrowserModal({
  title,
  startPath,
  onSelect,
  closeModal,
}: { title: string; startPath: string; onSelect: (path: string) => void } & CloseProps) {
  const { listing, load } = useListing(startPath);
  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>{title}</DialogHeader>
      <DialogBody>
        <div style={{ ...subStyle, marginBottom: "10px", fontSize: "0.9em" }}>{listing?.path ?? "Loading…"}</div>
        <DialogButton
          style={itemStyle}
          disabled={!listing}
          onClick={() => {
            if (!listing) return;
            closeModal?.();
            onSelect(listing.path);
          }}
        >
          <div style={rowStyle}>
            <FaCheck />
            <span style={ellipsis}>Use this folder</span>
          </div>
        </DialogButton>
        {listing?.parent && (
          <DialogButton style={itemStyle} onClick={() => load(listing.parent!)}>
            <div style={rowStyle}>
              <FaArrowUp />
              <span style={ellipsis}>Up one level</span>
            </div>
          </DialogButton>
        )}
        {listing?.dirs.map((d) => (
          <DialogButton key={d} style={itemStyle} onClick={() => load(joinPath(listing.path, d))}>
            <div style={rowStyle}>
              <FaFolder />
              <span style={ellipsis}>{d}</span>
            </div>
          </DialogButton>
        ))}
        {listing && listing.dirs.length === 0 && <div style={{ opacity: 0.7 }}>No subfolders here.</div>}
      </DialogBody>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* ROM profile selection (no / ambiguous file type)                */
/* ------------------------------------------------------------------ */
export function ProfilePickerModal({
  gameName,
  romName,
  profiles,
  conflict,
  onPick,
  closeModal,
}: {
  gameName: string;
  romName: string;
  profiles: Profile[];
  /** Set when several profiles claim the ROM's file type. */
  conflict: string | null;
  onPick: (profile: Profile) => void;
} & CloseProps) {
  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>Choose ROM Profile</DialogHeader>
      <DialogBody>
        <div style={{ marginBottom: "6px" }}>
          <b>{romName}</b> for {gameName}
        </div>
        {conflict && (
          <div style={{ ...subStyle, fontSize: "0.85em", marginBottom: "10px" }}>
            More than one profile uses {conflict}, so pick which one to apply.
          </div>
        )}
        {profiles.map((p) => (
          <DialogButton
            key={p.id}
            style={{ ...itemStyle, marginTop: "8px" }}
            onClick={() => {
              closeModal?.();
              onPick(p);
            }}
          >
            <div style={ellipsis}>{p.name}</div>
            <div style={subStyle}>{describeFileTypes(p)}</div>
          </DialogButton>
        ))}
      </DialogBody>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* Script picker                                                       */
/* ------------------------------------------------------------------ */
export function ScriptPickerModal({
  title,
  scripts,
  emptyText,
  where,
  onPick,
  closeModal,
}: {
  title: string;
  scripts: ScriptFile[];
  emptyText: string;
  where: (s: ScriptFile) => string | undefined;
  onPick: (path: string) => void;
} & CloseProps) {
  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>{title}</DialogHeader>
      <DialogBody>
        {scripts.length === 0 && <div style={{ opacity: 0.7 }}>{emptyText}</div>}
        {scripts.map((sc) => (
          <DialogButton
            key={sc.path}
            style={itemStyle}
            onClick={() => {
              closeModal?.();
              onPick(sc.path);
            }}
          >
            <div style={labelStyle}>{sc.name}</div>
            {where(sc) && <div style={subStyle}>{where(sc)}</div>}
          </DialogButton>
        ))}
      </DialogBody>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* Game picker (Decky menu "Add Script"): "Choose a game…" dropdown    */
/* ------------------------------------------------------------------ */
export function GamePickerModal({
  kind,
  games,
  current,
  onPick,
  closeModal,
}: {
  /** What is being assigned: decides the wording of the modal. */
  kind: "rom" | "script" | "profile";
  games: Game[];
  /** appid -> file name currently assigned (a ROM or a script, matching `kind`). */
  current: Record<number, string>;
  onPick: (game: Game) => void;
} & CloseProps) {
  const noun = kind === "rom" ? "ROM" : "script";
  const heading = kind === "rom" ? "Add ROM" : kind === "script" ? "Add Script" : "Add Shortcut Profile";
  const prompt =
    kind === "rom"
      ? "Choose the non-Steam game to assign a ROM to."
      : kind === "script"
        ? "Choose the game to assign a launch script to."
        : "Choose the game whose launch prompt should offer shortcut profiles.";
  const options = useMemo(() => games.map((g) => ({ data: g.appid, label: g.name })), [games]);
  const [selected, setSelected] = useState<number | null>(null);
  const settled = useRef(false);
  const settle = (game: Game | null) => {
    if (settled.current) return;
    settled.current = true;
    closeModal?.();
    if (game) onPick(game);
  };
  const chosen = games.find((g) => g.appid === selected);
  const existing = chosen ? current[chosen.appid] : undefined;
  return (
    <ModalRoot onCancel={() => settle(null)} onEscKeypress={() => settle(null)}>
      <div style={{ fontSize: "1.4em", fontWeight: "bold" }}>{heading}</div>
      <div style={{ marginTop: "8px", opacity: 0.8 }}>{prompt}</div>
      {games.length === 0 ? (
        <div style={{ marginTop: "16px", opacity: 0.8 }}>
          {kind === "rom"
            ? "No non-Steam games were found in your library."
            : "No installed games were found in your library."}
        </div>
      ) : (
        <div style={{ marginTop: "12px" }}>
          <DropdownItem
            label="Game"
            strDefaultLabel="Choose a game…"
            rgOptions={options}
            selectedOption={selected}
            onChange={(option: { data: number }) => setSelected(option.data)}
          />
        </div>
      )}
      {existing && (
        <div style={{ marginTop: "8px", opacity: 0.7, fontSize: "0.85em" }}>
          Currently uses {existing}. Picking a new {noun} replaces it.
        </div>
      )}
      <Focusable
        // @ts-ignore
        style={{ display: "flex", gap: "8px", marginTop: "16px" }}
      >
        <DialogButton disabled={!chosen} onClick={() => settle(chosen ?? null)}>
          Continue
        </DialogButton>
        <DialogButton onClick={() => settle(null)}>Cancel</DialogButton>
      </Focusable>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* Exclusions (keywords / * patterns matched against .sh file names)   */
/* ------------------------------------------------------------------ */
export function ExclusionsModal({
  initial,
  onChange,
  closeModal,
}: { initial: string[]; onChange: (s: Settings) => void } & CloseProps) {
  const [list, setList] = useState<string[]>(initial);
  const [text, setText] = useState("");
  const save = async (next: string[]) => {
    const s = await setExclusions(next);
    setList(s.exclusions);
    onChange(s);
  };
  const add = async () => {
    const k = text.trim();
    setText("");
    if (!k) return;
    await save([...list, k]);
  };
  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>Script Exclusions</DialogHeader>
      <DialogBody>
        <div style={{ ...subStyle, marginBottom: "10px", fontSize: "0.9em" }}>
          Ignore any script files with these keywords/patterns when scanning, and never show a launch prompt for them.
        </div>
        <TextField label="Keyword or (*) pattern" value={text} onChange={(e: any) => setText(e.target.value)} />
        <DialogButton style={{ ...itemStyle, marginTop: "8px" }} disabled={!text.trim()} onClick={add}>
          Add Exclusion
        </DialogButton>
        {list.length === 0 && <div style={{ opacity: 0.7, marginTop: "8px" }}>No exclusions yet.</div>}
        {list.map((k) => (
          <Focusable
            key={k}
            // @ts-ignore
            style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" }}
            // @ts-ignore
            flow-children="row"
          >
            <div style={{ flex: 1, minWidth: 0, wordBreak: "break-all" }}>{k}</div>
            <DialogButton
              style={{ width: "auto", minWidth: 0, padding: "8px 14px" }}
              onClick={() => save(list.filter((x) => x !== k))}
            >
              Remove
            </DialogButton>
          </Focusable>
        ))}
      </DialogBody>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* Yes/No confirmation, cursor starts on "Yes"                         */
/* ------------------------------------------------------------------ */
export function ConfirmModal({
  title,
  body,
  onConfirm,
  closeModal,
}: { title: string; body: any; onConfirm: () => void } & CloseProps) {
  const wrap = useRef<HTMLDivElement>(null);
  // Belt and braces: make sure the cursor starts on "Yes" (the first button).
  useEffect(() => {
    const t = setTimeout(() => {
      (wrap.current?.querySelector('[class*="DialogButton"], button') as HTMLElement | null)?.focus();
    }, 150);
    return () => clearTimeout(t);
  }, []);
  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>{title}</DialogHeader>
      <DialogBody>
        <div style={{ marginBottom: "16px" }}>{body}</div>
        <div ref={wrap}>
          <Focusable
            // @ts-ignore
            style={{ display: "flex", gap: "12px" }}
            // @ts-ignore
            flow-children="row"
          >
            <DialogButton
              {...{ autoFocus: true }}
              style={{ flex: 1 }}
              onClick={() => {
                closeModal?.();
                onConfirm();
              }}
            >
              Yes
            </DialogButton>
            <DialogButton style={{ flex: 1 }} onClick={() => closeModal?.()}>
              No
            </DialogButton>
          </Focusable>
        </div>
      </DialogBody>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* Copy a ROM profile: pick the new one's name                          */
/* ------------------------------------------------------------------ */
function CopyProfileModal({
  source,
  onCopy,
  closeModal,
}: {
  source: Profile;
  onCopy: (name: string) => void;
} & CloseProps) {
  const [name, setName] = useState(`${source.name} copy`);
  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>Copy Profile</DialogHeader>
      <DialogBody>
        <div style={{ ...subStyle, fontSize: "0.9em", marginBottom: "12px" }}>
          The copy borrows the Target and Launch options of {source.name}.
        </div>
        <TextField label="Name" value={name} onChange={(e: any) => setName(e.target.value)} />
        <Focusable
          // @ts-ignore
          style={{ display: "flex", gap: "8px", marginTop: "16px" }}
          // @ts-ignore
          flow-children="row"
        >
          <DialogButton
            disabled={!name.trim()}
            onClick={() => {
              closeModal?.();
              onCopy(name.trim());
            }}
          >
            Copy
          </DialogButton>
          <DialogButton onClick={() => closeModal?.()}>Cancel</DialogButton>
        </Focusable>
      </DialogBody>
    </ModalRoot>
  );
}

/* ------------------------------------------------------------------ */
/* Add / edit a ROM profile                                        */
/* ------------------------------------------------------------------ */
export function ProfileEditorModal({
  profile,
  profiles,
  onChange,
  closeModal,
}: {
  /** null = new profile */
  profile: Profile | null;
  profiles: Profile[];
  onChange: (s: Settings) => void;
} & CloseProps) {
  const [name, setName] = useState(profile?.name ?? "");
  const [types, setTypes] = useState((profile?.fileTypes ?? []).join(", "));
  const [target, setTarget] = useState(profile?.target ?? "");
  const [launch, setLaunch] = useState(profile?.launchOptions ?? "");
  const [busy, setBusy] = useState(false);

  const clashes = normalizeFileTypes(types)
    .map((t) => ({
      t,
      names: profiles.filter((p) => p.id !== profile?.id && p.fileTypes.includes(t)).map((p) => p.name),
    }))
    .filter((c) => c.names.length > 0);

  const save = async () => {
    setBusy(true);
    try {
      const next = await saveProfile({
        id: profile?.id,
        name: name.trim(),
        fileTypes: normalizeFileTypes(types),
        target: target.trim(),
        launchOptions: launch.trim(),
      });
      onChange(next);
      closeModal?.();
    } catch (e) {
      console.error("[Launch Manager] save profile failed", e);
      setBusy(false);
    }
  };

  // Copy: a new profile with this one's Target and Launch options and a name of the person's choosing (no file
  // types, so it never claims a ROM on its own), then straight into its editor to adjust it.
  const copy = () =>
    showModal(
      <CopyProfileModal
        source={profile!}
        onCopy={async (copyName) => {
          try {
            const before = new Set(profiles.map((p) => p.id));
            const next = await saveProfile({
              name: copyName,
              fileTypes: [],
              target: profile!.target,
              launchOptions: profile!.launchOptions,
            });
            onChange(next);
            closeModal?.();
            const created = next.profiles.find((p) => !before.has(p.id));
            if (created) {
              showModal(<ProfileEditorModal profile={created} profiles={next.profiles} onChange={onChange} />);
            }
          } catch (e) {
            console.error("[Launch Manager] copy profile failed", e);
          }
        }}
      />,
    );

  const remove = () =>
    showModal(
      <ConfirmModal
        title="Delete profile?"
        body={`Delete the "${profile?.name}" profile? Games already set up with it are not changed.`}
        onConfirm={async () => {
          onChange(await deleteProfile(profile!.id));
          closeModal?.();
        }}
      />,
    );

  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <DialogHeader>{profile ? "Edit Profile" : "Add Profile"}</DialogHeader>
      <DialogBody>
        <TextField
          label="Name"
          description="Usually the console name or abbreviation"
          value={name}
          onChange={(e: any) => setName(e.target.value)}
        />
        <TextField
          label="Target"
          description={'e.g. "/usr/bin/flatpak" run org.libretro.RetroArch'}
          value={target}
          onChange={(e: any) => setTarget(e.target.value)}
        />
        <TextField
          label="Launch options"
          description={"Use <rom_path> where the chosen ROM's path goes, e.g. -f -g \"<rom_path>\""}
          value={launch}
          onChange={(e: any) => setLaunch(e.target.value)}
        />
        <TextField
          label="File types"
          description="Optional. Separate with commas, e.g. .gb, .gbc. A ROM of this type skips profile selection. Leave blank to always choose manually."
          value={types}
          onChange={(e: any) => setTypes(e.target.value)}
        />
        {clashes.map((c) => (
          <div key={c.t} style={{ ...subStyle, fontSize: "0.85em", marginTop: "6px" }}>
            {c.t} is also used by {c.names.join(", ")}, so ROMs of that type will ask which profile to use.
          </div>
        ))}
        <Focusable
          // @ts-ignore
          style={{ display: "flex", gap: "8px", marginTop: "16px", width: "100%", boxSizing: "border-box" }}
          // @ts-ignore
          flow-children="row"
        >
          <DialogButton style={editorButtonStyle} disabled={busy || !name.trim() || !target.trim()} onClick={save}>
            Save
          </DialogButton>
          <DialogButton style={editorButtonStyle} onClick={() => closeModal?.()}>
            Cancel
          </DialogButton>
          {profile && (
            <DialogButton style={editorButtonStyle} onClick={copy}>
              Copy
            </DialogButton>
          )}
          {profile && (
            <DialogButton style={editorButtonStyle} onClick={remove}>
              Delete
            </DialogButton>
          )}
        </Focusable>
      </DialogBody>
    </ModalRoot>
  );
}
