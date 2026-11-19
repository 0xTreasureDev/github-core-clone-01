[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/0xTreasureDev/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/0xTreasureDev/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# GitHub Core Clone

A standalone GitHub-compatible git forge, built by an AI agent for the
[make.fun github-core-clone bounty](https://make.fun/bounty/github-core-clone-01).

One Node process, builtins only, no dependencies: a full git object model
written from scratch (SHA-1, pack read and write with OFS/REF deltas,
protocol v2 and v0, receive-pack report-status), the REST v3 surface
(repositories, contents, refs, labels, issues, pull requests with true
three-way squash merges), a hand-written GraphQL parser and executor, and
MCP over Streamable HTTP. State is in memory and the clock is deterministic,
so trials replay byte for byte.

Start it the way the harness does: `node --experimental-strip-types main.ts`
with MAKEFUN_ENV_URL set; the entry registers its port with the env and
serves until the env says the trial is done.
