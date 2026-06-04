# AGENTS.md

Guidance for AI agents working in this repository.

## Default Working Agreement

- Inspect and explain before editing unless the user explicitly says to implement.
- Treat `src/` as the source of truth. Avoid hand-editing `build/` unless diagnosing a runtime mismatch.
- Preserve user changes. If `git status --short` shows dirty files, inspect them before touching related files.
- Keep changes in small vertical slices that can be tested in After Effects before adding the next layer.
- Prefer practical After Effects tests over broad refactors.

## Project Purpose

This repo is an MCP server that lets AI clients control Adobe After Effects through a file-based bridge.

The server side runs in Node and exposes MCP tools. The After Effects side is an ExtendScript panel that polls for commands, executes them inside AE, and writes JSON results back to disk.

## Key Files

- `src/index.ts`: MCP server entry point. Defines MCP tools, validates input with Zod, writes bridge commands, and reads results.
- `src/scripts/mcp-bridge-auto.jsx`: Main After Effects panel script. Defines AE-side operations and dispatches queued commands.
- `install-bridge.js`: Installs the AE bridge panel into the After Effects Scripts/ScriptUI Panels location.
- `package.json`: Build/start/install scripts.
- `.mcp.json`: Example MCP client config. Update paths for the local machine before use.
- `build/index.js`: Generated MCP server bundle from `src/index.ts`.
- `build/scripts/mcp-bridge-auto.jsx`: Generated/copied bridge panel script from `src/scripts/mcp-bridge-auto.jsx`.

## Runtime Flow

1. MCP client calls a tool exposed by `src/index.ts`.
2. `src/index.ts` writes a command JSON file to `~/Documents/ae-mcp-bridge/ae_command.json`.
3. The AE panel `mcp-bridge-auto.jsx` polls that command file.
4. `executeCommand(command, args)` dispatches to an AE-side function.
5. The bridge writes JSON output to `~/Documents/ae-mcp-bridge/ae_mcp_result.json`.
6. The MCP server reads that result and returns it to the client.

Bridge helper functions in `src/index.ts`:

- `getAETempDir()`
- `clearResultsFile()`
- `writeCommandFile(command, args)`
- `waitForBridgeResult(expectedCommand, timeoutMs, pollMs)`
- `readResultsFromTempFile()`

AE bridge dispatch is in `src/scripts/mcp-bridge-auto.jsx`:

- `executeCommand(command, args)`
- command cases such as `createComposition`, `setLayerKeyframe`, `applyEffect`, etc.

## Build And Run

Install dependencies:

```bash
npm install
```

Build source into `build/`:

```bash
npm run build
```

Start the MCP server directly:

```bash
npm start
```

Install or refresh the After Effects bridge panel:

```bash
npm run install-bridge
```

After changing `src/scripts/mcp-bridge-auto.jsx`, run `npm run build`, then refresh the installed AE panel with `npm run install-bridge` or manually reopen the panel if needed.

After changing MCP tool definitions in `src/index.ts`, run `npm run build`, then restart the MCP client/session so the tool list refreshes.

## Adding A New MCP Feature

Use this pattern for most feature work:

1. Add or update a `server.tool(...)` definition in `src/index.ts`.
2. Validate inputs with `zod`.
3. Queue the bridge command with `writeCommandFile("commandName", parameters)`.
4. For tools that should return immediate results, call `waitForBridgeResult("commandName", timeout, poll)`.
5. Add the AE-side function in `src/scripts/mcp-bridge-auto.jsx`.
6. Add a matching `case "commandName":` in `executeCommand`.
7. If the command should be callable through the generic `run-script` tool, add it to `allowedScripts` in `src/index.ts`.
8. Run `npm run build`.
9. Test in After Effects with the bridge panel open and Auto-run enabled.

Keep tool names consistent between:

- MCP tool name in `src/index.ts`
- command string passed to `writeCommandFile`
- `executeCommand` switch case in `mcp-bridge-auto.jsx`
- `_commandExecuted` value in the result JSON

## Property Access Workstream

Generic property access is the main enhancement area for controlling effects, expression controls, sliders, shape properties, text properties, and any non-transform property.

When working on property access, inspect these command/tool names first if present:

- `listLayerProperties`
- `getPropertyValue`
- `setPropertyValue`
- `setPropertyKeyframe`
- `setPropertyExpression`

Useful AE concepts and APIs:

- `layer.property(...)`
- `propertyGroup.numProperties`
- `propertyGroup.property(indexOrName)`
- `prop.name`
- `prop.matchName`
- `prop.propertyValueType`
- `prop.value`
- `prop.canVaryOverTime`
- `prop.canSetExpression`
- `prop.setValue(value)`
- `prop.setValueAtTime(time, value)`

Prefer resolving properties by reliable paths when possible:

- human path: `Effects/Slider Control/Slider`
- match-name path: `ADBE Effect Parade > ADBE Slider Control > ADBE Slider Control-0001`
- indexed path when duplicate effect names are possible

Human display names are easier for prompts, but they can collide. Match names and indexed paths are better for repeated effects and production workflows.

## Debugging Checklist

For bridge issues, inspect:

- `~/Documents/ae-mcp-bridge/ae_command.json`
- `~/Documents/ae-mcp-bridge/ae_mcp_result.json`
- the visible log area in the After Effects bridge panel
- whether the AE panel is open
- whether Auto-run commands is enabled
- whether the MCP client is running the expected `build/index.js`
- whether `npm run build` was run after source changes
- whether the bridge panel was reinstalled or reopened after JSX changes

Common failure modes:

- Tool exists in source but not in client: rebuild and restart the MCP client/session.
- Command reaches AE but returns unknown command: add or fix the `executeCommand` case.
- AE behavior did not change after JSX edits: run build, reinstall bridge, and reopen the panel.
- Result appears stale: clear or inspect `ae_mcp_result.json` and rerun the command.
- Display-name property lookup fails: list the property tree and retry with match-name or indexed path.

## Local Codex Setup Notes

For this machine, the active repo path is:

```text
/Users/nasrrslan/Documents/Github/after-effects-mcp
```

The Codex MCP server should point at:

```text
/Users/nasrrslan/Documents/Github/after-effects-mcp/build/index.js
```

If `codex` is not on PATH, the Codex app binary may be:

```text
/Applications/Codex.app/Contents/Resources/codex
```

Example registration:

```bash
/Applications/Codex.app/Contents/Resources/codex mcp add AfterEffectsMCP -- /usr/local/bin/node /Users/nasrrslan/Documents/Github/after-effects-mcp/build/index.js
```

## Testing Prompts

Use small tests before larger automation prompts:

```text
Use AfterEffectsMCP to list available tools and confirm the After Effects bridge is connected.
```

```text
Use AfterEffectsMCP to create a 1920x1080 composition named "MCP Smoke Test", 5 seconds long at 30 fps.
```

```text
Use AfterEffectsMCP to add a text layer to "MCP Smoke Test" that says "Bridge OK".
```

For property access:

```text
Use AfterEffectsMCP to list the full property tree for layer 1 in composition 1.
```

```text
Use AfterEffectsMCP to set the Slider property of a Slider Control effect on layer 1 in composition 1 to 75.
```

