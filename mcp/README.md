# floorplan-mcp

A **local, dev-only** stdio [MCP](https://modelcontextprotocol.io) server that exposes
floorplan's geometry core (`../src/js`) as agent tools for a closed
requirement-satisfying design loop:

> agent proposes geometry → server evaluates against the brief → agent reads the
> violations (with a concrete `suggestedMove`) → agent adjusts → repeat until `satisfied`.

This is a **prototype to iterate the agent tool/feedback design**, not a shippable npm
package. See `docs/lld/32-mcp-server-agent-driven-floorplan.md` for the full design.

## Status / caveats

- **Not self-contained.** It imports the core with relative specifiers from a dev checkout
  (`../../src/js/*`). It therefore does **not** survive `npm publish`/`npx` — packaging is
  deferred (LLD Q6/Q7).
- **Local stdio transport only.** No remote/HTTP/OAuth.
- Requires **Node ≥ 18** (uses `CompressionStream`); developed on Node 22.

## Run

```sh
cd mcp
npm install
node src/server.js      # serves over stdio
```

## Test

```sh
cd mcp
npm test                # node --test
```

## Tools

- **Lifecycle:** `set_brief`, `new_plan`, `load_plan`, `save_plan`, `get_share_url`, `get_plan`
- **Mutators:** `add_room`, `set_edge_length`, `place_symbol`, `move_symbol`,
  `resize_symbol`, `rotate_symbol`, `remove_symbol`, `duplicate_symbol`
- **Evaluators (the loop):** `get_metrics`, `check_clearance`, `check_brief`

`check_clearance` returns per-gap centimetres, a direction to move, a resolved
`suggestedMove` target, boxed-in (infeasible) axes, and natural-language violations.
`check_brief` is the goal oracle: `{ satisfied, unmet:[…] }`.

## Resources & prompt

- `floorplan://plan/current`, `floorplan://catalog`, `floorplan://brief/current`
- Prompt: `design_room`

## Plans directory

`save_plan` writes into a sandboxed plans directory (default: a temp dir; override with
`FLOORPLAN_MCP_PLANS_DIR`, or a client-declared MCP Root). Filenames are reduced to a safe
basename and re-verified inside the directory before writing.
