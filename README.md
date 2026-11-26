# tmc-tools

TMC bounty watcher for the Raspberry Pi (pm2 process TMC-WATCH). Not part of TraderMarketCap; kept on its own branch so it never touches pull requests.

- `tmc-watch.mjs`: watcher (v3: claims read from GitHub, PR opened from a `bounty-<N>-...` branch, PR comments, reviews and merges pushed; v2: change alerts, replacement tasks)
- `test-watch.mjs`: offline test, run with `node test-watch.mjs`
