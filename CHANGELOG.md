# Changelog

## [0.1.19](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.18...homelab-mcp-v0.1.19) (2026-02-05)


### Features

* add PVC, CronJob, resource inspection tools and expand restart whitelist ([05a209c](https://github.com/mtgibbs/pi-cluster-mcp/commit/05a209cb91cf966e42a1d35bcc88ad82c2905cde))


### Documentation

* add feature requests from ebook stack session ([e035ac7](https://github.com/mtgibbs/pi-cluster-mcp/commit/e035ac7a9087a0c143803f49ba59cca5b53aa6d3))
* add pod file template system design ([f4e9047](https://github.com/mtgibbs/pi-cluster-mcp/commit/f4e90476366d74c84512e1983f0a420bfe3e542f))
* add security model documentation for exec tools ([61d56c7](https://github.com/mtgibbs/pi-cluster-mcp/commit/61d56c7f3ae87a90201496ad7556802f84be7fec))

## [0.1.18](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.17...homelab-mcp-v0.1.18) (2026-02-01)


### Bug Fixes

* properly extract WebSocket ErrorEvent properties in exec logging ([15a764f](https://github.com/mtgibbs/pi-cluster-mcp/commit/15a764f3f66f7a2beab81fb55a2bd4a8b0e88a3a))

## [0.1.17](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.16...homelab-mcp-v0.1.17) (2026-01-31)


### Bug Fixes

* add debug logging for exec WebSocket failures ([47e3b51](https://github.com/mtgibbs/pi-cluster-mcp/commit/47e3b51abb6239109daf1027df160478665ab5d5))

## [0.1.16](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.15...homelab-mcp-v0.1.16) (2026-01-30)


### Bug Fixes

* read PIHOLE_API_TOKEN env var for authentication ([e6ca4b6](https://github.com/mtgibbs/pi-cluster-mcp/commit/e6ca4b6b2c556469935e2c17a7cee3f5d33c2827)), closes [#23](https://github.com/mtgibbs/pi-cluster-mcp/issues/23)

## [0.1.15](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.14...homelab-mcp-v0.1.15) (2026-01-30)


### Documentation

* improve tool descriptions with usage intent ([#21](https://github.com/mtgibbs/pi-cluster-mcp/issues/21)) ([878f7ff](https://github.com/mtgibbs/pi-cluster-mcp/commit/878f7ffccc4c39f112b054996c87f27825022a78))

## [0.1.14](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.13...homelab-mcp-v0.1.14) (2026-01-30)


### Bug Fixes

* improve exec error handling with timeout and WebSocket events ([dee1d1b](https://github.com/mtgibbs/pi-cluster-mcp/commit/dee1d1bac93c010f04ac4b42b082188d766e857e))

## [0.1.13](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.12...homelab-mcp-v0.1.13) (2026-01-30)


### Features

* rewrite Pi-hole client for v6 API ([056b9c7](https://github.com/mtgibbs/pi-cluster-mcp/commit/056b9c78a97882c460a7211dd9d51d991b154e1b))

## [0.1.12](https://github.com/mtgibbs/pi-cluster-mcp/compare/homelab-mcp-v0.1.11...homelab-mcp-v0.1.12) (2026-01-30)


### Bug Fixes

* update External Secrets API from v1beta1 to v1 ([8087f74](https://github.com/mtgibbs/pi-cluster-mcp/commit/8087f74bb080fb5c4d5db476ac65214c4be9bb43))


### Documentation

* add troubleshooting and coding standards from v0.1.8-v0.1.11 incident ([656de81](https://github.com/mtgibbs/pi-cluster-mcp/commit/656de81fbea6ab7d5467aaeea58a52d2d632d806))

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
