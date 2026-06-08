import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { fileURLToPath } from "url";

// Create an MCP server
const server = new McpServer({
  name: "AfterEffectsServer",
  version: "1.0.0",
});

// ES Modules replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define paths
const SCRIPTS_DIR = path.join(__dirname, "scripts");
const TEMP_DIR = path.join(__dirname, "temp");

// Get the correct directory for AE bridge files
// Use ~/Documents/ae-mcp-bridge for reliable cross-process access
function getAETempDir(): string {
  const homeDir = os.homedir();
  const bridgeDir = path.join(homeDir, "Documents", "ae-mcp-bridge");
  // Ensure the directory exists
  if (!fs.existsSync(bridgeDir)) {
    fs.mkdirSync(bridgeDir, { recursive: true });
  }
  return bridgeDir;
}

// Headless CLI execution has been removed. All interactions are routed through the Bridge panel.

// Helper function to read results from After Effects temp file
function readResultsFromTempFile(): string {
  try {
    const tempFilePath = path.join(getAETempDir(), "ae_mcp_result.json");

    // Add debugging info
    console.error(`Checking for results at: ${tempFilePath}`);

    if (fs.existsSync(tempFilePath)) {
      // Get file stats to check modification time
      const stats = fs.statSync(tempFilePath);
      console.error(
        `Result file exists, last modified: ${stats.mtime.toISOString()}`,
      );

      const content = fs.readFileSync(tempFilePath, "utf8");
      console.error(`Result file content length: ${content.length} bytes`);

      // If the result file is older than 30 seconds, warn the user
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
      if (stats.mtime < thirtySecondsAgo) {
        console.error(
          `WARNING: Result file is older than 30 seconds. After Effects may not be updating results.`,
        );
        return JSON.stringify({
          warning: "Result file appears to be stale (not recently updated).",
          message:
            "This could indicate After Effects is not properly writing results or the MCP Bridge Auto panel isn't running.",
          lastModified: stats.mtime.toISOString(),
          originalContent: content,
        });
      }

      return content;
    } else {
      console.error(`Result file not found at: ${tempFilePath}`);
      return JSON.stringify({
        error:
          "No results file found. Please run a script in After Effects first.",
      });
    }
  } catch (error) {
    console.error("Error reading results file:", error);
    return JSON.stringify({
      error: `Failed to read results: ${String(error)}`,
    });
  }
}

// Helper to wait for a fresh result produced by a specific command
async function waitForBridgeResult(
  expectedCommand?: string,
  timeoutMs: number = 5000,
  pollMs: number = 250,
): Promise<string> {
  const start = Date.now();
  const resultPath = path.join(getAETempDir(), "ae_mcp_result.json");
  let lastSize = -1;

  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      try {
        const content = fs.readFileSync(resultPath, "utf8");
        if (content && content.length > 0 && content.length !== lastSize) {
          lastSize = content.length;
          try {
            const parsed = JSON.parse(content);
            if (
              !expectedCommand ||
              parsed._commandExecuted === expectedCommand
            ) {
              return content;
            }
          } catch {
            // not JSON yet; continue polling
          }
        }
      } catch {
        // transient read error; continue polling
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return JSON.stringify({
    error: `Timed out waiting for bridge result${expectedCommand ? ` for command '${expectedCommand}'` : ""}.`,
  });
}

// Helper function to write command to file
function writeCommandFile(
  command: string,
  args: Record<string, any> = {},
): void {
  try {
    const commandFile = path.join(getAETempDir(), "ae_command.json");
    const commandData = {
      command,
      args,
      timestamp: new Date().toISOString(),
      status: "pending", // pending, running, completed, error
    };
    fs.writeFileSync(commandFile, JSON.stringify(commandData, null, 2));
    console.error(`Command "${command}" written to ${commandFile}`);
  } catch (error) {
    console.error("Error writing command file:", error);
  }
}

// Helper function to clear the results file to avoid stale cache
function clearResultsFile(): void {
  try {
    const resultFile = path.join(getAETempDir(), "ae_mcp_result.json");

    // Write a placeholder message to indicate the file is being reset
    const resetData = {
      status: "waiting",
      message: "Waiting for new result from After Effects...",
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(resultFile, JSON.stringify(resetData, null, 2));
    console.error(`Results file cleared at ${resultFile}`);
  } catch (error) {
    console.error("Error clearing results file:", error);
  }
}

// Add a resource to expose project compositions
server.resource("compositions", "aftereffects://compositions", async (uri) => {
  // Clear old results, queue the command, and wait for bridge output
  clearResultsFile();
  writeCommandFile("listCompositions", {});
  const result = await waitForBridgeResult("listCompositions", 6000, 250);

  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: result,
      },
    ],
  };
});

