# Транскрайбер КС

MCP-конектор для Claude, який перетворює аудіо на текст через Whisper large-v3 на [NEAR AI](https://near.ai/models/openai/whisper-large-v3). Працює як Cloudflare Worker. Підключитися може лише робочий Google-акаунт **@culturalforces.org**.

## Як це працює

1. Людина просить Claude: «Транскрибуй `~/Downloads/нарада.mp3` у субтитри».
2. Claude викликає інструмент `create_upload_link` і отримує одноразове посилання (діє 15 хвилин).
3. Claude сам завантажує файл цим посиланням через `curl`. Файл іде напряму на сервер, повз розмову.
4. Сервер передає аудіо в NEAR AI, і у відповідь приходить готовий текст.

Ключ NEAR AI лежить лише в секретах Worker'а. Аудіо ніде не зберігається. У логах записується, хто і скільки секунд транскрибував, але не сам текст.

Другий інструмент, `transcribe_audio`, приймає аудіо прямо у виклику (base64). Він для майбутнього артефакту і коротких фрагментів.

## Що вміє

| | |
|---|---|
| Формати | mp3, wav, ogg (opus/vorbis), flac — до 25 МБ |
| Результат | `text`, `timestamped` (`[00:01:23]` на кожну фразу), `srt`, `vtt`, `json` (з таймкодами фраз) |
| Мова | визначається автоматично, або можна задати (`uk`, `en`, …) |
| Чого немає | таймкодів по словах (NEAR їх не повертає), розпізнавання спікерів |

**m4a, aac, webm і відео** NEAR не приймає, хоча в документації вони заявлені (перевірено 22.10.2026). Конектор сам підкаже конвертувати файл. Конвертація ще й стискає запис, і в 25 МБ вміщається близько двох годин:

```bash
ffmpeg -i "запис.m4a" -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k "запис.ogg"
```

## Розгортання (один раз)

Потрібні: акаунт Cloudflare (вистачить безкоштовного плану), доступ до Google Cloud Console в організації culturalforces.org і ключ NEAR AI.

**1. Перше розгортання — щоб отримати адресу.**

```bash
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

Вставте виданий `id` у `wrangler.jsonc` → `kv_namespaces`. Потім:

```bash
npm run deploy
```

Wrangler покаже адресу на кшталт `https://ks-transcriber.<subdomain>.workers.dev`. Впишіть її в `wrangler.jsonc` → `vars.PUBLIC_ORIGIN`.

**2. Google OAuth-клієнт.** У [Google Cloud Console](https://console.cloud.google.com/) в організації culturalforces.org:

- *APIs & Services → OAuth consent screen*: User type **Internal**. Тоді Google сам не пустить сторонні акаунти; сервер це перевіряє ще раз.
- *Credentials → Create credentials → OAuth client ID*: тип **Web application**, Authorized redirect URI: `https://ks-transcriber.<subdomain>.workers.dev/callback`.

**3. Секрети.** Кожна команда попросить ввести значення:

```bash
npx wrangler secret put NEAR_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SIGNING_SECRET
```

Для `SIGNING_SECRET` підійде будь-який випадковий рядок від 32 символів, наприклад з:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**4. Друге розгортання**, вже з адресою:

```bash
npm run deploy
```

## Підключення

**Claude Code:**

```bash
claude mcp add --transport http ks-transcriber https://ks-transcriber.d-cherniaiev-5a7.workers.dev/mcp
```

Далі в Claude Code: `/mcp` → `ks-transcriber` → Authenticate. Відкриється браузер: «Дозволити» → вхід через Google робочим акаунтом.

**claude.ai і Claude Desktop:** *Settings → Connectors → Add custom connector*, адреса та сама, з `/mcp`. Адмін організації може додати конектор одразу для всіх у налаштуваннях організації.

## Розробка

```bash
cp .dev.vars.example .dev.vars   # і заповнити; PUBLIC_ORIGIN=http://localhost:8788
npm test                          # юніт-тести і тести MCP-інструментів
npm run dev                       # локальний сервер на :8788
E2E_ORIGIN=http://localhost:8788 npx vitest run test/e2e.test.ts
```

Живі запити до NEAR у тестах виконуються, лише якщо в `.dev.vars` є справжній ключ і зразки в `test-audio/` (обидва в `.gitignore`). Зразки робляться так: `ffmpeg -i будь-що.wav -ac 1 -ar 16000 -b:a 32k test-audio/low.mp3` і `ffmpeg -i будь-що.wav -ac 1 test-audio/test-en.m4a`.

Після змін у `wrangler.jsonc` або `.dev.vars` оновіть типи: `npx wrangler types`.

## Будова

| Файл | Що робить |
|---|---|
| `src/index.ts` | OAuth-провайдер: видає токени клієнтам MCP, захищає `/mcp` |
| `src/app.ts` | Вхід через Google з перевіркою домену, сторінка дозволу, прийом завантажень |
| `src/mcp.ts` | Інструменти `create_upload_link` і `transcribe_audio` |
| `src/near.ts` | Запит до NEAR AI |
| `src/uploads.ts` | Підписані одноразові посилання на завантаження |
| `src/audio.ts`, `src/pipeline.ts` | Перевірка формату й розміру до запиту в NEAR |
| `src/format.ts` | Текст, таймкоди, SRT, VTT, JSON |
