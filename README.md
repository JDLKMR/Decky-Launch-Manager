# Decky Launch Manager
A Decky Loader plugin that can add games with ROM paths/arguments, use shell scripts to allow profile selection upon launch, and create links between games.

Combines my previous ROM Manager, Script Assigner and Profile Launcher plugins, as they all deal with how a game launches.

## Features
- Configure ROM profiles with different launch options and arguments
- Add a new non-Steam game and automatically apply a profile's launch options/arguments to it
- Option to automatically apply SteamGridDB covers to newly added games
- Option to automatically add newly added games to collections
- Add optional file types to profiles to instantly apply a profile when a matching file type is chosen for a game
- Includes 16 pre-configured profiles for several emulated consoles (Most are standard, but the 3DS one uses my own niche configuration)
- Add a shell script's path to a game's launch options
- Define one or more directories to search for shell scripts in, including the per-directory option to toggle subdirectories
- Includes the option to add a shortcut button to game pages (next to the Controller button) with: Choose ROM File, Choose Script File, Launch Prompt Settings, and Clear Launch Options
- Scan the library for games with matching ROM profile and shell script paths, and clear them from the dropdown lists if desired
- Exclude specific shell script-bound games via `.sh` filename keywords/patterns (applies to both the scan and the launch prompt)
- Change the variable name looked for in scripts
- Make backups of scripts upon write

### Launch Prompt
When you launch a game whose Target or Launch Options point at a `.sh` script, a prompt lets you pick which profile to launch with. This expects the script to use "profiles": meaning it does different things depending on the value of a variable (default `PROFILE`). The list of profiles is read from the script's own table every time:

```
declare -A PROFILE_TYPES=(
    [1]=default
    [2]=ap
)
declare -A PROFILE_NAMES=(
    [1]="Base Game"
    [2]="Archipelago"
)
```

`PROFILE_TYPES` applies to my own example use case on the script side and isn't really relevant to this plugin. `PROFILE_NAMES` is what the plugin reads. Picking the second entry writes `PROFILE=2` into the script before launching.

A profile can also be passed without editing the script, through the game's launch options, if the script reads it from the environment:

```
PROFILE="${PROFILE:-1}"
```

**Game links** are entries in a game's launch prompt that, instead of running its script, open another Steam shortcut.

Note that Steam Input is shared across all script profiles of a game (with the exception of game links, since those are different games in Steam entirely).

## Building
```
npm install
npm run build
```

## AI Disclosure
All programming was done using Claude. Testing, documentation, and any other writing is all done by me.