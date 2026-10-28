import copy
import json
import os
import asyncio
import base64
import concurrent.futures
import re
import shlex
import socket
import ssl
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import decky

SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

RETROARCH = '"/usr/bin/flatpak" run org.libretro.RetroArch'


def _retroarch(profile_id: str, name: str, types: list, core: str) -> dict:
    return {
        "id": profile_id,
        "name": name,
        "fileTypes": types,
        "target": RETROARCH,
        "launchOptions": f'-L /{core} "<rom_path>"',
    }


# Start In is not stored: it is worked out from Target whenever a profile is applied.
DEFAULT_PROFILES = [
    _retroarch("nes", "NES", [".nes"], "mesen_libretro.so"),
    _retroarch("snes", "SNES", [".sfc"], "snes9x_libretro.so"),
    _retroarch("n64", "Nintendo 64", [".z64"], "mupen64plus_next_libretro.so"),
    _retroarch("gb", "Game Boy", [".gb"], "gambatte_libretro.so"),
    _retroarch("gbc", "Game Boy Color", [".gbc"], "gambatte_libretro.so"),
    _retroarch("gba", "Game Boy Advance", [".gba"], "mgba_libretro.so"),
    _retroarch("nds", "DS", [".nds"], "melondsds_libretro.so"),
    _retroarch("dsiware", "DSiWare", [".nds"], "melondsds_libretro.so"),
    {
        "id": "3ds",
        "name": "3DS",
        "fileTypes": [".cci"],
        "target": '"/home/deck/Scripts/azahar.sh"',
        "launchOptions": '"<rom_path>"',
    },
    {
        "id": "gamecube",
        "name": "GameCube",
        "fileTypes": [".rvz"],
        "target": '"/usr/bin/flatpak" run org.DolphinEmu.dolphin-emu',
        "launchOptions": '-b -e "<rom_path>"',
    },
    {
        "id": "wii",
        "name": "Wii",
        "fileTypes": [".rvz"],
        "target": '"/usr/bin/flatpak" run org.DolphinEmu.dolphin-emu',
        "launchOptions": '-b -e "<rom_path>"',
    },
    {
        "id": "wiiu",
        "name": "Wii U",
        "fileTypes": [".wua"],
        "target": '"/home/deck/Applications/Cemu.AppImage"',
        "launchOptions": '-f -g "<rom_path>"',
    },
    {
        "id": "switch",
        "name": "Switch",
        "fileTypes": [".nsp", ".xci"],
        "target": '"/home/deck/Applications/Eden.AppImage"',
        "launchOptions": '-f -g "<rom_path>"',
    },
    {
        "id": "ps2",
        "name": "PlayStation 2",
        "fileTypes": [".chd"],
        "target": '"/home/deck/Applications/pcsx2-Qt.AppImage"',
        "launchOptions": '-batch -fullscreen -nogui "<rom_path>"',
    },
    {
        "id": "xbox",
        "name": "Xbox",
        "fileTypes": [".xiso.iso"],
        "target": '"/usr/bin/flatpak" run app.xemu.xemu',
        "launchOptions": '-full-screen -dvd_path "<rom_path>"',
    },
    _retroarch("cdi", "Philips CD-I", [], "same_cdi_libretro.so"),
]

DEFAULTS = {
    # --- ROM side -------------------------------------------------------
    # Where the ROM file browser always starts. Falls back to the nearest existing
    # parent folder if this one doesn't exist (e.g. SD card not inserted).
    "browserDir": "/home/deck/Emulation/roms",
    # each: {id, name, fileTypes: [".sfc", ...], target, launchOptions}
    "profiles": DEFAULT_PROFILES,
    # Which set of pre-configured profile names/splits this settings file has been brought up to.
    "profilesRev": 1,
    # each: {appid, name, profileId, profileName, rom, source: "added"|"scan"}
    "romGames": [],
    # --- script side ----------------------------------------------------
    # each: {path, subdirs}  (subdirs = also look in that directory's subfolders)
    "scriptDirs": [],
    "exclusions": [],
    # each: {appid, name, script, kind: "steam"|"shortcut", source: "added"|"scan"}
    "scriptGames": [],
    # --- launch prompt (Profile Launcher's side) --------------------------
    # Name of the shell variable that gets rewritten inside a script.
    "variable": "PROFILE",
    # Whether a newly detected game prompts by default.
    "askByDefault": True,
    # Keep a one-time .bak of each script the first time the plugin edits it.
    "backup": True,
    # appid (as a string) -> {name, enabled, lastProfile, lastLinkId, links, defaultName}.
    # links: [{id, targetAppId, name, position?}] are a game's game links. Which script
    # profiles a game offers (their names and order) always comes straight from its own
    # script's PROFILE_NAMES table, re-read on every launch, so none of that is stored.
    "gameProfiles": {},
    # Set once Profile Launcher's old settings have been brought over.
    "plImported": False,
    # --- shared ---------------------------------------------------------
    "showGameButton": True,
    # A game created by the new-game ROM flow gets SteamGridDB art (needs the person's own API key).
    "sgdbArt": False,
    "sgdbKey": "",
    # A game created by the new-game ROM flow goes into the Steam collection named like its ROM profile.
    "romCollections": False,
}

MAX_SCRIPTS = 5000
MAX_ENTRIES = 20000


def _natural_key(text: str) -> list:
    # Alternates str / int starting with str, so keys always compare cleanly.
    return [int(t) if t.isdigit() else t.casefold() for t in re.split(r"(\d+)", text)]


