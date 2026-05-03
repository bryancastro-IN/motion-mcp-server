import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpAgent } from "agents/mcp";
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

// Keep exported for wrangler.toml Durable Object binding
export class MotionMCPAgent extends McpAgent<Env> {
  server = new McpServer({ name: "motion-mcp-server", version: "2.8.0" });
  async init() {}
}

function buildServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "motion-mcp-server", version: "2.8.0" },
    { instructions: SERVER_INSTRUCTIONS }
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
    server.tool(tool.name, tool.description, zodShape, async (params) => {
      const handler = handlerFactory.createHandler(tool.name);
      return await handler.handle(params);
    });
  }

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", server: "motion-mcp-server" }),
        { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    // MCP endpoint - Streamable HTTP transport
    if (url.pathname.startsWith("/mcp")) {
      const server = buildServer(env);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);

      const response = await transport.handleRequest(request as unknown as import("node:http").IncomingMessage, {} as import("node:http").ServerResponse);

      return new Response(response?.body as BodyInit, {
        status: response?.statusCode ?? 200,
        headers: {
          ...(response?.headers as Record<string, string>),
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
