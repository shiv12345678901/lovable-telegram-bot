import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import sessionManager from './state.js';
import { 
  scrapeProjects, 
  openProjectWorkspace, 
  submitPrompt, 
  observeBuild, 
  clickOptionButton,
  takeBrowserScreenshot
} from './browser.js';

/**
 * HTML escape utility. Prevents all parse_mode: 'HTML' crashes.
 */
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * #4: Safe URL getter — returns URL string or 'N/A' if page is closed/crashed.
 */
function safeUrl(session) {
  try {
    if (session.page && !session.page.isClosed()) return session.page.url();
  } catch {}
  return 'N/A';
}

/**
 * Initializes and configures all Telegraf handlers.
 * @param {string} token - The Telegram Bot Token
 * @param {number[]} allowedUsers - Array of authorized Telegram user IDs
 * @returns {Telegraf} The configured bot instance
 */
export function setupBot(token, allowedUsers = []) {
  const bot = new Telegraf(token);

  // Global error handler
  bot.catch((err, ctx) => {
    console.error(`[Telegraf Error] Update ${ctx?.update?.update_id}:`, err.message);
  });

  // Native slash command menu
  bot.telegram.setMyCommands([
    { command: 'start', description: 'Open projects list' },
    { command: 'screenshot', description: 'Capture browser screen' },
    { command: 'status', description: 'Check bot status' },
    { command: 'cancel', description: 'Cancel running prompt' },
    { command: 'stop', description: 'Stop browser & free memory' },
    { command: 'help', description: 'View manual' }
  ]).catch(err => console.warn('[Bot] Command menu registration failed:', err.message));

  // Persistent bottom keyboard — clean 5-button layout
  const persistentMenu = Markup.keyboard([
    ['Projects', 'Screenshot'],
    ['Status', 'Cancel', 'Stop']
  ]).resize();

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
      console.warn(`[Auth] Blocked user ${userId}`);
      return ctx.reply(`⚠️ Access Denied: User ID ${userId} is not authorized.`);
    }
    return next();
  });

  // ─── Handler Functions ────────────────────────────────────────

  async function sendHomeMenu(ctx) {
    const chatId = ctx.chat.id;
    const session = sessionManager.getSession(chatId);

    const loadingMsg = await ctx.reply(
      '🔄 <b>Connecting to Lovable.dev...</b>\nFetching your projects. Please wait...',
      { parse_mode: 'HTML', ...persistentMenu }
    );

    try {
      const projects = await scrapeProjects(session);
      try { await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id); } catch {}

      if (projects.length === 0) {
        return ctx.reply(
          '⚠️ <b>No Active Projects Found</b>\n\nYour Lovable account has no visible projects.',
          { parse_mode: 'HTML', ...persistentMenu }
        );
      }

      const buttons = projects.map((proj, i) => [
        Markup.button.callback(proj.name.slice(0, 60), `select_project:${i}`)
      ]);

      await ctx.reply(
        '🏠 <b>Lovable Projects Dashboard</b>\n\nSelect a project to activate:',
        { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
      );
    } catch (err) {
      console.error('[Bot] Scrape failed:', err);
      try { await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id); } catch {}
      await ctx.reply(
        `❌ <b>Dashboard Error</b>\n\n<code>${esc(err.message)}</code>\n\nCheck your LOVABLE_SESSION_COOKIE.`,
        { parse_mode: 'HTML', ...persistentMenu }
      );
    }
  }

  async function closeActiveSession(ctx) {
    const chatId = ctx.chat.id;
    await sessionManager.closeSession(chatId);
    await ctx.reply('🛑 <b>Browser Offline</b>\nChromium terminated. Memory freed.', {
      parse_mode: 'HTML', ...persistentMenu
    });
  }

  async function handleViewScreen(ctx) {
    const chatId = ctx.chat.id;
    const session = sessionManager.getSession(chatId);

    if (!session.page) {
      return ctx.reply('⚠️ <b>No active page</b>\nSelect a project first.', {
        parse_mode: 'HTML', ...persistentMenu
      });
    }

    const loadingMsg = await ctx.reply('📸 <b>Capturing viewport...</b>', { parse_mode: 'HTML' });

    try {
      const photoPath = await takeBrowserScreenshot(session);
      try { await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id); } catch {}
      await ctx.replyWithPhoto(
        { source: photoPath },
        { caption: `📸 <b>Live Screen</b>\n🌐 ${esc(safeUrl(session))}`, parse_mode: 'HTML' }
      );
      // #12 partial: Safe file cleanup
      try { fs.unlinkSync(photoPath); } catch {}
    } catch (err) {
      console.error('[Bot] Screenshot failed:', err);
      try { await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id); } catch {}
      await ctx.reply(`❌ <b>Screenshot failed:</b> <code>${esc(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  }

  async function handleStatus(ctx) {
    const chatId = ctx.chat.id;
    const session = sessionManager.getSession(chatId);

    // #4: Use safeUrl() instead of raw session.page.url()
    const lines = [
      'ℹ️ <b>Bot Status</b>',
      '',
      `• <b>Project:</b> ${session.activeProject ? esc(session.activeProject.name) : '<i>None</i>'}`,
      `• <b>Browser:</b> ${session.browser ? '🟢 Running' : '🔴 Offline'}`,
      `• <b>Page:</b> ${session.page ? '🟢 Connected' : '🔴 Disconnected'}`,
      `• <b>State:</b> ${session.isProcessing ? '⏳ Processing...' : '✅ Idle'}`,
      `• <b>Queue:</b> ${session.promptQueue.length > 0 ? `${session.promptQueue.length} prompt(s) waiting` : 'Empty'}`,
      `• <b>URL:</b> ${esc(safeUrl(session))}`
    ];

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML', disable_web_page_preview: true, ...persistentMenu
    });
  }

  // #15: Cancel command — stops the running observer and unlocks isProcessing
  async function handleCancel(ctx) {
    const chatId = ctx.chat.id;
    const session = sessionManager.getSession(chatId);

    if (!session.isProcessing) {
      return ctx.reply('ℹ️ Nothing is running right now.', { ...persistentMenu });
    }

    session.isProcessing = false;
    session.promptQueue = []; // Clear queue too
    console.log(`[Bot] User cancelled running prompt for chat ${chatId}`);
    await ctx.reply('❌ <b>Cancelled</b>\nPrompt execution stopped. Ready for new input.', {
      parse_mode: 'HTML', ...persistentMenu
    });
  }

  async function handleHelp(ctx) {
    const lines = [
      '📖 <b>Lovable Remote Bot Manual</b>',
      '',
      'This bot controls your Lovable.dev account remotely via Telegram.',
      '',
      '<b>Controls:</b>',
      '• 🏠 <b>Dashboard</b> — Load project list',
      '• 📸 <b>View Screen</b> — Screenshot the browser',
      '• 🔄 <b>Refresh</b> — Re-scan dashboard',
      '• ℹ️ <b>Status</b> — Check connections',
      '• 🛑 <b>Stop Browser</b> — Kill Chromium',
      '• ❌ /cancel — Cancel running prompt',
      '• ❓ <b>Help</b> — This manual',
      '',
      '<b>Sending Prompts:</b>',
      'Once a project is active, just type any message. If a build is running, your prompt is auto-queued and submitted when the current build finishes.'
    ];

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', ...persistentMenu });
  }

  // ─── Core prompt execution function (used by text handler + queue) ────

  async function executePrompt(chatId, session, promptText, ctx) {
    session.isProcessing = true;
    session.lastMessageHash = '';
    session.lastEditTime = 0;

    const statusMsg = await ctx.telegram.sendMessage(chatId,
      `🚀 <b>Submitting prompt to ${esc(session.activeProject.name)}...</b>`,
      { parse_mode: 'HTML' }
    );
    session.lastStatusMessageId = statusMsg.message_id;

    try {
      await submitPrompt(session, promptText);

      // #1 FIX: Don't edit with identical text. Show a different confirmation instead.
      await ctx.telegram.editMessageText(chatId, session.lastStatusMessageId, null,
        `✅ <b>Prompt submitted to ${esc(session.activeProject.name)}</b>\nObserving build progress...`,
        { parse_mode: 'HTML' }
      );

      // Start observer
      observeBuild(
        session,
        // onUpdate
        async (statusText, fileOps, progressText, terminalLogs) => {
          try {
            let msg = `🚀 <b>Working on ${esc(session.activeProject.name)}...</b>\n`;
            if (progressText) msg += `\n📊 <b>Progress:</b> ${esc(progressText)}\n`;
            if (statusText) msg += `\n🔨 <b>Status:</b>\n${esc(statusText)}`;
            if (fileOps && fileOps.length > 0) {
              msg += '\n\n📂 <b>Files:</b>\n' + fileOps.map(f => {
                const icon = f.op === 'create' ? '🆕' : f.op === 'delete' ? '🗑️' : '✏️';
                return `${icon} <code>${esc(f.path)}</code>`;
              }).join('\n');
            }
            if (terminalLogs) {
              msg += `\n\n📋 <b>Terminal:</b>\n<pre>${esc(terminalLogs)}</pre>`;
            }

            // Dedup check
            const hash = msg.length + ':' + msg.slice(-100);
            if (hash === session.lastMessageHash) return;

            // #18: Throttle — minimum 3 seconds between edits
            const now = Date.now();
            if (now - session.lastEditTime < 3000) return;

            session.lastMessageHash = hash;
            session.lastEditTime = now;

            await ctx.telegram.editMessageText(chatId, session.lastStatusMessageId, null, msg, {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_prompt')]])
            });
          } catch (e) {
            if (!e.message.includes('not modified')) {
              console.warn('[Bot] Status edit error:', e.message);
            }
          }
        },
        // onQuestion
        async (questionText, options) => {
          try {
            const buttons = options.map(opt => [
              Markup.button.callback(opt.text, `click_option:${opt.index}`)
            ]);
            await ctx.telegram.editMessageText(chatId, session.lastStatusMessageId, null,
              `❓ <b>Action Required</b>\n\n${esc(questionText)}`,
              { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
            );
          } catch (e) {
            console.error('[Bot] Question render failed:', e.message);
          }
        },
        // onFinished
        async (previewUrl, fullResponse) => {
          try {
            // Send full Lovable response
            if (fullResponse && fullResponse.trim().length > 10) {
              const maxLen = 4000;
              const responseText = fullResponse.trim();
              
              if (responseText.length <= maxLen) {
                await ctx.telegram.sendMessage(chatId,
                  `📝 <b>Lovable Response:</b>\n\n${esc(responseText)}`,
                  { parse_mode: 'HTML' }
                );
              } else {
                const lines = responseText.split('\n');
                let chunk = '';
                let partNum = 1;
                for (const line of lines) {
                  if ((chunk + '\n' + line).length > maxLen) {
                    await ctx.telegram.sendMessage(chatId,
                      `📝 <b>Lovable Response (Part ${partNum}):</b>\n\n${esc(chunk.trim())}`,
                      { parse_mode: 'HTML' }
                    );
                    partNum++;
                    chunk = line;
                  } else {
                    chunk += (chunk ? '\n' : '') + line;
                  }
                }
                if (chunk.trim()) {
                  await ctx.telegram.sendMessage(chatId,
                    `📝 <b>Lovable Response (Part ${partNum}):</b>\n\n${esc(chunk.trim())}`,
                    { parse_mode: 'HTML' }
                  );
                }
              }
            }

            // Completion panel
            const buttons = [];
            if (previewUrl) buttons.push([Markup.button.url('🌐 Open Preview', previewUrl)]);
            buttons.push(
              [Markup.button.callback('🔄 Reload', 'console_reload'), Markup.button.callback('📋 Logs', 'console_logs')],
              [Markup.button.callback('📸 Snapshot', 'console_screenshot'), Markup.button.callback('🏠 Projects', 'go_home')]
            );

            await ctx.telegram.editMessageText(chatId, session.lastStatusMessageId, null,
              `🎉 <b>Build Complete!</b>`,
              { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
            );
          } catch (e) {
            console.error('[Bot] Finish render failed:', e.message);
          } finally {
            session.isProcessing = false;
            // #14: Process next queued prompt
            processQueue(chatId, session, ctx);
          }
        },
        // onTimeout
        async () => {
          try {
            await ctx.telegram.editMessageText(chatId, session.lastStatusMessageId, null,
              `⏱ <b>Observation Timeout</b>\n\nNo completion detected after 5 minutes.\nUse 📸 <b>View Screen</b> to check manually.`,
              {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                  [Markup.button.callback('📸 View Screen', 'console_screenshot'), Markup.button.callback('🏠 Projects', 'go_home')]
                ])
              }
            );
          } catch (e) {
            console.error('[Bot] Timeout render failed:', e.message);
          } finally {
            session.isProcessing = false;
            // #14: Process next queued prompt even after timeout
            processQueue(chatId, session, ctx);
          }
        }
      );

    } catch (err) {
      console.error('[Bot] Prompt submission failed:', err);
      try {
        await ctx.telegram.editMessageText(chatId, session.lastStatusMessageId, null,
          `❌ <b>Failed:</b>\n<code>${esc(err.message)}</code>`,
          { parse_mode: 'HTML' }
        );
      } catch {
        await ctx.telegram.sendMessage(chatId,
          `❌ <b>Failed:</b> <code>${esc(err.message)}</code>`,
          { parse_mode: 'HTML' }
        );
      }
      session.isProcessing = false;
      // #14: Try next in queue even after failure
      processQueue(chatId, session, ctx);
    }
  }

  // #14: Process queued prompts automatically
  async function processQueue(chatId, session, ctx) {
    if (session.promptQueue.length === 0) return;
    if (session.isProcessing) return;

    const nextPrompt = session.promptQueue.shift();
    console.log(`[Bot] Auto-submitting queued prompt (${session.promptQueue.length} remaining)`);
    await executePrompt(chatId, session, nextPrompt, ctx);
  }

  // ─── Slash Commands ───────────────────────────────────────────

  bot.command('start', sendHomeMenu);
  bot.command('home', sendHomeMenu);
  bot.command('screenshot', handleViewScreen);
  bot.command('status', handleStatus);
  bot.command('stop', closeActiveSession);
  bot.command('cancel', handleCancel);
  bot.command('help', handleHelp);

  // Keyboard button patterns (substring matches to support emojis)
  bot.hears(/projects/i, sendHomeMenu);
  bot.hears(/screenshot/i, handleViewScreen);
  bot.hears(/status/i, handleStatus);
  bot.hears(/cancel/i, handleCancel);
  bot.hears(/stop/i, closeActiveSession);

  // ─── Callback Query Handlers ──────────────────────────────────

  // Project selection
  bot.action(/^select_project:(\d+)$/, async (ctx) => {
    const index = parseInt(ctx.match[1], 10);
    const chatId = ctx.chat.id;
    const session = sessionManager.getSession(chatId);

    const proj = session.projects[index];
    if (!proj) return ctx.answerCbQuery('⚠️ Project not found.', { show_alert: true });

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🔄 <b>Activating...</b>\nLoading ${esc(proj.name)}...`,
      { parse_mode: 'HTML' }
    );

    try {
      session.activeProject = proj;
      await openProjectWorkspace(session, proj.url);
      await ctx.editMessageText(
        `✅ <b>Active: ${esc(proj.name)}</b>\n\nSend any text message to deploy it as a prompt.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[Bot] Workspace open failed:', err);
      await ctx.editMessageText(
        `❌ <b>Failed:</b> <code>${esc(err.message)}</code>`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // Interactive option click
  bot.action(/^click_option:(\d+)$/, async (ctx) => {
    const index = parseInt(ctx.match[1], 10);
    const chatId = ctx.chat.id;
    const session = sessionManager.getSession(chatId);

    if (!session.activeQuestionOptions) {
      return ctx.answerCbQuery('⚠️ Options expired.', { show_alert: true });
    }

    const opt = session.activeQuestionOptions.find(o => o.index === index);
    if (!opt) return ctx.answerCbQuery('⚠️ Option not found.', { show_alert: true });

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `⏳ <b>Selected:</b> ${esc(opt.text)}\nResuming Lovable...`,
      { parse_mode: 'HTML' }
    );

    try {
      await clickOptionButton(session, opt.text);
    } catch (err) {
      console.error('[Bot] Option click failed:', err);
      await ctx.telegram.sendMessage(chatId,
        `❌ <b>Click failed:</b> <code>${esc(err.message)}</code>`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // #15: Inline cancel button handler
  bot.action('cancel_prompt', async (ctx) => {
    const chatId = ctx.chat.id;
    const session = sessionManager.getSession(chatId);

    session.isProcessing = false;
    session.promptQueue = [];
    await ctx.answerCbQuery('❌ Cancelled');
    try {
      await ctx.editMessageText(
        '❌ <b>Cancelled by user.</b>\nReady for new input.',
        { parse_mode: 'HTML' }
      );
    } catch {}
  });

  // Console: Force Reload
  bot.action('console_reload', async (ctx) => {
    const session = sessionManager.getSession(ctx.chat.id);
    if (!session.page) return ctx.answerCbQuery('⚠️ No active page.', { show_alert: true });

    await ctx.answerCbQuery('🔄 Reloading...');
    try {
      await session.page.reload({ waitUntil: 'load', timeout: 30000 });
      await ctx.reply('✅ <b>Page reloaded.</b>', { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ <b>Reload failed:</b> <code>${esc(err.message)}</code>`, { parse_mode: 'HTML' });
    }
  });

  // Console Logs — reads from cached session data
  bot.action('console_logs', async (ctx) => {
    const session = sessionManager.getSession(ctx.chat.id);
    await ctx.answerCbQuery('📋 Fetching...');

    const scan = session.lastScanData;
    if (!scan) {
      return ctx.reply('📋 <b>No cached logs available.</b>\nSubmit a prompt first.', { parse_mode: 'HTML' });
    }

    const parts = [];
    if (scan.statusText) parts.push(`<b>Status:</b>\n${esc(scan.statusText)}`);
    if (scan.terminalLogs) parts.push(`<b>Terminal:</b>\n<pre>${esc(scan.terminalLogs)}</pre>`);
    if (scan.fileOps && scan.fileOps.length > 0) {
      parts.push('<b>Files:</b>\n' + scan.fileOps.map(f => {
        const icon = f.op === 'create' ? '🆕' : f.op === 'delete' ? '🗑️' : '✏️';
        return `${icon} <code>${esc(f.path)}</code>`;
      }).join('\n'));
    }

    const text = parts.length > 0 ? `📋 <b>Cached Logs</b>\n\n${parts.join('\n\n')}` : '📋 No activity detected.';
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // Console: Screenshot shortcut
  bot.action('console_screenshot', async (ctx) => {
    await ctx.answerCbQuery('📸 Capturing...');
    await handleViewScreen(ctx);
  });

  // Home redirect
  bot.action('go_home', async (ctx) => {
    await ctx.answerCbQuery();
    await sendHomeMenu(ctx);
  });

  // ─── Prompt Text Handler ──────────────────────────────────────

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const session = sessionManager.getSession(chatId);
    
    // Trim input to remove any leading/trailing spaces
    const promptText = (ctx.message.text || '').trim();

    console.log(`[Bot] Received text update from user ${ctx.from?.id}: "${promptText}"`);

    // Strict guard: ignore any keyboard buttons or standard slash commands completely
    const isMenuButtonOrCommand = /(projects|screenshot|status|cancel|stop|help)/i.test(promptText) || promptText.startsWith('/');
    if (isMenuButtonOrCommand) {
      console.log(`[Bot] Blocked menu text "${promptText}" from falling through as a prompt.`);
      return;
    }

    if (!session.activeProject) {
      return ctx.reply('⚠️ <b>No Project Active</b>\nUse /start to select one.', { parse_mode: 'HTML' });
    }

    // #14: If busy, queue the prompt instead of rejecting
    if (session.isProcessing) {
      session.promptQueue.push(promptText);
      const pos = session.promptQueue.length;
      return ctx.reply(
        `📥 <b>Queued</b> (Position: ${pos})\nYour prompt will auto-submit when the current build finishes.\n\n<i>Use /cancel to clear the queue.</i>`,
        { parse_mode: 'HTML' }
      );
    }

    await executePrompt(chatId, session, promptText, ctx);
  });

  return bot;
}
