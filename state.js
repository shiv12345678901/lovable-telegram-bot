/**
 * State Management for Telegram Lovable Bot
 * Holds in-memory session contexts (browsers, pages, selected projects) per user/chat.
 */

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupIntervalId = null;
  }

  /**
   * Retrieves or initializes a session for a specific chat ID, updating the access time.
   * @param {number|string} chatId 
   * @returns {object} The session object
   */
  getSession(chatId) {
    const id = String(chatId);
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        activeProject: null,        // { name, url }
        projects: [],               // Array of { name, url } scraped from Lovable
        browser: null,              // Playwright Browser instance
        context: null,              // Playwright BrowserContext instance
        page: null,                 // Playwright Page instance
        lastStatusMessageId: null,  // Telegram status message ID for editing
        isProcessing: false,        // Boolean lock when submitting/observing prompts
        lastAccessTime: Date.now(), // Track last activity timestamp
        activeQuestionOptions: null, // Current interactive question choices
        lastScanData: null,         // Cached DOM scan result from observer
        lastMessageHash: '',        // Hash of last sent Telegram status message
        lastEditTime: 0,            // #18: Timestamp of last Telegram edit (throttle)
        promptQueue: [],            // #14: Queued prompts waiting for current build
      });
    }
    
    const session = this.sessions.get(id);
    session.lastAccessTime = Date.now();
    return session;
  }

  /**
   * Cleans up and closes all browser instances for a user session.
   * @param {number|string} chatId 
   */
  async closeSession(chatId) {
    const id = String(chatId);
    const session = this.sessions.get(id);
    if (session) {
      console.log(`[Session] Closing browser for chat ${id}`);
      if (session.browser) {
        try {
          await session.browser.close();
        } catch (error) {
          console.error(`[Session Error] Browser close failed for ${id}:`, error.message);
        }
      }
      this.sessions.delete(id);
    }
  }

  /**
   * Cleans up all active sessions (e.g. on application exit).
   */
  async closeAll() {
    console.log('[Session] Shutting down all browser sessions...');
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    const closePromises = Array.from(this.sessions.keys()).map(chatId => 
      this.closeSession(chatId)
    );
    await Promise.all(closePromises);
  }

  /**
   * Starts a background daemon to clean up inactive sessions.
   * @param {number} timeoutMs - Duration of inactivity before closing session (default 30 mins)
   */
  startIdleCleanup(timeoutMs = 30 * 60 * 1000) {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }

    console.log(`ℹ️ [Session] Idle cleanup daemon started (${timeoutMs / 60000} min timeout)`);
    
    this.cleanupIntervalId = setInterval(async () => {
      const now = Date.now();
      for (const [chatId, session] of this.sessions.entries()) {
        const isIdle = now - session.lastAccessTime > timeoutMs;
        if (isIdle && !session.isProcessing) {
          console.log(`[Session] Chat ${chatId} idle too long, releasing resources`);
          await this.closeSession(chatId);
        }
      }
    }, 60000);
  }
}

export const sessionManager = new SessionManager();
export default sessionManager;
