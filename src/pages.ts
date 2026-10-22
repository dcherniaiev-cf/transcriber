import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --text: #1c1c1a; --muted: #6b6b66; --accent: #1f5eff; --border: #e3e3de; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #20201e; --text: #ededea; --muted: #a3a39d; --accent: #7a9cff; --border: #34342f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 520px; margin: 8vh auto; padding: 0 16px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
h1 { font-size: 1.3rem; margin: 0 0 12px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: .92rem; }
.warn { border-left: 3px solid #d98a00; padding-left: 12px; }
code { font: .9rem ui-monospace, Consolas, monospace; word-break: break-all; }
.error { color: #c62828; }
label { display: block; margin: 14px 0 0; font-size: .92rem; color: var(--muted); }
input { display: block; width: 100%; margin-top: 4px; font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
.actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 20px; }
button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
`;

function layout(title: string, body: string): string {
	return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main><div class="card">${body}</div></main></body>
</html>`;
}

/** How the person proves who they are after approving: Google, or the temporary shared password. */
export type LoginStep = { mode: "google"; domain: string } | { mode: "password"; error?: string };

export function consentPage(details: ConsentDescription, handle: string, login: LoginStep): string {
	const client = escapeHtml(details.clientName);
	const intro =
		login.mode === "google"
			? `<p>Далі буде вхід через Google. Пускаємо лише робочі акаунти <strong>@${escapeHtml(login.domain)}</strong>.</p>`
			: `<p>Увійдіть логіном і паролем Транскрайбера.</p>${
					login.error ? `<p class="error">${escapeHtml(login.error)}</p>` : ""
				}`;
	const fields =
		login.mode === "password"
			? `<label>Логін<input name="username" autocomplete="username" required></label>
<label>Пароль<input type="password" name="password" autocomplete="current-password" required></label>`
			: "";
	return layout(
		"Транскрайбер КС — дозвіл",
		`<h1>Дозволити «${client}» користуватися Транскрайбером КС?</h1>
${intro}
<p class="muted">Доступ отримає: <code>${escapeHtml(details.redirectHost)}</code>${
			details.clientDomain ? ` (видавець: ${escapeHtml(details.clientDomain)})` : ". Назву застосунок вказав сам"
		}.</p>
${
	details.redirectIsLoopback
		? `<p class="warn">Доступ піде застосунку на вашому комп'ютері (наприклад, Claude Code). Продовжуйте, лише якщо ви щойно самі почали підключення.</p>`
		: ""
}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
${fields}
<div class="actions">
<button name="decision" value="deny" formnovalidate>Відмовити</button>
<button class="primary" name="decision" value="approve">Дозволити</button>
</div>
</form>`,
	);
}

export function messagePage(title: string, message: string): string {
	return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function homePage(origin: string): string {
	return layout(
		"Транскрайбер КС",
		`<h1>Транскрайбер КС</h1>
<p>MCP-конектор для транскрибації аудіо через Whisper large-v3 на NEAR AI. Доступ лише для акаунтів «Культурних Сил».</p>
<p class="muted">Адреса для підключення в Claude:</p>
<p><code>${escapeHtml(origin)}/mcp</code></p>`,
	);
}
