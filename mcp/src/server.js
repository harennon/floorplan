#!/usr/bin/env node
/**
 * server.js — MCP stdio server wiring for floorplan (LLD 32).
 *
 * Registers the mutator + evaluator tools, three read-only Resources (current
 * plan, catalog, current brief), and the design_room prompt, then serves over
 * stdio. Tool handlers live in tools.js; this file only adapts them to the SDK.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as tools from "./tools.js";
import * as session from "./session.js";
import { getBrief } from "./brief.js";
import { CATALOG, serializePlan } from "./core.js";

/** Wrap a handler's plain-object result as an MCP tool result. */
function asResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
}

export function buildServer() {
  const server = new McpServer(
    { name: "floorplan-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  const vec = { x: z.number(), y: z.number() };

  // ── Session / lifecycle ───────────────────────────────────────────────────
  server.registerTool("set_brief", {
    description: "Set the design requirements (target room dims, required furniture, min walkway metres) the agent will try to satisfy.",
    inputSchema: {
      room: z.object({ w: z.number(), h: z.number() }).optional(),
      furniture: z.array(z.object({ type: z.string(), count: z.number().int().optional() })).optional(),
      minWalkwayM: z.number().optional(),
    },
  }, (args) => asResult(tools.tool_set_brief(args)));

  server.registerTool("new_plan", {
    description: "Start a fresh empty plan (resets all geometry and clearance state).",
    inputSchema: {},
  }, () => asResult(tools.tool_new_plan()));

  server.registerTool("load_plan", {
    description: "Load and validate a whole plan document, replacing the current session.",
    inputSchema: { document: z.any() },
  }, (args) => asResult(tools.tool_load_plan(args)));

  server.registerTool("save_plan", {
    description: "Write the current plan as a JSON file into the sandboxed plans directory (importable by the web app).",
    inputSchema: { filename: z.string().optional() },
  }, async (args) => asResult(await tools.tool_save_plan(args)));

  server.registerTool("get_share_url", {
    description: "Get a floorplan.danbing.app share URL that encodes the whole current plan in its hash.",
    inputSchema: {},
  }, async () => asResult(await tools.tool_get_share_url()));

  server.registerTool("get_plan", {
    description: "Return the current plan as a JSON document (plan.js shape).",
    inputSchema: {},
  }, () => asResult(tools.tool_get_plan()));

  // ── Mutators ──────────────────────────────────────────────────────────────
  server.registerTool("add_room", {
    description: "Add a closed room. Provide rect:{x,y,w,h} (top-left origin) or verts:[{x,y},…] (≥3). Returns the room id and metrics.",
    inputSchema: {
      rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
      verts: z.array(z.object(vec)).optional(),
    },
  }, (args) => asResult(tools.tool_add_room(args)));

  server.registerTool("set_edge_length", {
    description: "Set one room edge to an exact length (deforms the polygon — NOT a room resizer; get dims right at add_room time).",
    inputSchema: { roomId: z.string(), edgeIndex: z.number().int(), lengthM: z.number() },
  }, (args) => asResult(tools.tool_set_edge_length(args)));

  server.registerTool("place_symbol", {
    description: "Place a furniture/opening symbol at center (x,y). Optional w,h,rot; dims are clamped to the catalog range.",
    inputSchema: {
      type: z.string(),
      x: z.number(),
      y: z.number(),
      w: z.number().optional(),
      h: z.number().optional(),
      rot: z.number().optional(),
    },
  }, (args) => asResult(tools.tool_place_symbol(args)));

  server.registerTool("move_symbol", {
    description: "Move a symbol's center to (x,y). Returns fresh clearance for it.",
    inputSchema: { id: z.string(), x: z.number(), y: z.number() },
  }, (args) => asResult(tools.tool_move_symbol(args)));

  server.registerTool("resize_symbol", {
    description: "Resize a symbol's width or depth (clamped). lockAspect scales the other dimension.",
    inputSchema: { id: z.string(), dim: z.enum(["w", "h"]), metres: z.number(), lockAspect: z.boolean().optional() },
  }, (args) => asResult(tools.tool_resize_symbol(args)));

  server.registerTool("rotate_symbol", {
    description: "Rotate a symbol to deg (normalised to [0,360)).",
    inputSchema: { id: z.string(), deg: z.number() },
  }, (args) => asResult(tools.tool_rotate_symbol(args)));

  server.registerTool("remove_symbol", {
    description: "Remove a symbol by id.",
    inputSchema: { id: z.string() },
  }, (args) => asResult(tools.tool_remove_symbol(args)));

  server.registerTool("duplicate_symbol", {
    description: "Duplicate a symbol by id (offset slightly).",
    inputSchema: { id: z.string() },
  }, (args) => asResult(tools.tool_duplicate_symbol(args)));

  // ── Evaluators ────────────────────────────────────────────────────────────
  server.registerTool("get_metrics", {
    description: "Per-room area (m²) and perimeter (m), plus totals.",
    inputSchema: {},
  }, () => asResult(tools.tool_get_metrics()));

  server.registerTool("check_clearance", {
    description: "Evaluate walkway clearance for furniture. Returns per-gap centimetres, a direction to move, a resolved suggestedMove, boxed-in axes, and NL violations. minWalkwayM overrides the brief's threshold.",
    inputSchema: { id: z.string().optional(), minWalkwayM: z.number().optional() },
  }, (args) => asResult(tools.tool_check_clearance(args)));

  server.registerTool("check_brief", {
    description: "The goal oracle: does the current plan satisfy the brief? Returns { satisfied, unmet:[…] }.",
    inputSchema: {},
  }, () => asResult(tools.tool_check_brief()));

  // ── Resources ─────────────────────────────────────────────────────────────
  server.registerResource("current-plan", "floorplan://plan/current",
    { description: "The live plan document (plan.js shape).", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: serializePlan(session.dumpPlan()) }],
    }));

  server.registerResource("catalog", "floorplan://catalog",
    { description: "The symbol catalog: types, default w/h, and min/max clamp bounds.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(CATALOG) }],
    }));

  server.registerResource("current-brief", "floorplan://brief/current",
    { description: "The active design brief (requirements).", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(getBrief()) }],
    }));

  // ── Prompt ────────────────────────────────────────────────────────────────
  server.registerPrompt("design_room", {
    description: "Seed a design brief and start the requirement-satisfying loop.",
    argsSchema: { dims: z.string(), furniture: z.string(), walkwayCm: z.string() },
  }, ({ dims, furniture, walkwayCm }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Design a ${dims} room with ${furniture}, keeping ${walkwayCm} cm walkways. ` +
          `First call set_brief, then add_room at the exact dims, then place each piece, ` +
          `then poll check_brief and apply each violation's suggestedMove until satisfied.`,
      },
    }],
  }));

  return server;
}

/** Entry point: open a fresh session and serve over stdio. */
async function main() {
  session.newPlan();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run the server when executed directly (not when imported by tests).
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("floorplan-mcp failed:", err);
    process.exit(1);
  });
}