// Add a tool for running read-only scripts
server.tool(
  "run-script",
  "Run a read-only script in After Effects",
  {
    script: z.string().describe("Name of the predefined script to run"),
    parameters: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional parameters for the script"),
  },
  async ({ script, parameters = {} }) => {
    // Validate that script is safe (only allow predefined scripts)
    const allowedScripts = [
      "listCompositions",
      "getProjectInfo",
      "getLayerInfo",
      "createComposition",
      "createTextLayer",
      "createShapeLayer",
      "createSolidLayer",
      "setLayerProperties",
      "setLayerKeyframe",
      "setLayerExpression",
      "listLayerProperties",
      "getPropertyValue",
      "setPropertyValue",
      "setPropertyKeyframe",
      "listPropertyKeyframes",
      "updateKeyframe",
      "removeKeyframe",
      "setKeyframeEase",
      "setKeyframeInterpolation",
      "setSpatialTangents",
      "setPropertyExpression",
      "getLayerParent",
      "setLayerParent",
      "clearLayerParent",
      "precomposeLayers",
      "addPropertyToEssentialGraphics",
      "addLayerToEssentialGraphics",
      "listEssentialGraphicsControllers",
      "renameEssentialGraphicsController",
      "linkPropertiesWithExpression",
      "applyEffect",
      "applyEffectTemplate",
      "test-animation",
      "bridgeTestEffects",
      "createCamera",
      "batchSetLayerProperties",
      "setCompositionProperties",
      "duplicateLayer",
      "deleteLayer",
      "setLayerMask",
    ];

    if (!allowedScripts.includes(script)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Script "${script}" is not allowed. Allowed scripts are: ${allowedScripts.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    try {
      // Clear any stale result data
      clearResultsFile();

      // Write command to file for After Effects to pick up
      writeCommandFile(script, parameters);

      return {
        content: [
          {
            type: "text",
            text:
              `Command to run "${script}" has been queued.\n` +
              `Please ensure the "MCP Bridge Auto" panel is open in After Effects.\n` +
              `Use the "get-results" tool after a few seconds to check for results.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing command: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Add a tool to get the results from the last script execution
server.tool(
  "get-results",
  "Get results from the last script executed in After Effects",
  {},
  async () => {
    try {
      const result = readResultsFromTempFile();
      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting results: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Add prompts for common After Effects tasks
server.prompt(
  "list-compositions",
  "List compositions in the current After Effects project",
  () => {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Please list all compositions in the current After Effects project.",
          },
        },
      ],
    };
  },
);

server.prompt(
  "analyze-composition",
  {
    compositionName: z.string().describe("Name of the composition to analyze"),
  },
  (args) => {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please analyze the composition named "${args.compositionName}" in the current After Effects project. Provide details about its duration, frame rate, resolution, and layers.`,
          },
        },
      ],
    };
  },
);

// Add a prompt for creating compositions
server.prompt(
  "create-composition",
  "Create a new composition with specified settings",
  () => {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please create a new composition with custom settings. You can specify parameters like name, width, height, frame rate, etc.`,
          },
        },
      ],
    };
  },
);

// Add a tool to provide help and instructions
server.tool(
  "get-help",
  "Get help on using the After Effects MCP integration",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: `# After Effects MCP Integration Help

To use this integration with After Effects, follow these steps:

 1. **Install the scripts in After Effects**
   - Run \`node install-bridge.js\` with administrator privileges
   - This copies the necessary scripts to your After Effects installation

2. **Open After Effects**
   - Launch Adobe After Effects 
   - Open a project that you want to work with

3. **Open the MCP Bridge Auto panel**
   - In After Effects, go to Window > mcp-bridge-auto.jsx
   - The panel will automatically check for commands every few seconds

4. **Run scripts through MCP**
   - Use the \`run-script\` tool to queue a command
   - The Auto panel will detect and run the command automatically
   - Results will be saved to a temp file
   - MCP clients can also inspect each tool's built-in description and typed parameter schema directly

5. **Get results through MCP**
   - After a command is executed, use the \`get-results\` tool
   - This will retrieve the results from After Effects

Tool categories:
- Project/composition: list compositions, create compositions, set composition properties, precompose layers
- Layer editing: create layers, set layer properties, parent/unparent layers, duplicate/delete layers, masks
- Property editing: inspect properties, read/set values, expressions, expression links
- Keyframes: create, list, update, remove, ease, interpolation, and spatial tangents
- Essential Graphics: add supported properties or media-replacement layers, list controllers, rename controllers
- Effects: apply effects and templates

Effect Templates:
- gaussian-blur: Simple Gaussian blur effect
- directional-blur: Motion blur in a specific direction
- color-balance: Adjust hue, lightness, and saturation
- brightness-contrast: Basic brightness and contrast adjustment
- curves: Advanced color adjustment using curves
- glow: Add a glow effect to elements
- drop-shadow: Add a customizable drop shadow
- cinematic-look: Combination of effects for a cinematic appearance
- text-pop: Effects to make text stand out (glow and shadow)

Note: The auto-running panel can be left open in After Effects to continuously listen for commands from external applications.`,
        },
      ],
    };
  },
);

