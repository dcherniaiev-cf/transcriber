/** Claims from Google's OpenID Connect userinfo endpoint. */
export interface GoogleUser {
	sub: string;
	email: string;
	email_verified: boolean;
	name?: string;
	/** Google Workspace domain. Absent for personal @gmail.com accounts. */
	hd?: string;
}

/**
 * The `hd` parameter on the sign-in URL only preselects accounts and can be
 * stripped by anyone, so the domain is enforced here, on Google's answer.
 */
export function isAllowedUser(user: GoogleUser, domain: string): boolean {
	const d = domain.toLowerCase();
	return user.email_verified === true && user.hd?.toLowerCase() === d && user.email.toLowerCase().endsWith(`@${d}`);
}

export function googleAuthorizeUrl(options: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	hostedDomain: string;
}): string {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", options.clientId);
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "openid email profile");
	url.searchParams.set("state", options.state);
	url.searchParams.set("code_challenge", options.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("hd", options.hostedDomain);
	url.searchParams.set("prompt", "select_account");
	return url.href;
}

/** Exchanges the authorization code and returns the signed-in user. */
export async function fetchGoogleUser(options: {
	clientId: string;
	clientSecret: string;
	code: string;
	codeVerifier: string;
	redirectUri: string;
}): Promise<GoogleUser> {
	const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: options.clientId,
			client_secret: options.clientSecret,
			code: options.code,
			code_verifier: options.codeVerifier,
			grant_type: "authorization_code",
			redirect_uri: options.redirectUri,
		}),
	});
	if (!tokenResponse.ok) {
		throw new Error(`Google token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
	}
	const { access_token } = await tokenResponse.json<{ access_token: string }>();

	const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
		headers: { Authorization: `Bearer ${access_token}` },
	});
	if (!userResponse.ok) {
		throw new Error(`Google userinfo failed: ${userResponse.status} ${await userResponse.text()}`);
	}
	return userResponse.json<GoogleUser>();
}