def _norm_types(raw) -> list:
    """['SFC', ' .gb '] -> ['.sfc', '.gb'] (lower-case, leading dot, no duplicates)."""
    if isinstance(raw, str):
        raw = re.split(r"[\s,;]+", raw)
    out, seen = [], set()
    for t in raw or []:
        t = str(t).strip().lower()
        if not t or t == ".":
            continue
        if not t.startswith("."):
            t = "." + t
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _clean_profile(p) -> dict | None:
    if not isinstance(p, dict):
        return None
    name = str(p.get("name", "")).strip()
    target = str(p.get("target", "")).strip()
    if not name or not target:
        return None
    return {
        "id": str(p.get("id") or uuid.uuid4().hex[:8]),
        "name": name,
        "fileTypes": _norm_types(p.get("fileTypes")),
        "target": target,
        "launchOptions": str(p.get("launchOptions", "")).strip(),
    }


def _clean_script_game(g) -> dict | None:
    if not isinstance(g, dict) or not isinstance(g.get("appid"), int):
        return None
    if not isinstance(g.get("script"), str) or not g["script"]:
        return None
    return {
        "appid": g["appid"],
        "name": str(g.get("name", "")),
        "script": g["script"],
        "kind": "shortcut" if g.get("kind") == "shortcut" else "steam",
        "source": "scan" if g.get("source") == "scan" else "added",
    }


def _clean_rom_game(g) -> dict | None:
    if not isinstance(g, dict) or not isinstance(g.get("appid"), int):
        return None
    if not isinstance(g.get("profileId"), str) or not g["profileId"]:
        return None
    return {
        "appid": g["appid"],
        "name": str(g.get("name", "")),
        "profileId": g["profileId"],
        "profileName": str(g.get("profileName", "")),
        "rom": str(g.get("rom", "")),
        "source": "scan" if g.get("source") == "scan" else "added",
    }


def _sorted(profiles: list) -> list:
    return sorted(profiles, key=lambda p: _natural_key(p["name"]))


