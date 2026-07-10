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

## Setup

### 1. Create the Space

- Go to [huggingface.co/new-space](https://huggingface.co/new-space)
- Choose **Docker** as the SDK
- Set visibility to **Private** (recommended)

### 2. Add Secrets

In your Space's **Settings → Secrets**, add these variables:

| Secret Name | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Get from [@BotFather](https://t.me/BotFather) |
| `LOVABLE_SESSION_COOKIE` | ✅ | Your `lovable-session-id-v2` cookie value |
| `ALLOWED_USER_IDS` | Recommended | Your Telegram user ID (comma-separated for multiple) |
| `WEBHOOK_URL` | Optional | Your Space URL (e.g. `https://username-spacename.hf.space`) for webhook mode |

### 3. Push Code

```bash
git remote add hf https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME
git push hf main
```

### 4. Verify

- Check the Space's **Logs** tab for startup diagnostics
- Send `/start` to your bot in Telegram
- The health endpoint is available at `https://your-space.hf.space/health`

## Features

- 🏠 Browse and select Lovable projects
- 🚀 Submit prompts and observe live build progress
- 📸 Capture browser screenshots
- ❓ Answer Lovable's interactive questions
- 📝 Full response extraction with formatting
- 📥 Prompt queue (auto-submits when current build finishes)
- ❌ Cancel running builds
- 🔄 Auto keep-alive pinger (prevents HF sleep)
- 🧹 Idle session cleanup (30-min timeout)
