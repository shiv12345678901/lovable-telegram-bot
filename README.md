---
title: Lovable Telegram Bot
emoji: 🤖
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Lovable Telegram Bot

Remote Telegram dashboard and prompt controller for [Lovable.dev](https://lovable.dev).

## Hugging Face Spaces (recommended)

### 1. Create Space

- [huggingface.co/new-space](https://huggingface.co/new-space)
- **SDK: Docker**
- Visibility: **Private** (you inject Lovable session cookies)

### 2. Push the correct root

HF looks for **`Dockerfile` + `README.md` at the Space repo root**.

**Option A — monorepo (this workspace)**  
Push the **parent** repo that already has root `Dockerfile` + root `README.md` (they copy from `lovable-telegram-bot/`).

```bash
# from monorepo root
git remote add hf https://huggingface.co/spaces/YOUR_USER/YOUR_SPACE
git push hf main
```

**Option B — bot folder only**  
Space root = contents of `lovable-telegram-bot/` (this README + this Dockerfile).

```bash
cd lovable-telegram-bot
git init
git remote add hf https://huggingface.co/spaces/YOUR_USER/YOUR_SPACE
git add .
git commit -m "Deploy bot"
git push hf main --force
```

### 3. Secrets (Settings → Secrets)

| Secret | Required | Description |
|--------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | From [@BotFather](https://t.me/BotFather) |
| `LOVABLE_SESSION_COOKIE` | ✅ | Browser cookie `lovable-session-id-v2` on lovable.dev |
| `ALLOWED_USER_IDS` | Recommended | Your Telegram user id (from @userinfobot) |
| `WEBHOOK_URL` | Optional | `https://YOUR_USER-YOUR_SPACE.hf.space` |

After saving secrets: **Settings → Factory reboot**.

### 4. Hardware

This bot runs **headed Chromium + Xvfb + extension**. Free/CPU Basic often fails or stuck on “Starting”. Use **CPU Basic+** or higher if needed.

### 5. Verify

| Check | Expected |
|-------|----------|
| Logs | `Listening on 0.0.0.0:7860` |
| `/health` | JSON `status: healthy` |
| Telegram | `/start` on your bot |

If token is missing, Space still serves `/` status page and `/health` (degraded) so you can debug.

## Features

- Browse and select Lovable projects  
- Submit prompts + live build progress  
- Screenshots, interactive questions, prompt queue  
- Cancel builds, idle session cleanup  
- Optional webhook + keep-alive  

## Local run

```bash
cp .env.example .env   # fill secrets
npm install
npm start
```

Open http://localhost:7860