def _read_json(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (FileNotFoundError, ValueError, OSError):
        return None


# ---- launch prompt: profile scripts, per-game settings -----------------------

_SHELL_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_GAME_PROFILE_FIELDS = ("name", "enabled", "lastProfile", "lastLinkId", "links", "defaultName")


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _clean_link(link) -> dict | None:
    if not isinstance(link, dict) or not _is_int(link.get("targetAppId")):
        return None
    name = str(link.get("name", "")).strip()
    if not name:
        return None
    out = {
        "id": str(link.get("id") or uuid.uuid4().hex[:10]),
        "targetAppId": link["targetAppId"],
        "name": name,
    }
    if _is_int(link.get("position")) and link["position"] >= 1:
        out["position"] = link["position"]
    return out


def _clean_game_profile(g, ask_default: bool) -> dict | None:
    if not isinstance(g, dict):
        return None
    links = g.get("links")
    return {
        "name": str(g.get("name") or ""),
        "enabled": g["enabled"] if isinstance(g.get("enabled"), bool) else ask_default,
        "lastProfile": g["lastProfile"] if _is_int(g.get("lastProfile")) else 1,
        "lastLinkId": str(g["lastLinkId"]) if g.get("lastLinkId") else None,
        "links": [c for c in (_clean_link(x) for x in (links if isinstance(links, list) else [])) if c],
        "defaultName": str(g.get("defaultName") or "").strip(),
    }


def _ensure_game_profile(s: dict, appid: int, name: str) -> None:
    """A newly listed script game starts out with the default prompting setting."""
    key = str(appid)
    if key not in s["gameProfiles"]:
        s["gameProfiles"][key] = _clean_game_profile({"name": name}, s["askByDefault"])


def _matches_exclusion(file_name: str, keyword: str) -> bool:
    """Exclusion match against a script's file name (case-insensitive); the same rule as
    the front end's matchesExclusion. No `*` in the keyword: plain substring match. With
    `*`: glob match against the WHOLE file name, `*` = any run of characters."""
    f, k = file_name.lower(), keyword.lower()
    if "*" not in k:
        return k in f
    return re.match("^" + ".*".join(re.escape(part) for part in k.split("*")) + "$", f) is not None


def _is_excluded(path: str, exclusions: list) -> bool:
    base = os.path.basename(path)
    return any(k.strip() and _matches_exclusion(base, k.strip()) for k in exclusions)


def _profile_pattern(var: str) -> "re.Pattern[str]":
    """Matches an assignment line like `PROFILE=2`, `export PROFILE="2"`,
    `PROFILE=3  # comment`. Commented-out lines are not matched."""
    return re.compile(
        r'^(?P<prefix>[ \t]*(?:export[ \t]+)?'
        + re.escape(var)
        + r'[ \t]*=[ \t]*)'
        r'(?P<quote>["\']?)(?P<value>.*?)(?P=quote)'
        r'(?P<suffix>[ \t]*(?:\#.*)?)$',
        re.MULTILINE,
    )


def _is_env_aware(var: str, value: str, quote: str) -> bool:
    """True when the script's `VAR=` line takes its value from the environment
    (`PROFILE="${PROFILE:-1}"`, `PROFILE=${PROFILE:=1}`), so the profile can be
    passed through the Steam launch options and the file left alone. A plain
    `PROFILE=2` would override anything passed in, and a single-quoted value
    isn't expanded by the shell at all."""
    if quote == "'" or not _SHELL_NAME_RE.fullmatch(var or ""):
        return False
    return re.match(r"\$\{" + re.escape(var) + r":?[-=]", value or "") is not None


_PROFILE_NAMES_START_RE = re.compile(r'declare\s+-A\s+PROFILE_NAMES\s*=\s*\(')
_PROFILE_NAMES_ENTRY_RE = re.compile(
    r'\[\s*(?P<key>\d+)\s*\]\s*=\s*'
    r'(?:"(?P<dq>(?:[^"\\]|\\.)*)"'
    r"|'(?P<sq>[^']*)'"
    r'|(?P<bare>[^\s)]+))'
)


def _find_array_body(text: str, start: int) -> str:
    """The `declare -A ...=( ... )` body starting right after the opening '(',
    stopping at the first ')' that isn't inside a quoted string, so a profile
    name like "Archipelago (v2)" doesn't truncate the array early."""
    i, n, quote = start, len(text), None
    while i < n:
        ch = text[i]
        if quote:
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
        elif ch == ")":
            return text[start:i]
        i += 1
    return text[start:]  # unterminated array; use what's there


def _parse_profile_table(text: str) -> list:
    """Read a script's `declare -A PROFILE_NAMES=(...)` table and return
    [{"value": number, "label": name}, ...] in the order the entries appear in the
    file. That textual order is all that matters: the script is only ever read as
    source text, never executed. A duplicate key keeps its first position but
    takes its last value, matching a plain bash reassignment."""
    start = _PROFILE_NAMES_START_RE.search(text)
    if not start:
        return []
    body = _find_array_body(text, start.end())

    order, names = [], {}
    for entry in _PROFILE_NAMES_ENTRY_RE.finditer(body):
        key = int(entry.group("key"))
        value = entry.group("dq")
        if value is not None:
            value = value.replace('\\"', '"').replace("\\\\", "\\")
        else:
            value = entry.group("sq")
            if value is None:
                value = entry.group("bare")
        value = (value or "").strip()
        if not value:
            continue
        if key not in names:
            order.append(key)
        names[key] = value

    return [{"value": k, "label": names[k]} for k in order]


def _read_text(path: str) -> str:
    # newline="" keeps CRLF files intact on write-back.
    with open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def _atomic_write(path: str, text: str) -> None:
    directory = os.path.dirname(path) or "."
    mode = os.stat(path).st_mode & 0o7777
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".launchprofiles-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _script_candidates(text: str) -> list:
    """Every .sh-looking token in a launch-options / target string."""
    if not text:
        return []
    try:
        parts = shlex.split(text, posix=True)
    except ValueError:
        parts = text.replace('"', " ").replace("'", " ").split()

    out = []
    for part in parts:
        part = part.strip().strip('"').strip("'")
        if not part or part == "%command%":
            continue
        if part.lower().endswith(".sh"):
            out.append(os.path.expanduser(part))
    return out


def _import_profile_launcher(merged: dict) -> bool:
    """Bring over the standalone Profile Launcher plugin's settings, if its settings
    folder is still there. Returns whether anything was found.
    Its exclusion patterns come over as long as this plugin's matching can express them:
    a pattern with a `/` or a `?` is skipped."""
    base = os.path.dirname(decky.DECKY_PLUGIN_SETTINGS_DIR)
    pl = None
    for n in ("Profile Launcher", "Profile-Launcher", "profile-launcher"):
        pl = _read_json(os.path.join(base, n, "settings.json"))
        if pl is not None:
            break
    if pl is None:
        return False

    if isinstance(pl.get("variable"), str) and pl["variable"].strip():
        merged["variable"] = pl["variable"].strip()
    if isinstance(pl.get("askByDefault"), bool):
        merged["askByDefault"] = pl["askByDefault"]
    if isinstance(pl.get("backup"), bool):
        merged["backup"] = pl["backup"]

    if not isinstance(merged["exclusions"], list):
        merged["exclusions"] = []
    have = {str(k).strip().lower() for k in merged["exclusions"]}
    for k in pl.get("excludedScripts") or []:
        k = str(k).strip()
        if not k or "/" in k or "?" in k or k.lower() in have:
            continue
        have.add(k.lower())
        merged["exclusions"].append(k)

    if not isinstance(merged["gameProfiles"], dict):
        merged["gameProfiles"] = {}
    games = pl.get("games")
    if isinstance(games, dict):
        for key, g in games.items():
            if str(key) in merged["gameProfiles"] or not isinstance(g, dict):
                continue
            merged["gameProfiles"][str(key)] = {f: g[f] for f in _GAME_PROFILE_FIELDS if f in g}
    return True


# ---- SteamGridDB art ----------------------------------------------------------

_SGDB_API = "https://www.steamgriddb.com/api/v2"
_SGDB_UA = "LaunchManager/1.0 (Decky Loader plugin)"
_SGDB_MAX_BYTES = 15 * 1024 * 1024
# category -> (endpoint, filters). Static PNG/JPEG only, since that is what Steam takes; the
# sizes are the ones that fit Steam's slots. Results come back best-first, and the first
# usable one is taken.
_SGDB_CATEGORIES = {
    "capsule": ("grids", {"dimensions": "600x900,342x482,660x930", "types": "static", "mimes": "image/png,image/jpeg"}),
    "wide": ("grids", {"dimensions": "920x430,460x215", "types": "static", "mimes": "image/png,image/jpeg"}),
    "hero": ("heroes", {"types": "static", "mimes": "image/png,image/jpeg"}),
    # SteamGridDB's logos only come as PNG or WebP; asking for image/jpeg is rejected with HTTP 400.
    "logo": ("logos", {"types": "static", "mimes": "image/png"}),
    "icon": ("icons", {"types": "static", "mimes": "image/png"}),
}
_SGDB_TRIES = 3  # per category: if the first image will not download, try the next few


class _SgdbAuthError(Exception):
    pass


# Decky runs plugins on its own bundled Python, whose OpenSSL can end up with no usable CA
# certificates (its default paths point at the build machine, or SSL_CERT_FILE names a file that
# is not there), so every https request then fails certificate verification. Certificate checking
# stays on: the system's CA bundle is loaded explicitly on top of whatever the defaults found.
_CA_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/ca-certificates/extracted/tls-ca-bundle.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
)
_ssl_context = None


