import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { app } from "./app";
import { createServer } from "./mcp";

// Requests to /mcp arrive here only with a valid access token; the provider puts
// the signed-in user (UserProps) on ctx.props, which getMcpAuthContext() reads.
const mcp = {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return createMcpHandler(() => createServer(env), { route: "/mcp" })(request, env, ctx);
	},
};

// The provider needs the public URL at construction, and that comes from env.
let provider: OAuthProvider<Env> | undefined;

export default {
	fetch(request, env, ctx) {
		provider ??= new OAuthProvider<Env>({
			resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, resource_name: "Транскрайбер КС" },
			apiRoute: "/mcp",
			apiHandler: mcp,
			defaultHandler: app as unknown as ExportedHandler<Env>,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			// Newer MCP clients identify themselves by a metadata URL instead of registering.
			clientIdMetadataDocumentEnabled: true,
		});
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
