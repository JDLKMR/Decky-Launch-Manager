# Decky Launch Manager
A Decky Loader plugin that can assign launch paths/arguments to games according to configured profiles, assign shell script file paths, and prompt for a profile when a script-bound game (or a game with shortcut profiles) is launched.

## Features
- Configure "console profiles" with different launch options and arguments
- Add a new non-Steam game and automatically apply a profile's launch options/arguments to it
- Add optional file types to profiles to instantly apply a profile when a matching file type is chosen for a game
- Includes 13 pre-configured profiles for several emulated consoles (Most are standard, but the 3DS one uses my own niche configuration)
- Add a shell script's path to a game's launch options
- Prompt on game launch (if it's bound to a shell script) to select a profile from the script
- Define one or more directories to search for shell scripts in, including the per-directory option to toggle subdirectories
- Includes the option to add a shortcut button to game pages (next to the Steam Input button) with: Choose ROM file, Choose script file, Add shortcut profile, and Clear launch options
- Scan the library for games with matching ROM profile and shell script paths, and clear them from the dropdown lists if desired
- Exclude specific shell script-bound games via `.sh` filename keywords/patterns (applies to both the scan and the launch prompt)

### Launch Prompt
When you launch a game whose Target or Launch Options point at a `.sh` script, a prompt lets you pick which profile to launch with. This expects the script to use "profiles": it does different things depending on the value of a variable (default `PROFILE`). The list of profiles is read from the script's own table every time:

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

`PROFILE_TYPES` is for the script's side; `PROFILE_NAMES` is what this plugin reads. Picking the second entry writes `PROFILE=2` into the script before launching.

A profile can also be passed without editing the script, through the game's launch options, if the script reads it from the environment:

```
PROFILE="${PROFILE:-1}"
```

**Shortcut profiles** are entries in a game's launch prompt that, instead of running its script, open another Steam shortcut of your choosing. Add them from a game page's button, the Add Shortcut Profile button, or a game's Game Settings. Steam Input is shared across all script profiles of a game (but not shortcut profiles, since those are different games in Steam). Games that only have shortcut profiles (no script of their own) are listed under Script Games.

Other options: change the variable's name, whether newly detected games prompt by default, and keeping a one-time backup of each script the plugin edits.

## Building
```
npm install
npm run build
```

## AI Disclosure
All programming was done using Claude. Testing, documentation, and any other writing is all done by me.
