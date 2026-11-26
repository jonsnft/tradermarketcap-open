# tmc-tools

TMC bounty watcher for the Raspberry Pi (pm2 process TMC-WATCH). Not part of TraderMarketCap; kept on its own branch so it never touches pull requests.

- `tmc-watch.mjs`: watcher (v3: claims read from GitHub, PR opened from a `bounty-<N>-...` branch, PR comments, reviews and merges pushed; v2: change alerts, replacement tasks)
- `test-watch.mjs`: offline test, run with `node test-watch.mjs`
- `reset-dash-watch.mjs`: restarts the pm2 process RESET-DASH when the RESET dashboard has not updated for 30 minutes while the gateway works, and pushes a note to the TMC ntfy topic (pm2 process RESET-DASH-WATCH)
- `test-rdw.mjs`: its test against the real dashboard renderer, run with `RDW_TEST=1 node test-rdw.mjs <path-to-reset-repo>`
