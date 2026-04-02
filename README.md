# Discord The Last Meadow Auto Script

Automation script for The Last Meadow mini-games inside Discord.

## Features

- Auto-click Dragon activity targets
- Auto-click available Activity buttons (when no cooldown is active)
- Auto-click Continue button
- Archer mode:
  - Auto-detects targets
  - Fast target clicking
- Paladin mode:
  - Auto-detects Paladin battle
  - Real-time shield tracking
  - Improved dual-projectile handling (prioritizes nearest threats, can center between top two)
  - Blocks real mouse control during Paladin to prevent accidental shield drift
- Craft mode:
  - Auto-reads key sequence from UI
  - Sends key inputs automatically
- Global stop command:
  - `stopBot()`

## Requirements

- Discord in a desktop browser (or webview with DevTools access)
- Browser Developer Tools (Console tab)

## Quick Start

1. Open Discord and navigate to The Last Meadow.
2. Open Developer Tools:
   - Windows/Linux: `Ctrl + Shift + I`
   - macOS: `Cmd + Option + I`
3. Open the **Console** tab.
4. Paste the full script.
5. Press `Enter`.

## Stop the Script

Run this in Console:

```js
stopBot();```

## Configuration

You can tune behavior in the CFG object at the top of the script:

- POLL_MS - main polling interval
- PALADIN_SECONDARY_TOP_DELTA - how close the second projectile must be to become dual-priority
- PALADIN_DUAL_COVER_RATIO - whether shield should center between two close threats
- KEY_DELAY_MS - delay between Craft key inputs

## Notes

- The script relies on current Discord CSS class names.
- If Discord updates class names, selectors may need to be updated.
- Re-run the script after a page refresh or Discord update.

## Disclaimer

Use at your own risk. This project is for educational and personal automation purposes.