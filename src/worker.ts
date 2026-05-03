import { createMcpHandler } from "agents/mcp";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MotionApiService } from "./services/motionApi";
import { WorkspaceResolver } from "./utils/workspaceResolver";
import { InputValidator } from "./utils/validator";
import { HandlerFactory } from "./handlers/HandlerFactory";
import { ToolRegistry, ToolConfigurator } from "./tools";
import { jsonSchemaToZodShape } from "./utils/jsonSchemaToZod";
import { SERVER_INSTRUCTIONS } from "./utils/serverInstructions";

interface Env {
  MOTION_API_KEY: string;
  MOTION_MCP_TOOLS?: string;
  MCP_OBJECT: DurableObjectNamespace;
}

// Keep exported for wrangler.toml Durable Object binding compatibility
export class MotionMCPAgent extends McpAgent<Env> {
  server = new McpServer(
    { name: "motion-mcp-server", version: "2.8.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  async init() {}
}

function createMotionServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "motion-mcp-server", version: "2.8.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const motionService = new MotionApiService(env.MOTION_API_KEY);
  const workspaceResolver = new WorkspaceResolver(motionService);
  const validator = new InputValidator();
  const context = { motionService, workspaceResolver, validator };
  const handlerFactory = new HandlerFactory(context);

  const registry = new ToolRegistry();
  const configurator = new ToolConfigurator(
    env.MOTION_MCP_TOOLS || "complete",
    registry
  );
  const enabledTools = configurator.getEnabledTools();
  validator.initializeValidators(enabledTools);

  for (const tool of enabledTools) {
    const zodShape = jsonSchemaToZodShape(
      tool.inputSchema as Parameters<typeof jsonSchemaToZodShape>[0]
    );
    server.tool(
      tool.name,
      tool.description,
      zodShape,
      async (params) => {
        const handler = handlerFactory.createHandler(tool.name);
        return await handler.handle(params);
      }
    );
  }

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", server: "motion-mcp-server" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Streamable HTTP transport via createMcpHandler (new per-request instance)
    const server = createMotionServer(env);
    return createMcpHandler(server, {
      corsOptions: {
        origin: "*",
        methods: "GET, POST, DELETE, OPTIONS",
        headers: "Content-Type, Authorization, mcp-session-id",
      }
    })(request, env, ctx);
  },
};
