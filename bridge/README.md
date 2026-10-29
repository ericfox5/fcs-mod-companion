# ncaa-bridge

Runs on the PC that hosts RPCS3. Reads the NCAA 14 dynasty save (`USR-DATA`), decodes it and pushes it to the
companion site. Later milestones add `apply` (write web actions back into the save), `watch` and `launch`.

```
npx tsx bridge/src/cli.ts import <path-to-USR-DATA> [--name "My Dynasty"] [--note "after week 5"] [--no-files]
npx tsx bridge/src/cli.ts info   <USR-DATA>            # tables, record counts, checksum check
npx tsx bridge/src/cli.ts dump   <USR-DATA> TEAM SCHD --rows 5 [--json]
npx tsx bridge/src/cli.ts export <USR-DATA> --out dynasty.json
npx tsx bridge/src/cli.ts verify <USR-DATA>
npx tsx bridge/src/cli.ts diff   <USR-DATA-before> <USR-DATA-after> [--table SCHD]
```

Configuration (`%USERPROFILE%\.ncaa-bridge\config.json`, created at first deploy):
`workerUrl`, `token` (the BRIDGE_TOKEN secret of the Worker), `dynastySlug`, `dynastyName`, `rpcs3Root`.
Environment variables `NCAA_WORKER_URL`, `NCAA_BRIDGE_TOKEN`, `NCAA_DYNASTY` and the flags `--url --token --dynasty` override it.

Saves live in `<rpcs3>/dev_hdd0/home/00000001/savedata/BLUS31159-DYNASTY-<NAME>/USR-DATA`.
Never run an import while RPCS3 is writing the save; the game must be at the main menu or closed.
