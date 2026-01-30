# Changelog

## [0.1.11](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.10...homelab-mcp-v0.1.11) (2026-01-30)


### Bug Fixes

* properly serialize non-Error objects in exec error handling ([#13](https://github.com/mtgibbs/pi-cluster-mcp/issues/13)) ([20395c2](https://github.com/mtgibbs/pi-cluster-mcp/commit/20395c29b67bbe8b3b82b29bceedc431b8ca3306))

## [0.1.10](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.9...homelab-mcp-v0.1.10) (2026-01-30)


### Features

* re-apply error handling improvements ([a857785](https://github.com/mtgibbs/pi-cluster-mcp/commit/a85778561604f9dc14265569d551c82065493a54))

## [0.1.9](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.8...homelab-mcp-v0.1.9) (2026-01-29)


### Bug Fixes

* properly stringify statusCode in error message ([4b28aae](https://github.com/mtgibbs/pi-cluster-mcp/commit/4b28aae5a746e021fac336e5a30e2814de4a9d5b))

## [0.1.8](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.7...homelab-mcp-v0.1.8) (2026-01-29)


### Bug Fixes

* improve error handling and add missing RBAC for exec ([86dfd01](https://github.com/mtgibbs/pi-cluster-mcp/commit/86dfd01aa48654f7260d06a212eb9226b20921d8))

## [0.1.7](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.6...homelab-mcp-v0.1.7) (2026-01-29)


### Bug Fixes

* auto-create new session when stale session ID is provided ([2f41312](https://github.com/mtgibbs/pi-cluster-mcp/commit/2f41312ce4e050de40c310adc8041a97c2672546))

## [0.1.6](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.5...homelab-mcp-v0.1.6) (2026-01-29)


### Bug Fixes

* use correct label selector for Pi-hole pod lookup ([450b966](https://github.com/mtgibbs/pi-cluster-mcp/commit/450b966b6d9d67dcc33d72ba52f5309f7777b5d8))

## [0.1.5](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.4...homelab-mcp-v0.1.5) (2026-01-29)


### Features

* add 6 diagnostic tools for network debugging and pod logs ([3415b79](https://github.com/mtgibbs/pi-cluster-mcp/commit/3415b79286b9b82a1c343e7c265963f4e2f9b6ba))
* add 6 diagnostic tools for network debugging and pod logs ([54118d1](https://github.com/mtgibbs/pi-cluster-mcp/commit/54118d1886e9741657ecb7c87134ab58f1d81a34))


### Documentation

* rewrite README with comprehensive features and security details ([027e1ad](https://github.com/mtgibbs/pi-cluster-mcp/commit/027e1add8b9830e152d7cc09db748ddaca2cdae6))

## [0.1.4](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.3...homelab-mcp-v0.1.4) (2026-01-26)


### Bug Fixes

* scope pods/exec RBAC to pihole and jellyfin namespaces, validate flux resource input ([5c5a0d4](https://github.com/mtgibbs/pi-cluster-mcp/commit/5c5a0d4034b4173fbf8cca9cb29a39f5782b43e0))


### Documentation

* add Claude Desktop setup section to README ([6232afe](https://github.com/mtgibbs/pi-cluster-mcp/commit/6232afe2a615e568767ac047184cb4f25d57530d))
* add Pi-hole whitelist, query log, and gravity tools to README and CLAUDE.md ([c0c36cd](https://github.com/mtgibbs/pi-cluster-mcp/commit/c0c36cde94780a89da0ccfb06cc4fbd2d7ea89ce))

## [0.1.3](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.2...homelab-mcp-v0.1.3) (2026-01-26)


### Features

* add Pi-hole diagnostics to DNS status ([8bb2833](https://github.com/mtgibbs/pi-cluster-mcp/commit/8bb28331078f5c9381a001e046539ac02a0b9e8e))
* add Pi-hole whitelist and query log tools ([abdc37d](https://github.com/mtgibbs/pi-cluster-mcp/commit/abdc37d8961a6041f3776793e39385ac9d82a340))
* add update_pihole_gravity tool ([0165897](https://github.com/mtgibbs/pi-cluster-mcp/commit/0165897bd1367c1871ffb98f64811d9bae54501d))

## [0.1.2](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.1...homelab-mcp-v0.1.2) (2026-01-26)


### Bug Fixes

* use onsessioninitialized callback for session registration ([39248fe](https://github.com/mtgibbs/pi-cluster-mcp/commit/39248fe59f57438675eaa5968dab6885cc641c31))

## [0.1.1](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.0...homelab-mcp-v0.1.1) (2026-01-26)


### Features

* add HTTP transport via StreamableHTTPServerTransport ([#1](https://github.com/mtgibbs/pi-cluster-mcp/issues/1)) ([e071679](https://github.com/mtgibbs/pi-cluster-mcp/commit/e0716791a86725dc8ce3342bc0fb3404d688b41e))


### Bug Fixes

* dispatch CI on release-please branch and report commit statuses ([dd47cfa](https://github.com/mtgibbs/pi-cluster-mcp/commit/dd47cfa41358aec8cc82bcb449bc24056346b80e))