def _ssl_ctx() -> ssl.SSLContext:
    global _ssl_context
    if _ssl_context is not None:
        return _ssl_context
    ctx = ssl.create_default_context()
    candidates = [os.environ.get("SSL_CERT_FILE", ""), *_CA_BUNDLES]
    try:
        import certifi  # type: ignore  # not bundled with every Decky, so optional

        candidates.append(certifi.where())
    except Exception:
        pass
    for path in candidates:
        if path and os.path.isfile(path):
            try:
                ctx.load_verify_locations(cafile=path)
                decky.logger.info("SteamGridDB: loaded CA certificates from %s", path)
                break
            except Exception as exc:
                decky.logger.warning("SteamGridDB: could not load CA bundle %s: %s", path, exc)
    _ssl_context = ctx
    return ctx


def _describe_net_error(exc: BaseException) -> str:
    """A short reason for a failed request, small enough to read in a toast."""
    reason = getattr(exc, "reason", None) or exc
    if isinstance(exc, urllib.error.HTTPError):
        return "HTTP %d" % exc.code
    if isinstance(reason, ssl.SSLError):
        return "SSL certificate check failed"
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return "request timed out"
    if isinstance(reason, socket.gaierror):
        return "no network connection"
    if isinstance(reason, OSError) and reason.strerror:
        return reason.strerror
    return str(reason)[:80]


def _http_get(url: str, key: str | None = None, limit: int = _SGDB_MAX_BYTES) -> bytes:
    """GET a URL. The API key is only ever sent to the API, never to the image CDN."""
    headers = {"User-Agent": _SGDB_UA}
    if key:
        headers["Authorization"] = "Bearer " + key
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, headers=headers), timeout=20, context=_ssl_ctx()
        ) as resp:
            data = resp.read(limit + 1)
    except urllib.error.HTTPError as exc:
        if key and exc.code in (401, 403):
            raise _SgdbAuthError() from exc
        raise
    if len(data) > limit:
        raise ValueError("image is too large")
    return data


def _sgdb_json(path: str, params: dict, key: str) -> list:
    query = urllib.parse.urlencode(params)
    body = json.loads(_http_get(_SGDB_API + path + ("?" + query if query else ""), key).decode("utf-8"))
    if not body.get("success", False):
        raise RuntimeError("; ".join(str(e) for e in body.get("errors", [])) or "SteamGridDB returned an error")
    return body.get("data") or []


def _image_ext(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG"):
        return "png"
    if data.startswith(b"\xff\xd8"):
        return "jpg"
    return None


def _sgdb_first_image(game_id: int, category: str, key: str):
    """(bytes, ext) of the first image in the category that downloads and is a PNG/JPEG, else None."""
    endpoint, params = _SGDB_CATEGORIES[category]
    path = "/%s/game/%d" % (endpoint, game_id)
    try:
        items = _sgdb_json(path, params, key)
    except urllib.error.HTTPError as exc:
        if exc.code != 400:
            raise
        # The API refused one of the filters. Ask again without them; the downloaded bytes are
        # checked for PNG/JPEG below anyway.
        decky.logger.warning("SteamGridDB %s filters rejected (HTTP 400); retrying unfiltered", category)
        items = _sgdb_json(path, {}, key)
    for item in items[:_SGDB_TRIES]:
        url = item.get("url")
        if not url:
            continue
        try:
            data = _http_get(url)
        except Exception as exc:
            decky.logger.warning("SteamGridDB %s download failed: %s", category, exc)
            continue
        ext = _image_ext(data)
        if ext:
            return data, ext
    return None


def _sgdb_error(exc: BaseException) -> str:
    """The toast text for a failed SteamGridDB request."""
    if isinstance(exc, _SgdbAuthError):
        return "SteamGridDB rejected the API key."
    if isinstance(exc, RuntimeError):
        decky.logger.warning("SteamGridDB request failed: %s", exc)
        return "SteamGridDB error: %s" % exc
    decky.logger.error("SteamGridDB request failed: %r", exc)
    return "Could not reach SteamGridDB (%s)." % _describe_net_error(exc)


def _release_year(ts) -> int | None:
    try:
        ts = int(ts)
        return time.gmtime(ts).tm_year if ts > 0 else None
    except Exception:
        return None


def _sgdb_search(query: str, key: str) -> dict:
    """Games matching `query`, best match first, each with the year it was released (when known)."""
    out = {"ok": False, "games": []}
    query = (query or "").strip()
    if not query:
        out["ok"] = True
        return out
    try:
        matches = _sgdb_json("/search/autocomplete/" + urllib.parse.quote(query, safe=""), {}, key)
    except Exception as exc:
        out["error"] = _sgdb_error(exc)
        return out
    for m in matches[:25]:
        try:
            out["games"].append(
                {"id": int(m["id"]), "name": str(m.get("name") or ""), "year": _release_year(m.get("release_date"))}
            )
        except Exception:
            continue
    out["ok"] = True
    return out


def _sgdb_collect(name: str, appid: int, key: str, game_id: int = 0, title: str = "") -> dict:
    """Download the art for a game. `game_id` is a SteamGridDB game the person already picked;
    without one, `name` is searched for and the best match is used."""
    out = {"ok": False, "assets": {}, "missing": []}
    if game_id:
        out["title"] = title or name
    else:
        found_games = _sgdb_search(name, key)
        if not found_games["ok"]:
            out["error"] = found_games["error"]
            return out
        if not found_games["games"]:
            out["error"] = 'No SteamGridDB match for "%s".' % name
            return out
        game_id = found_games["games"][0]["id"]
        out["title"] = found_games["games"][0]["name"] or name

    def one(category):
        try:
            return category, _sgdb_first_image(int(game_id), category, key)
        except Exception as exc:
            decky.logger.warning("SteamGridDB %s lookup failed: %s", category, exc)
            return category, None

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(_SGDB_CATEGORIES)) as pool:
        found = dict(pool.map(one, _SGDB_CATEGORIES))

    for category in _SGDB_CATEGORIES:  # a fixed order, so the result reads the same every time
        hit = found.get(category)
        if not hit:
            out["missing"].append(category)
        elif category == "icon":
            # A shortcut's icon is a file path to Steam, not image data.
            folder = os.path.join(getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", decky.DECKY_PLUGIN_SETTINGS_DIR), "icons")
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, "%d.%s" % (appid, hit[1]))
            with open(path, "wb") as f:
                f.write(hit[0])
            out["assets"][category] = {"path": path, "ext": hit[1]}
        else:
            out["assets"][category] = {"b64": base64.b64encode(hit[0]).decode("ascii"), "ext": hit[1]}

    out["ok"] = bool(out["assets"])
    if not out["ok"]:
        out["error"] = 'SteamGridDB has no usable art for "%s".' % out["title"]
    return out


