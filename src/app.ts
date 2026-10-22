import {
	AuthorizationError,
	CimdFetchError,
	authorizationErrorRedirect,
	type AuthRequest,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { MAX_AUDIO_BYTES } from "./audio";
import { randomToken, sha256Base64Url } from "./encoding";
import { fetchGoogleUser, googleAuthorizeUrl, isAllowedUser } from "./google";
import type { UserProps } from "./mcp";
import { TranscriptionError } from "./near";
import { consentPage, homePage, messagePage } from "./pages";
import { checkAudio, runTranscription, tooLargeError } from "./pipeline";
import { isUploadUsed, markUploadUsed, verifyUploadTicket } from "./uploads";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** Everything outside `/mcp`: the sign-in flow, upload links and a landing page. */
export const app = new Hono<{ Bindings: Bindings }>();

const html = (body: string, status = 200, headers = new Headers()) => {
	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(body, { status, headers });
};

const text = (body: string, status: number) =>
	new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// Proxy servers learn who the user is only after consent, so the approval is
// remembered per browser rather than per user (docs/consent-page.md in the library).
const rememberConsent = (env: Env) => ({ secret: env.SIGNING_SECRET });

app.get("/", (c) => html(homePage(new URL(c.req.url).origin)));

app.get("/authorize", async (c) => {
	const oauth = c.env.OAUTH_PROVIDER;
	const request = await oauth.parseAuthRequest(c.req.raw);
	if (await oauth.isConsentRemembered(c.req.raw, request, rememberConsent(c.env))) {
		return redirectToGoogle(c.env, c.req.url, request, new Headers());
	}
	const details = await oauth.describeConsent(request);
	const consent = await oauth.beginConsent(request);
	return html(consentPage(details, consent.handle, c.env.ALLOWED_DOMAIN), 200, consent.headers);
});

app.post("/authorize", async (c) => {
	const oauth = c.env.OAUTH_PROVIDER;
	const form = await c.req.raw.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(c.req.raw, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const approved = await oauth.approveConsent(c.req.raw, handle, { remember: rememberConsent(c.env) });
	return redirectToGoogle(c.env, c.req.url, approved.request, approved.headers);
});

async function redirectToGoogle(env: Bindings, requestUrl: string, request: AuthRequest, headers: Headers) {
	const verifier = randomToken(32);
	const upstream = await env.OAUTH_PROVIDER.beginUpstream(request, { data: { verifier }, headers });
	upstream.headers.set(
		"Location",
		googleAuthorizeUrl({
			clientId: env.GOOGLE_CLIENT_ID,
			redirectUri: new URL("/callback", requestUrl).href,
			state: upstream.state,
			codeChallenge: await sha256Base64Url(verifier),
			hostedDomain: env.ALLOWED_DOMAIN,
		}),
	);
	return new Response(null, { status: 302, headers: upstream.headers });
}

app.get("/callback", async (c) => {
	const oauth = c.env.OAUTH_PROVIDER;
	const { request, data, headers } = await oauth.finishUpstream<{ verifier: string }>(c.req.raw);
	const url = new URL(c.req.url);
	const code = url.searchParams.get("code");
	if (url.searchParams.get("error") || !code) {
		headers.set("Location", authorizationErrorRedirect(request, "access_denied"));
		return new Response(null, { status: 302, headers });
	}

	const user = await fetchGoogleUser({
		clientId: c.env.GOOGLE_CLIENT_ID,
		clientSecret: c.env.GOOGLE_CLIENT_SECRET,
		code,
		codeVerifier: data.verifier,
		redirectUri: new URL("/callback", c.req.url).href,
	});
	if (!isAllowedUser(user, c.env.ALLOWED_DOMAIN)) {
		console.warn(JSON.stringify({ event: "login_rejected", email: user.email, hd: user.hd ?? null }));
		return html(
			messagePage(
				"Доступ заборонено",
				`Транскрайбер працює лише з робочими акаунтами @${c.env.ALLOWED_DOMAIN}. Ви увійшли як ${user.email}. Закрийте цю вкладку і підключіться ще раз, обравши робочий акаунт.`,
			),
			403,
			headers,
		);
	}

	const props: UserProps = { email: user.email, name: user.name ?? user.email };
	const { redirectTo } = await oauth.completeAuthorization({
		request,
		userId: user.sub,
		metadata: { label: user.email },
		scope: request.scope,
		props,
	});
	console.log(JSON.stringify({ event: "login", email: user.email }));
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
});

// The other half of the `create_upload_link` tool: the audio arrives here as the
// raw request body (`curl -T file URL`), so it never passes through the model.
app.on(["PUT", "POST"], "/upload/:token", async (c) => {
	const ticket = await verifyUploadTicket(c.env.SIGNING_SECRET, c.req.param("token"));
	if (!ticket) return text("Посилання недійсне або прострочене. Попросіть Claude створити нове.", 404);
	if (await isUploadUsed(c.env.OAUTH_KV, ticket.nonce)) {
		return text("Це посилання вже використане. Попросіть Claude створити нове.", 410);
	}

	try {
		const declared = Number(c.req.header("Content-Length") ?? 0);
		if (declared > MAX_AUDIO_BYTES) throw tooLargeError(declared);
		const bytes = new Uint8Array(await c.req.arrayBuffer());
		const ext = checkAudio(bytes);
		const out = await runTranscription(c.env.NEAR_API_KEY, bytes, ext, ticket, { via: "upload", nonce: ticket.nonce });
		await markUploadUsed(c.env.OAUTH_KV, ticket.nonce);
		return new Response(out.body, { headers: { "Content-Type": out.contentType } });
	} catch (error) {
		if (error instanceof TranscriptionError) return text(error.message, error.status);
		throw error;
	}
});

app.onError((error) => {
	if (error instanceof AuthorizationError && error.redirectTo) {
		return Response.redirect(error.redirectTo, 302);
	}
	if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
		const message =
			error instanceof AuthorizationError
				? `${error.description}. Почніть підключення в Claude ще раз.`
				: "Не вдалося перевірити застосунок, який просить доступ.";
		return html(messagePage("Підключення не вдалося", message), 400);
	}
	console.error(error);
	return html(messagePage("Щось пішло не так", "Спробуйте ще раз за хвилину."), 500);
});