// Add a tool specifically for creating compositions
server.tool(
  "create-composition",
  "Create a new composition in After Effects with specified parameters",
  {
    name: z.string().describe("Name of the composition"),
    width: z
      .number()
      .int()
      .positive()
      .describe("Width of the composition in pixels"),
    height: z
      .number()
      .int()
      .positive()
      .describe("Height of the composition in pixels"),
    pixelAspect: z
      .number()
      .positive()
      .optional()
      .describe("Pixel aspect ratio (default: 1.0)"),
    duration: z
      .number()
      .positive()
      .optional()
      .describe("Duration in seconds (default: 10.0)"),
    frameRate: z
      .number()
      .positive()
      .optional()
      .describe("Frame rate in frames per second (default: 30.0)"),
    backgroundColor: z
      .object({
        r: z.number().int().min(0).max(255),
        g: z.number().int().min(0).max(255),
        b: z.number().int().min(0).max(255),
      })
      .optional()
      .describe("Background color of the composition (RGB values 0-255)"),
  },
  async (params) => {
    try {
      // Write command to file for After Effects to pick up
      writeCommandFile("createComposition", params);

      return {
        content: [
          {
            type: "text",
            text:
              `Command to create composition "${params.name}" has been queued.\n` +
              `Please ensure the "MCP Bridge Auto" panel is open in After Effects.\n` +
              `Use the "get-results" tool after a few seconds to check for results.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing composition creation: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- BEGIN NEW TOOLS ---

// Zod schema for common layer identification
const LayerIdentifierSchema = {
  compIndex: z
    .number()
    .int()
    .positive()
    .describe("1-based index of the target composition in the project panel."),
  layerIndex: z
    .number()
    .int()
    .positive()
    .describe("1-based index of the target layer within the composition."),
};

const PropertyLocatorSchema = {
  propertyPath: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      "Property path, either as a slash-delimited string like 'Effects/Slider Control/Slider' or an array of path segments. Match-name paths are also supported.",
    ),
  propertyName: z
    .string()
    .optional()
    .describe(
      "Fallback property name for older transform/effects/text access patterns.",
    ),
};

const CompositionIdentifierSchema = {
  compIndex: z
    .number()
    .int()
    .positive()
    .describe("1-based index of the target composition in the project panel."),
};

const EssentialGraphicsControllerNameSchema = {
  controllerName: z
    .string()
    .optional()
    .describe(
      "Optional Essential Graphics controller name to assign when adding the item.",
    ),
};

// Zod schema for keyframe value (more specific types might be needed depending on property)
// Using z.any() for flexibility, but can be refined (e.g., z.array(z.number()) for position/scale)
const KeyframeValueSchema = z
  .unknown()
  .describe(
    "The value for the keyframe (e.g., [x,y] for Position, [w,h] for Scale, angle for Rotation, percentage for Opacity)",
  );

const KeyframeIdentifierSchema = {
  keyIndex: z
    .number()
    .int()
    .positive()
    .describe("1-based keyframe index on the targeted property."),
};

const KeyframeEaseEntrySchema = z.object({
  speed: z.number().describe("Keyframe ease speed value."),
  influence: z
    .number()
    .min(0.1)
    .max(100)
    .describe("Keyframe ease influence in the range 0.1 to 100."),
});

const KeyframeEaseConfigSchema = z
  .union([KeyframeEaseEntrySchema, z.array(KeyframeEaseEntrySchema).min(1)])
  .describe(
    "Either one ease object to reuse across dimensions or an array with one entry per property dimension.",
  );

server.tool(
  "listLayerProperties",
  "List the full property tree for a layer, including paths, match names, values, and keyframe capability.",
  {
    ...LayerIdentifierSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("listLayerProperties", parameters);
      const result = await waitForBridgeResult(
        "listLayerProperties",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing layer properties: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "getPropertyValue",
  "Read the current value and metadata for any layer property by property path or property name.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("getPropertyValue", parameters);
      const result = await waitForBridgeResult("getPropertyValue", 7000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting property value: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "setPropertyValue",
  "Set the current value for any layer property by property path or property name.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
    value: z
      .unknown()
      .describe("The value to assign to the targeted property."),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("setPropertyValue", parameters);
      const result = await waitForBridgeResult("setPropertyValue", 7000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting property value: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "setPropertyKeyframe",
  "Add or update a keyframe for any animatable layer property by property path or property name.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
    timeInSeconds: z.number().describe("The time in seconds for the keyframe."),
    value: KeyframeValueSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("setPropertyKeyframe", parameters);
      const result = await waitForBridgeResult(
        "setPropertyKeyframe",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting property keyframe: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "listPropertyKeyframes",
  "List all keyframes for a property, including timing, value, interpolation, and ease metadata.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("listPropertyKeyframes", parameters);
      const result = await waitForBridgeResult(
        "listPropertyKeyframes",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing property keyframes: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "updateKeyframe",
  "Update an existing keyframe's value and optionally move it to a new time.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
    ...KeyframeIdentifierSchema,
    timeInSeconds: z
      .number()
      .optional()
      .describe("Optional new time in seconds for the keyframe."),
    value: z
      .unknown()
      .optional()
      .describe("Optional new value for the keyframe."),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("updateKeyframe", parameters);
      const result = await waitForBridgeResult("updateKeyframe", 7000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error updating keyframe: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "removeKeyframe",
  "Remove a keyframe from a property by keyframe index.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
    ...KeyframeIdentifierSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("removeKeyframe", parameters);
      const result = await waitForBridgeResult("removeKeyframe", 7000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error removing keyframe: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "setKeyframeEase",
  "Set temporal ease for an existing keyframe using speed and influence values.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
    ...KeyframeIdentifierSchema,
    easeIn: KeyframeEaseConfigSchema,
    easeOut: KeyframeEaseConfigSchema
      .optional()
      .describe("Optional outgoing ease. Defaults to the incoming ease."),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("setKeyframeEase", parameters);
      const result = await waitForBridgeResult("setKeyframeEase", 7000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting keyframe ease: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "setKeyframeInterpolation",
  "Set the incoming and outgoing interpolation types for an existing keyframe.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
    ...KeyframeIdentifierSchema,
    inType: z
      .enum(["LINEAR", "BEZIER", "HOLD"])
      .describe("Incoming interpolation type."),
    outType: z
      .enum(["LINEAR", "BEZIER", "HOLD"])
      .optional()
      .describe("Optional outgoing interpolation type. Defaults to inType."),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("setKeyframeInterpolation", parameters);
      const result = await waitForBridgeResult(
        "setKeyframeInterpolation",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting keyframe interpolation: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "setSpatialTangents",
  "Set spatial tangents for an existing 2D or 3D spatial keyframe.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
    ...KeyframeIdentifierSchema,
    inTangent: z
      .array(z.number())
      .min(2)
      .max(3)
      .describe("Incoming spatial tangent vector."),
    outTangent: z
      .array(z.number())
      .min(2)
      .max(3)
      .optional()
      .describe("Optional outgoing spatial tangent vector. Defaults to inTangent."),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("setSpatialTangents", parameters);
      const result = await waitForBridgeResult("setSpatialTangents", 7000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting spatial tangents: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "setPropertyExpression",
  "Set or remove an expression for any expression-capable layer property by property path or property name.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
    expressionString: z
      .string()
      .describe(
        "The expression to assign. Use an empty string to remove the expression.",
      ),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("setPropertyExpression", parameters);
      const result = await waitForBridgeResult(
        "setPropertyExpression",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting property expression: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "getLayerParent",
  "Read the current parent relationship for a layer.",
  {
    ...LayerIdentifierSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("getLayerParent", parameters);
      const result = await waitForBridgeResult("getLayerParent", 7000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting layer parent: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "setLayerParent",
  "Parent a layer to another layer in the same composition.",
  {
    ...LayerIdentifierSchema,
    parentLayerIndex: z
      .number()
      .int()
      .positive()
      .describe("1-based index of the layer to use as the new parent."),
    preserveWorldTransform: z
      .boolean()
      .optional()
      .describe(
        "When true or omitted, preserve the child layer's current world transform while parenting.",
      ),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("setLayerParent", parameters);
      const result = await waitForBridgeResult("setLayerParent", 7000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layer parent: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "clearLayerParent",
  "Remove any current parent from a layer.",
  {
    ...LayerIdentifierSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("clearLayerParent", parameters);
      const result = await waitForBridgeResult("clearLayerParent", 7000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error clearing layer parent: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "precomposeLayers",
  "Precompose one or more layers into a new composition.",
  {
    ...CompositionIdentifierSchema,
    layerIndices: z
      .array(z.number().int().positive())
      .min(1)
      .describe("1-based indices of the layers to precompose."),
    name: z.string().describe("Name of the new precomposition."),
    moveAllAttributes: z
      .boolean()
      .optional()
      .describe(
        "When false, leave attributes in the original comp. After Effects only supports this for a single-layer precompose.",
      ),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("precomposeLayers", parameters);
      const result = await waitForBridgeResult("precomposeLayers", 10000, 250);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error precomposing layers: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "addPropertyToEssentialGraphics",
  "Add a supported property to the Essential Graphics panel for a composition.",
  {
    ...LayerIdentifierSchema,
    ...PropertyLocatorSchema,
    ...EssentialGraphicsControllerNameSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("addPropertyToEssentialGraphics", parameters);
      const result = await waitForBridgeResult(
        "addPropertyToEssentialGraphics",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error adding property to Essential Graphics: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "addLayerToEssentialGraphics",
  "Add a supported media-replacement layer to the Essential Graphics panel.",
  {
    ...LayerIdentifierSchema,
    ...EssentialGraphicsControllerNameSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("addLayerToEssentialGraphics", parameters);
      const result = await waitForBridgeResult(
        "addLayerToEssentialGraphics",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error adding layer to Essential Graphics: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "listEssentialGraphicsControllers",
  "List Essential Graphics controllers currently exposed by a composition.",
  {
    ...CompositionIdentifierSchema,
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("listEssentialGraphicsControllers", parameters);
      const result = await waitForBridgeResult(
        "listEssentialGraphicsControllers",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing Essential Graphics controllers: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "renameEssentialGraphicsController",
  "Rename an Essential Graphics controller by index.",
  {
    ...CompositionIdentifierSchema,
    controllerIndex: z
      .number()
      .int()
      .positive()
      .describe("1-based Essential Graphics controller index."),
    newName: z.string().describe("New controller name."),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("renameEssentialGraphicsController", parameters);
      const result = await waitForBridgeResult(
        "renameEssentialGraphicsController",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error renaming Essential Graphics controller: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "linkPropertiesWithExpression",
  "Link a target property to a source property by writing a reference expression.",
  {
    targetCompIndex: z
      .number()
      .int()
      .positive()
      .describe("1-based index of the composition containing the target layer."),
    targetLayerIndex: z
      .number()
      .int()
      .positive()
      .describe("1-based index of the target layer."),
    targetPropertyPath: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Property path for the target property."),
    targetPropertyName: z
      .string()
      .optional()
      .describe("Fallback target property name."),
    sourceCompIndex: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Optional 1-based index of the source composition. Defaults to the target composition.",
      ),
    sourceLayerIndex: z
      .number()
      .int()
      .positive()
      .describe("1-based index of the source layer."),
    sourcePropertyPath: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Property path for the source property."),
    sourcePropertyName: z
      .string()
      .optional()
      .describe("Fallback source property name."),
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("linkPropertiesWithExpression", parameters);
      const result = await waitForBridgeResult(
        "linkPropertiesWithExpression",
        7000,
        250,
      );

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error linking properties with expression: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool for setting a layer keyframe
server.tool(
  "setLayerKeyframe", // Corresponds to the function name in ExtendScript
  "Set a keyframe for a specific layer property at a given time.",
  {
    ...LayerIdentifierSchema, // Reuse common identifiers
    propertyName: z
      .string()
      .describe(
        "Name of the property to keyframe (e.g., 'Position', 'Scale', 'Rotation', 'Opacity').",
      ),
    timeInSeconds: z
      .number()
      .describe("The time (in seconds) for the keyframe."),
    value: KeyframeValueSchema,
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("setLayerKeyframe", parameters);

      return {
        content: [
          {
            type: "text",
            text:
              `Command to set keyframe for "${parameters.propertyName}" on layer ${parameters.layerIndex} in comp ${parameters.compIndex} has been queued.\n` +
              `Use the "get-results" tool after a few seconds to check for confirmation.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing setLayerKeyframe command: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool for setting a layer expression
server.tool(
  "setLayerExpression", // Corresponds to the function name in ExtendScript
  "Set or remove an expression for a specific layer property.",
  {
    ...LayerIdentifierSchema, // Reuse common identifiers
    propertyName: z
      .string()
      .describe(
        "Name of the property to apply the expression to (e.g., 'Position', 'Scale', 'Rotation', 'Opacity').",
      ),
    expressionString: z
      .string()
      .describe(
        'The JavaScript expression string. Provide an empty string ("") to remove the expression.',
      ),
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("setLayerExpression", parameters);

      return {
        content: [
          {
            type: "text",
            text:
              `Command to set expression for "${parameters.propertyName}" on layer ${parameters.layerIndex} in comp ${parameters.compIndex} has been queued.\n` +
              `Use the "get-results" tool after a few seconds to check for confirmation.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing setLayerExpression command: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- END NEW TOOLS ---

// --- BEGIN NEW TESTING TOOL ---
// Add a special tool for directly testing the keyframe functionality
server.tool(
  "test-animation",
  "Test animation functionality in After Effects",
  {
    operation: z
      .enum(["keyframe", "expression"])
      .describe("The animation operation to test"),
    compIndex: z
      .number()
      .int()
      .positive()
      .describe("Composition index (usually 1)"),
    layerIndex: z.number().int().positive().describe("Layer index (usually 1)"),
  },
  async (params) => {
    try {
      // Generate a unique timestamp
      const timestamp = new Date().getTime();
      const tempFile = path.join(
        process.env.TEMP || process.env.TMP || os.tmpdir(),
        `ae_test_${timestamp}.jsx`,
      );

      // Create a direct test script that doesn't rely on command files
      let scriptContent = "";
      if (params.operation === "keyframe") {
        scriptContent = `
          // Direct keyframe test script
          try {
            var comp = app.project.items[${params.compIndex}];
            var layer = comp.layers[${params.layerIndex}];
            var prop = layer.property("Transform").property("Opacity");
            var time = 1; // 1 second
            var value = 25; // 25% opacity
            
            // Set a keyframe
            prop.setValueAtTime(time, value);
            
            // Write direct result
            var resultFile = new File("${path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), "ae_test_result.txt").replace(/\\/g, "\\\\")}");
            resultFile.open("w");
            resultFile.write("SUCCESS: Added keyframe at time " + time + " with value " + value);
            resultFile.close();
            
            // Visual feedback
            alert("Test successful: Added opacity keyframe at " + time + "s with value " + value + "%");
          } catch (e) {
            var errorFile = new File("${path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), "ae_test_error.txt").replace(/\\/g, "\\\\")}");
            errorFile.open("w");
            errorFile.write("ERROR: " + e.toString());
            errorFile.close();
            
            alert("Test failed: " + e.toString());
          }
        `;
      } else if (params.operation === "expression") {
        scriptContent = `
          // Direct expression test script
          try {
            var comp = app.project.items[${params.compIndex}];
            var layer = comp.layers[${params.layerIndex}];
            var prop = layer.property("Transform").property("Position");
            var expression = "wiggle(3, 30)";
            
            // Set the expression
            prop.expression = expression;
            
            // Write direct result
            var resultFile = new File("${path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), "ae_test_result.txt").replace(/\\/g, "\\\\")}");
            resultFile.open("w");
            resultFile.write("SUCCESS: Added expression: " + expression);
            resultFile.close();
            
            // Visual feedback
            alert("Test successful: Added position expression: " + expression);
          } catch (e) {
            var errorFile = new File("${path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), "ae_test_error.txt").replace(/\\/g, "\\\\")}");
            errorFile.open("w");
            errorFile.write("ERROR: " + e.toString());
            errorFile.close();
            
            alert("Test failed: " + e.toString());
          }
        `;
      }

      // Write the script to a temp file
      fs.writeFileSync(tempFile, scriptContent);
      console.error(`Written test script to: ${tempFile}`);

      // Tell the user what to do
      return {
        content: [
          {
            type: "text",
            text: `I've created a direct test script for the ${params.operation} operation.

Please run this script manually in After Effects:
1. In After Effects, go to File > Scripts > Run Script File...
2. Navigate to: ${tempFile}
3. You should see an alert confirming the result.

This bypasses the MCP Bridge Auto panel and will directly modify the specified layer.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating test script: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);
// --- END NEW TESTING TOOL ---

// --- BEGIN NEW EFFECTS TOOLS ---

// Add a tool for applying effects to layers
server.tool(
  "apply-effect",
  "Apply an effect to a layer in After Effects",
  {
    compIndex: z
      .number()
      .int()
      .positive()
      .describe(
        "1-based index of the target composition in the project panel.",
      ),
    layerIndex: z
      .number()
      .int()
      .positive()
      .describe("1-based index of the target layer within the composition."),
    effectName: z
      .string()
      .optional()
      .describe("Display name of the effect to apply (e.g., 'Gaussian Blur')."),
    effectMatchName: z
      .string()
      .optional()
      .describe(
        "After Effects internal name for the effect (more reliable, e.g., 'ADBE Gaussian Blur 2').",
      ),
    effectCategory: z
      .string()
      .optional()
      .describe("Optional category for filtering effects."),
    presetPath: z
      .string()
      .optional()
      .describe("Optional path to an effect preset file (.ffx)."),
    effectSettings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Optional parameters for the effect (e.g., { 'Blurriness': 25 }).",
      ),
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("applyEffect", parameters);

      return {
        content: [
          {
            type: "text",
            text:
              `Command to apply effect to layer ${parameters.layerIndex} in composition ${parameters.compIndex} has been queued.\n` +
              `Use the "get-results" tool after a few seconds to check for confirmation.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing apply-effect command: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Add a tool for applying effect templates
server.tool(
  "apply-effect-template",
  "Apply a predefined effect template to a layer in After Effects",
  {
    compIndex: z
      .number()
      .int()
      .positive()
      .describe(
        "1-based index of the target composition in the project panel.",
      ),
    layerIndex: z
      .number()
      .int()
      .positive()
      .describe("1-based index of the target layer within the composition."),
    templateName: z
      .enum([
        "gaussian-blur",
        "directional-blur",
        "color-balance",
        "brightness-contrast",
        "curves",
        "glow",
        "drop-shadow",
        "cinematic-look",
        "text-pop",
      ])
      .describe("Name of the effect template to apply."),
    customSettings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional custom settings to override defaults."),
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("applyEffectTemplate", parameters);

      return {
        content: [
          {
            type: "text",
            text:
              `Command to apply effect template '${parameters.templateName}' to layer ${parameters.layerIndex} in composition ${parameters.compIndex} has been queued.\n` +
              `Use the "get-results" tool after a few seconds to check for confirmation.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing apply-effect-template command: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- END NEW EFFECTS TOOLS ---

// Add direct MCP function for applying effects
server.tool(
  "mcp_aftereffects_applyEffect",
  "Apply an effect to a layer in After Effects",
  {
    compIndex: z
      .number()
      .int()
      .positive()
      .describe(
        "1-based index of the target composition in the project panel.",
      ),
    layerIndex: z
      .number()
      .int()
      .positive()
      .describe("1-based index of the target layer within the composition."),
    effectName: z
      .string()
      .optional()
      .describe("Display name of the effect to apply (e.g., 'Gaussian Blur')."),
    effectMatchName: z
      .string()
      .optional()
      .describe(
        "After Effects internal name for the effect (more reliable, e.g., 'ADBE Gaussian Blur 2').",
      ),
    effectSettings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Optional parameters for the effect (e.g., { 'Blurriness': 25 }).",
      ),
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("applyEffect", parameters);

      // Wait a bit for After Effects to process the command
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Get the results
      const result = readResultsFromTempFile();

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error applying effect: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Add direct MCP function for applying effect templates
server.tool(
  "mcp_aftereffects_applyEffectTemplate",
  "Apply a predefined effect template to a layer in After Effects",
  {
    compIndex: z
      .number()
      .int()
      .positive()
      .describe(
        "1-based index of the target composition in the project panel.",
      ),
    layerIndex: z
      .number()
      .int()
      .positive()
      .describe("1-based index of the target layer within the composition."),
    templateName: z
      .enum([
        "gaussian-blur",
        "directional-blur",
        "color-balance",
        "brightness-contrast",
        "curves",
        "glow",
        "drop-shadow",
        "cinematic-look",
        "text-pop",
      ])
      .describe("Name of the effect template to apply."),
    customSettings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional custom settings to override defaults."),
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("applyEffectTemplate", parameters);

      // Wait a bit for After Effects to process the command
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Get the results
      const result = readResultsFromTempFile();

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error applying effect template: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Update help information to include the new effects tools
server.tool(
  "mcp_aftereffects_get_effects_help",
  "Get help on using After Effects effects",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: `# After Effects Effects Help

## Common Effect Match Names
These are internal names used by After Effects that can be used with the \`effectMatchName\` parameter:

### Blur & Sharpen
- Gaussian Blur: "ADBE Gaussian Blur 2"
- Camera Lens Blur: "ADBE Camera Lens Blur"
- Directional Blur: "ADBE Directional Blur"
- Radial Blur: "ADBE Radial Blur"
- Smart Blur: "ADBE Smart Blur"
- Unsharp Mask: "ADBE Unsharp Mask"

### Color Correction
- Brightness & Contrast: "ADBE Brightness & Contrast 2"
- Color Balance: "ADBE Color Balance (HLS)"
- Color Balance (RGB): "ADBE Pro Levels2"
- Curves: "ADBE CurvesCustom"
- Exposure: "ADBE Exposure2"
- Hue/Saturation: "ADBE HUE SATURATION"
- Levels: "ADBE Pro Levels2"
- Vibrance: "ADBE Vibrance"

### Stylistic
- Glow: "ADBE Glow"
- Drop Shadow: "ADBE Drop Shadow"
- Bevel Alpha: "ADBE Bevel Alpha"
- Noise: "ADBE Noise"
- Fractal Noise: "ADBE Fractal Noise"
- CC Particle World: "CC Particle World"
- CC Light Sweep: "CC Light Sweep"

## Effect Templates
The following predefined effect templates are available:

- \`gaussian-blur\`: Simple Gaussian blur effect
- \`directional-blur\`: Motion blur in a specific direction
- \`color-balance\`: Adjust hue, lightness, and saturation
- \`brightness-contrast\`: Basic brightness and contrast adjustment
- \`curves\`: Advanced color adjustment using curves
- \`glow\`: Add a glow effect to elements
- \`drop-shadow\`: Add a customizable drop shadow
- \`cinematic-look\`: Combination of effects for a cinematic appearance
- \`text-pop\`: Effects to make text stand out (glow and shadow)

## Example Usage
To apply a Gaussian blur effect:

\`\`\`json
{
  "compIndex": 1,
  "layerIndex": 1,
  "effectMatchName": "ADBE Gaussian Blur 2",
  "effectSettings": {
    "Blurriness": 25
  }
}
\`\`\`

To apply the "cinematic-look" template:

\`\`\`json
{
  "compIndex": 1,
  "layerIndex": 1,
  "templateName": "cinematic-look"
}
\`\`\`
`,
        },
      ],
    };
  },
);

// Add a direct tool for our bridge test effects
server.tool(
  "run-bridge-test",
  "Run the bridge test effects script to verify communication and apply test effects",
  {},
  async () => {
    try {
      // Clear any stale result data
      clearResultsFile();

      // Write command to file for After Effects to pick up
      writeCommandFile("bridgeTestEffects", {});

      return {
        content: [
          {
            type: "text",
            text:
              `Bridge test effects command has been queued.\n` +
              `Please ensure the "MCP Bridge Auto" panel is open in After Effects.\n` +
              `Use the "get-results" tool after a few seconds to check for the test results.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing bridge test command: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Start the MCP server
async function main() {
  console.error("After Effects MCP Server starting...");
  console.error(`Scripts directory: ${SCRIPTS_DIR}`);
  console.error(`Temp directory: ${TEMP_DIR}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("After Effects MCP Server running...");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