def _upgrade_default_profiles(merged: dict) -> None:
    """Settings saved before the pre-configured profiles were renamed and split still hold the
    old ones. Bring over only those that are still unrenamed (a profile whose name the person
    changed is theirs and is left alone). A split keeps the old profile's Target and Launch
    Options for both halves, and games already assigned to it are moved to the matching half."""
    profiles = merged["profiles"]
    by_id = {p["id"]: p for p in profiles}
    renames = {"3ds": ("Nintendo 3DS", "3DS"), "wiiu": ("Nintendo Wii U", "Wii U"), "switch": ("Nintendo Switch", "Switch")}
    for pid, (old, new) in renames.items():
        if pid in by_id and by_id[pid]["name"] == old:
            by_id[pid]["name"] = new

    def copy_of(src: dict, pid: str, name: str, types: list) -> dict:
        return {"id": pid, "name": name, "fileTypes": types, "target": src["target"], "launchOptions": src["launchOptions"]}

    moves = {}  # old profile id -> function(rom path) -> new profile id
    new_profiles = []

    old = by_id.get("gb-gbc")
    if old and old["name"] == "Game Boy/Game Boy Color":
        profiles.remove(old)
        new_profiles += [copy_of(old, "gb", "Game Boy", [".gb"]), copy_of(old, "gbc", "Game Boy Color", [".gbc"])]
        moves["gb-gbc"] = lambda rom: "gbc" if rom.lower().endswith(".gbc") else "gb"

    old = by_id.get("nds")
    if old and old["name"] == "Nintendo DS/DSiWare":
        old["name"] = "DS"
        new_profiles.append(copy_of(old, "dsiware", "DSiWare", [".nds"]))

    old = by_id.get("gc-wii")
    if old and old["name"] == "Nintendo GameCube/Wii":
        profiles.remove(old)
        # Both halves share .rvz, so there is nothing to tell an existing game's half by: it goes to GameCube
        # (the launch options are the same either way).
        new_profiles += [copy_of(old, "gamecube", "GameCube", old["fileTypes"]), copy_of(old, "wii", "Wii", old["fileTypes"])]
        moves["gc-wii"] = lambda rom: "gamecube"

    have = {p["id"] for p in profiles}
    profiles += [p for p in new_profiles if p["id"] not in have]
    names = {p["id"]: p["name"] for p in profiles}
    for g in merged["romGames"]:
        if g["profileId"] in moves:
            g["profileId"] = moves[g["profileId"]](g["rom"])
        if g["profileId"] in names:
            g["profileName"] = names[g["profileId"]]
    merged["profiles"] = _sorted(profiles)


def _import_previous_name() -> dict | None:
    """First run only: this plugin used to be called Launch Editor (before that, Launch
    Options Manager), and Decky keeps settings per plugin name. Take the old settings
    over whole: it's the same format."""
    base = os.path.dirname(decky.DECKY_PLUGIN_SETTINGS_DIR)
    for n in ("Launch Editor", "Launch-Editor", "Launch Options Manager", "Launch-Options-Manager"):
        d = _read_json(os.path.join(base, n, "settings.json"))
        if d:
            return d
    return None


def _migrate() -> dict:
    """First run only: bring over settings from the standalone Script Assigner and
    ROM Manager plugins, if their settings folders are still there."""
    base = os.path.dirname(decky.DECKY_PLUGIN_SETTINGS_DIR)

    def find(names: list) -> dict | None:
        for n in names:
            d = _read_json(os.path.join(base, n, "settings.json"))
            if d is not None:
                return d
        return None

    out: dict = {}
    sa = find(["Script Assigner", "Script-Assigner"])
    rm = find(["ROM Manager", "ROM-Manager"])
    if sa:
        if isinstance(sa.get("scriptDirs"), list):
            out["scriptDirs"] = sa["scriptDirs"]
        elif sa.get("scriptDir"):  # settings from before multiple directories existed
            out["scriptDirs"] = [{"path": str(sa["scriptDir"]), "subdirs": bool(sa.get("includeSubdirs"))}]
        if isinstance(sa.get("exclusions"), list):
            out["exclusions"] = sa["exclusions"]
        if isinstance(sa.get("assignments"), list):
            out["scriptGames"] = sa["assignments"]
        if "showGameButton" in sa:
            out["showGameButton"] = sa["showGameButton"]
    if rm:
        if isinstance(rm.get("profiles"), list):
            out["profiles"] = rm["profiles"]
        if isinstance(rm.get("browserDir"), str):
            out["browserDir"] = rm["browserDir"]
        if rm.get("showGameButton") is False:
            out["showGameButton"] = False
    return out


def _load() -> dict:
    migrated = False
    if os.path.exists(SETTINGS_FILE):
        data = _read_json(SETTINGS_FILE) or {}
    else:
        # A renamed plugin gets a fresh settings folder: bring the old one over first.
        data = _import_previous_name() or _migrate()
        migrated = bool(data)
    # Settings written before the profile names/splits changed carry no revision number.
    old_profiles = bool(data) and not isinstance(data.get("profilesRev"), int)
    merged = copy.deepcopy(DEFAULTS)
    merged.update({k: v for k, v in data.items() if k in DEFAULTS})

    # Profile Launcher's settings come over once, and only once they have actually been found.
    if not merged.get("plImported") and _import_profile_launcher(merged):
        merged["plImported"] = True
        migrated = True

    merged["profiles"] = _sorted([c for c in (_clean_profile(p) for p in merged["profiles"]) if c])
    merged["scriptDirs"] = [
        {"path": d["path"], "subdirs": bool(d.get("subdirs"))}
        for d in merged["scriptDirs"]
        if isinstance(d, dict) and isinstance(d.get("path"), str) and d["path"]
    ]
    merged["exclusions"] = [str(k) for k in merged["exclusions"] if str(k).strip()]
    merged["scriptGames"] = [c for c in (_clean_script_game(g) for g in merged["scriptGames"]) if c]
    merged["romGames"] = [c for c in (_clean_rom_game(g) for g in merged["romGames"]) if c]
    if not isinstance(merged["browserDir"], str) or not merged["browserDir"]:
        merged["browserDir"] = DEFAULTS["browserDir"]
    merged["showGameButton"] = bool(merged["showGameButton"])
    merged["romCollections"] = bool(merged["romCollections"])
    merged["sgdbArt"] = bool(merged["sgdbArt"])
    merged["sgdbKey"] = str(merged["sgdbKey"] or "").strip()
    merged["askByDefault"] = bool(merged["askByDefault"])
    merged["backup"] = bool(merged["backup"])
    merged["plImported"] = bool(merged["plImported"])
    variable = str(merged["variable"] or "").strip()
    merged["variable"] = variable if _SHELL_NAME_RE.fullmatch(variable) else DEFAULTS["variable"]
    profiles_by_game = {}
    if isinstance(merged["gameProfiles"], dict):
        for key, raw in merged["gameProfiles"].items():
            clean = _clean_game_profile(raw, merged["askByDefault"])
            if clean and str(key).isdigit():
                profiles_by_game[str(key)] = clean
    merged["gameProfiles"] = profiles_by_game
    if old_profiles:
        _upgrade_default_profiles(merged)
        merged["profilesRev"] = DEFAULTS["profilesRev"]
        migrated = True
    if migrated:
        _save(merged)  # so the import happens only once
    return merged


def _save(data: dict) -> dict:
    data["profiles"] = _sorted(data["profiles"])
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, SETTINGS_FILE)
    return data


def _existing_dir(path: str) -> str:
    p = os.path.abspath(os.path.expanduser(path or decky.DECKY_USER_HOME))
    while p != "/" and not os.path.isdir(p):
        p = os.path.dirname(p)
    return p


def _collect_scripts(directory: str, recurse: bool) -> list:
    results = []
    if not directory or not os.path.isdir(directory):
        return results

    def add(root: str, filename: str):
        if filename.startswith(".") or not filename.lower().endswith(".sh"):
            return
        full = os.path.join(root, filename)
        if not os.path.isfile(full):
            return
        rel = os.path.relpath(root, directory)
        results.append(
            {"name": filename, "path": full, "rel": "" if rel == "." else rel, "dir": directory}
        )

    try:
        if recurse:
            for root, dirs, files in os.walk(directory):
                dirs[:] = sorted(d for d in dirs if not d.startswith("."))
                for filename in files:
                    add(root, filename)
                if len(results) >= MAX_SCRIPTS:
                    break
        else:
            for filename in os.listdir(directory):
                add(directory, filename)
    except OSError as e:
        decky.logger.error(f"Failed to list scripts in {directory}: {e}")

    results.sort(key=lambda r: (r["name"].lower(), r["path"].lower()))
    return results[:MAX_SCRIPTS]


def _upsert(items: list, new: dict) -> list:
    """Replace the entry with the same appid (keeping how it was first added), or append."""
    for i, it in enumerate(items):
        if it["appid"] == new["appid"]:
            items[i] = {**new, "source": it.get("source", new["source"])}
            return items
    items.append(new)
    return items


class Plugin:
    async def _main(self):
        # Deliberately does nothing but log: no scanning on install/load.
        decky.logger.info("Launch Manager loaded")

    async def _unload(self):
        decky.logger.info("Launch Manager unloaded")

    # ---- settings -------------------------------------------------------
    async def get_settings(self) -> dict:
        return _load()

    async def set_browser_dir(self, path: str) -> dict:
        s = _load()
        s["browserDir"] = os.path.normpath(os.path.expanduser(path))
        return _save(s)

    async def set_show_game_button(self, value: bool) -> dict:
        s = _load()
        s["showGameButton"] = bool(value)
        return _save(s)

    async def set_sgdb_art(self, value: bool) -> dict:
        s = _load()
        s["sgdbArt"] = bool(value)
        return _save(s)

    async def set_sgdb_key(self, key: str) -> dict:
        s = _load()
        s["sgdbKey"] = str(key or "").strip()
        return _save(s)

    async def fetch_sgdb_art(self, name: str, appid: int, sgdb_id: int = 0, sgdb_title: str = "") -> dict:
        """Download the first usable Capsule, Wide Capsule, Hero, Logo and Icon for a game. With
        `sgdb_id` (a SteamGridDB game the person picked) that game is used; otherwise `name` is
        searched for. The network work happens here, off the event loop."""
        key = _load()["sgdbKey"]
        if not key:
            return {"ok": False, "error": "Add your SteamGridDB API key in Settings first.", "assets": {}, "missing": []}
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, _sgdb_collect, name, int(appid), key, int(sgdb_id or 0), str(sgdb_title or "")
        )

    async def search_sgdb_games(self, query: str) -> dict:
        """Search SteamGridDB for games by title: {ok, games: [{id, name, year}], error?}."""
        key = _load()["sgdbKey"]
        if not key:
            return {"ok": False, "error": "Add your SteamGridDB API key in Settings first.", "games": []}
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _sgdb_search, str(query or ""), key)

    async def set_rom_collections(self, value: bool) -> dict:
        s = _load()
        s["romCollections"] = bool(value)
        return _save(s)

    # ---- ROM profiles -----------------------------------------------
    async def save_profile(self, profile: dict) -> dict:
        """Create (no id / unknown id) or update (known id) a profile."""
        clean = _clean_profile(profile)
        if clean is None:
            raise ValueError("A profile needs a name and a target.")
        s = _load()
        s["profiles"] = [p for p in s["profiles"] if p["id"] != clean["id"]]
        s["profiles"].append(clean)
        return _save(s)

    async def delete_profile(self, profile_id: str) -> dict:
        s = _load()
        s["profiles"] = [p for p in s["profiles"] if p["id"] != profile_id]
        return _save(s)

    # ---- script directories & exclusions ---------------------------------
    async def add_directory(self, path: str) -> dict:
        s = _load()
        p = os.path.normpath(os.path.expanduser(path))
        if not any(d["path"] == p for d in s["scriptDirs"]):
            s["scriptDirs"].append({"path": p, "subdirs": False})
        return _save(s)

    async def remove_directory(self, path: str) -> dict:
        s = _load()
        s["scriptDirs"] = [d for d in s["scriptDirs"] if d["path"] != path]
        return _save(s)

    async def set_directory_subdirs(self, path: str, value: bool) -> dict:
        s = _load()
        for d in s["scriptDirs"]:
            if d["path"] == path:
                d["subdirs"] = bool(value)
        return _save(s)

    async def set_exclusions(self, exclusions: list) -> dict:
        s = _load()
        cleaned, seen = [], set()
        for k in exclusions:
            k = str(k).strip()
            if k and k.lower() not in seen:
                seen.add(k.lower())
                cleaned.append(k)
        s["exclusions"] = cleaned
        return _save(s)

    # ---- filesystem -----------------------------------------------------
    async def list_dir(self, path: str) -> dict:
        p = _existing_dir(path)
        dirs, files = [], []
        try:
            with os.scandir(p) as it:
                for e in it:
                    if e.name.startswith("."):
                        continue
                    try:
                        if e.is_dir():
                            dirs.append(e.name)
                        elif e.is_file():
                            files.append(e.name)
                    except OSError:
                        continue
        except OSError as err:
            decky.logger.error(f"Failed to list {p}: {err}")
        dirs.sort(key=_natural_key)
        files.sort(key=_natural_key)
        return {
            "path": p,
            "parent": None if p == "/" else os.path.dirname(p),
            "dirs": dirs[:MAX_ENTRIES],
            "files": files[:MAX_ENTRIES],
        }

    async def list_scripts(self) -> list:
        s = _load()
        seen, results = set(), []
        for d in s["scriptDirs"]:
            for r in _collect_scripts(d["path"], d["subdirs"]):
                if r["path"] in seen:  # overlapping directories
                    continue
                seen.add(r["path"])
                results.append(r)
        results.sort(key=lambda r: (r["name"].lower(), r["path"].lower()))
        return results[:MAX_SCRIPTS]

    # ---- launch prompt ---------------------------------------------------
    async def set_prompt_options(self, patch: dict) -> dict:
        s = _load()
        if isinstance(patch.get("askByDefault"), bool):
            s["askByDefault"] = patch["askByDefault"]
        if isinstance(patch.get("backup"), bool):
            s["backup"] = patch["backup"]
        variable = patch.get("variable")
        if isinstance(variable, str) and _SHELL_NAME_RE.fullmatch(variable.strip()):
            s["variable"] = variable.strip()
        return _save(s)

    async def set_game_profile(self, appid: int, patch: dict) -> dict:
        """Create or update one game's launch prompt settings; only the fields in `patch` change."""
        s = _load()
        key = str(int(appid))
        entry = dict(s["gameProfiles"].get(key) or {})
        for field in _GAME_PROFILE_FIELDS:
            if field in patch:
                entry[field] = patch[field]
        clean = _clean_game_profile(entry, s["askByDefault"])
        if clean:
            s["gameProfiles"][key] = clean
        return _save(s)

    async def forget_game_profile(self, appid: int) -> dict:
        s = _load()
        s["gameProfiles"].pop(str(int(appid)), None)
        return _save(s)

    async def resolve_script(self, exe: str = "", launch_options: str = "") -> dict:
        """Find the .sh referenced by a game's target and/or launch options, and read its
        PROFILE_NAMES table."""
        s = _load()
        candidates = _script_candidates(launch_options) + _script_candidates(exe)

        # Drop excluded names first, so a game referencing both an excluded helper
        # and a real profile script still resolves to the latter.
        kept = [c for c in candidates if not _is_excluded(c, s["exclusions"])]
        if candidates and not kept:
            return {"path": "", "exists": False, "hasVariable": False, "value": None,
                    "envAware": False, "excluded": True, "profiles": []}

        chosen = ""
        for path in kept:
            if os.path.isfile(path):
                chosen = path
                break
        if not chosen and kept:
            chosen = kept[0]

        result = {"path": chosen, "exists": bool(chosen) and os.path.isfile(chosen), "hasVariable": False,
                  "value": None, "envAware": False, "excluded": False, "profiles": []}
        if not result["exists"]:
            return result
        try:
            text = _read_text(chosen)
        except Exception as exc:
            result["error"] = str(exc)
            return result
        match = _profile_pattern(s["variable"]).search(text)
        if match:
            result["hasVariable"] = True
            result["value"] = match.group("value")
            result["envAware"] = _is_env_aware(s["variable"], match.group("value"), match.group("quote"))
        result["profiles"] = _parse_profile_table(text)
        return result

    async def write_profile(self, path: str, value) -> dict:
        """Rewrite the first `VAR=` assignment in the script, keeping quoting, indentation,
        `export`, trailing comments and file permissions."""
        s = _load()
        var = s["variable"]
        if value is None:
            return {"ok": False, "error": "No profile value was provided to write"}
        value = str(value)

        if not os.path.isfile(path):
            return {"ok": False, "error": "Script not found: %s" % path}
        try:
            text = _read_text(path)
        except Exception as exc:
            return {"ok": False, "error": "Could not read script: %s" % exc}

        pattern = _profile_pattern(var)
        match = pattern.search(text)
        if not match:
            return {"ok": False, "error": "No %s= line found in %s" % (var, os.path.basename(path))}
        if match.group("value") == value:
            return {"ok": True, "unchanged": True, "value": value}

        replaced = False

        def _sub(m):
            nonlocal replaced
            if replaced:
                return m.group(0)
            replaced = True
            return "%s%s%s%s%s" % (m.group("prefix"), m.group("quote"), value, m.group("quote"), m.group("suffix"))

        new_text = pattern.sub(_sub, text)

        if s["backup"]:
            backup = path + ".launchprofiles.bak"
            if not os.path.exists(backup):
                try:
                    with open(backup, "w", encoding="utf-8", newline="") as f:
                        f.write(text)
                except Exception as exc:
                    decky.logger.warning("Backup failed for %s: %s", path, exc)

        try:
            _atomic_write(path, new_text)
        except PermissionError:
            return {"ok": False, "error": "No write permission for %s" % path}
        except Exception as exc:
            return {"ok": False, "error": "Could not write script: %s" % exc}

        decky.logger.info("Set %s=%s in %s", var, value, path)
        return {"ok": True, "value": value}

    # ---- the games lists --------------------------------------------------
    # A game is in at most one list: setting it in one takes it out of the other.
    async def set_script_game(self, appid: int, name: str, script: str, kind: str, source: str) -> dict:
        s = _load()
        s["romGames"] = [g for g in s["romGames"] if g["appid"] != appid]
        s["scriptGames"] = [g for g in s["scriptGames"] if g["appid"] != appid]
        s["scriptGames"].append(
            {"appid": appid, "name": name, "script": script, "kind": kind, "source": source}
        )
        _ensure_game_profile(s, appid, name)
        return _save(s)

    async def set_rom_game(
        self, appid: int, name: str, profile_id: str, profile_name: str, rom: str, source: str
    ) -> dict:
        s = _load()
        s["scriptGames"] = [g for g in s["scriptGames"] if g["appid"] != appid]
        s["romGames"] = [g for g in s["romGames"] if g["appid"] != appid]
        s["romGames"].append(
            {
                "appid": appid,
                "name": name,
                "profileId": profile_id,
                "profileName": profile_name,
                "rom": rom,
                "source": source,
            }
        )
        return _save(s)

    async def remove_game(self, appid: int) -> dict:
        s = _load()
        s["romGames"] = [g for g in s["romGames"] if g["appid"] != appid]
        s["scriptGames"] = [g for g in s["scriptGames"] if g["appid"] != appid]
        return _save(s)

    async def apply_scan(self, rom_add: list, rom_remove: list, script_add: list, script_remove: list) -> dict:
        """Apply the result of a library scan in one go. Removals first, then
        additions/updates (an updated entry keeps how it was first added)."""
        s = _load()
        drop_rom, drop_script = set(rom_remove), set(script_remove)
        s["romGames"] = [g for g in s["romGames"] if g["appid"] not in drop_rom]
        s["scriptGames"] = [g for g in s["scriptGames"] if g["appid"] not in drop_script]
        for raw in rom_add:
            g = _clean_rom_game(raw)
            if g:
                s["scriptGames"] = [x for x in s["scriptGames"] if x["appid"] != g["appid"]]
                _upsert(s["romGames"], g)
        for raw in script_add:
            g = _clean_script_game(raw)
            if g:
                s["romGames"] = [x for x in s["romGames"] if x["appid"] != g["appid"]]
                _upsert(s["scriptGames"], g)
                _ensure_game_profile(s, g["appid"], g["name"])
        return _save(s)
