import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { SupportIssue, SupportChatSession, SupportChatMessage, SupportMetadata, SupportState } from './types.js';

const DEFAULT_ISSUES_FILE = 'support-issues.json';
const DEFAULT_CHATS_FILE = 'support-chats.json';
const MAX_ISSUES = 200;
const MAX_CHAT_SESSIONS = 100;

/**
 * Manages support issue reports and chat sessions.
 * Both are persisted to separate JSON files.
 */
export class SupportStore {
  private issues = new Map<string, SupportIssue>();
  private chatSessions = new Map<string, SupportChatSession>();
  private issuesFilePath: string;
  private chatsFilePath: string;
  private listeners: ((state: SupportState) => void)[] = [];

  constructor(issuesFilePath?: string, chatsFilePath?: string) {
    this.issuesFilePath = issuesFilePath ?? process.env.SUPPORT_ISSUES_FILE ?? DEFAULT_ISSUES_FILE;
    this.chatsFilePath = chatsFilePath ?? process.env.SUPPORT_CHATS_FILE ?? DEFAULT_CHATS_FILE;
    this.loadIssues();
    this.loadChats();
  }

  // ── Issues ──────────────────────────────────────────────────────────

  createIssue(
    tryingToDo: string,
    stepsPerformed: string,
    expected: string,
    actual: string,
    metadata: SupportMetadata,
    screenshotDataUrl?: string,
    recentLogs: string[] = [],
  ): SupportIssue {
    const id = `issue-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const issue: SupportIssue = {
      id,
      createdAt: Date.now(),
      tryingToDo,
      stepsPerformed,
      expected,
      actual,
      metadata,
      screenshotDataUrl,
      recentLogs,
      status: 'open',
    };

    this.issues.set(id, issue);
    this.pruneIssues();
    this.persistIssues();
    this.notifyListeners();
    return issue;
  }

  getIssue(id: string): SupportIssue | undefined {
    return this.issues.get(id);
  }

  getAllIssues(): SupportIssue[] {
    return [...this.issues.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Link an issue to a chat session. */
  linkIssueToChat(issueId: string, chatSessionId: string): void {
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.chatSessionId = chatSessionId;
      issue.status = 'in-chat';
      this.persistIssues();
      this.notifyListeners();
    }
  }

  /** Update the Slack thread reference on an issue. */
  setIssueSlackThread(issueId: string, threadTs: string): void {
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.slackThreadTs = threadTs;
      this.persistIssues();
    }
  }

  // ── Chat Sessions ───────────────────────────────────────────────────

  createChatSession(issueId?: string, senderName?: string): SupportChatSession {
    const id = `chat-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const session: SupportChatSession = {
      id,
      createdAt: Date.now(),
      issueId,
      senderName,
      messages: [],
      active: true,
    };

    this.chatSessions.set(id, session);
    this.pruneChats();
    this.persistChats();

    // If started from an issue, link them
    if (issueId) {
      this.linkIssueToChat(issueId, id);
    }

    this.notifyListeners();
    return session;
  }

  getChatSession(id: string): SupportChatSession | undefined {
    return this.chatSessions.get(id);
  }

  /** Find a chat session by its Slack thread timestamp. */
  getChatSessionBySlackThread(threadTs: string): SupportChatSession | undefined {
    for (const session of this.chatSessions.values()) {
      if (session.slackThreadTs === threadTs) return session;
    }
    return undefined;
  }

  addChatMessage(
    sessionId: string,
    sender: 'user' | 'admin',
    senderName: string,
    text: string,
    screenshotDataUrl?: string,
  ): SupportChatMessage | null {
    const session = this.chatSessions.get(sessionId);
    if (!session || !session.active) return null;

    const message: SupportChatMessage = {
      id: `msg-${Date.now()}-${randomBytes(4).toString('hex')}`,
      sessionId,
      sender,
      senderName,
      text,
      screenshotDataUrl,
      timestamp: Date.now(),
    };

    session.messages.push(message);
    this.persistChats();
    this.notifyListeners();
    return message;
  }

  setSlackThreadTs(sessionId: string, threadTs: string): void {
    const session = this.chatSessions.get(sessionId);
    if (session) {
      session.slackThreadTs = threadTs;
      this.persistChats();
    }
  }

  endChatSession(sessionId: string): boolean {
    const session = this.chatSessions.get(sessionId);
    if (!session) return false;
    session.active = false;
    this.persistChats();
    this.notifyListeners();
    return true;
  }

  /**
   * Create an issue from a chat session's conversation.
   * Summarizes the chat history into the issue fields.
   */
  createIssueFromChat(sessionId: string, tryingToDo: string, actual: string): SupportIssue | null {
    const session = this.chatSessions.get(sessionId);
    if (!session) return null;

    // Summarize chat messages as the "steps performed"
    const chatSummary = session.messages
      .map(m => `[${m.sender === 'user' ? 'User' : 'Admin'} ${m.senderName}]: ${m.text}`)
      .join('\n');

    const issue = this.createIssue(
      tryingToDo,
      `(Created from chat session)\n\n${chatSummary}`,
      '', // Expected behavior not known from chat
      actual,
      {
        userAgent: 'Chat session',
        pageUrl: '/support',
        timestamp: Date.now(),
      },
      undefined,
      [],
    );

    issue.chatSessionId = sessionId;
    session.issueId = issue.id;
    this.persistIssues();
    this.persistChats();
    this.notifyListeners();
    return issue;
  }

  getActiveSessions(): SupportChatSession[] {
    return [...this.chatSessions.values()].filter(s => s.active);
  }

  // ── State & Listeners ───────────────────────────────────────────────

  getState(): SupportState {
    return {
      type: 'supportState',
      issues: this.getAllIssues(),
      activeSessions: this.getActiveSessions(),
    };
  }

  addListener(fn: (state: SupportState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('Error in SupportStore listener:', err);
      }
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private loadIssues(): void {
    try {
      if (!existsSync(this.issuesFilePath)) return;
      const raw = readFileSync(this.issuesFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const issue of parsed) {
          if (typeof issue?.id === 'string') {
            this.issues.set(issue.id, issue as SupportIssue);
          }
        }
        console.log(`Loaded ${this.issues.size} support issue(s) from ${this.issuesFilePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load support issues from ${this.issuesFilePath}:`, (err as Error).message);
    }
  }

  private loadChats(): void {
    try {
      if (!existsSync(this.chatsFilePath)) return;
      const raw = readFileSync(this.chatsFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const session of parsed) {
          if (typeof session?.id === 'string') {
            this.chatSessions.set(session.id, session as SupportChatSession);
          }
        }
        console.log(`Loaded ${this.chatSessions.size} chat session(s) from ${this.chatsFilePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load chat sessions from ${this.chatsFilePath}:`, (err as Error).message);
    }
  }

  private persistIssues(): void {
    try {
      // Persist issues without screenshots to keep file size manageable
      const issues = [...this.issues.values()].map(i => ({ ...i, screenshotDataUrl: undefined }));
      writeFileSync(this.issuesFilePath, JSON.stringify(issues, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save support issues to ${this.issuesFilePath}:`, (err as Error).message);
    }
  }

  private persistChats(): void {
    try {
      // Persist chats without screenshots to keep file size manageable
      const sessions = [...this.chatSessions.values()].map(s => ({
        ...s,
        messages: s.messages.map(m => ({ ...m, screenshotDataUrl: undefined })),
      }));
      writeFileSync(this.chatsFilePath, JSON.stringify(sessions, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save chat sessions to ${this.chatsFilePath}:`, (err as Error).message);
    }
  }

  private pruneIssues(): void {
    if (this.issues.size <= MAX_ISSUES) return;
    const sorted = [...this.issues.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (sorted.length > MAX_ISSUES) {
      const oldest = sorted.shift()!;
      this.issues.delete(oldest[0]);
    }
  }

  private pruneChats(): void {
    if (this.chatSessions.size <= MAX_CHAT_SESSIONS) return;
    // Remove oldest inactive sessions first
    const inactive = [...this.chatSessions.entries()]
      .filter(([, s]) => !s.active)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (this.chatSessions.size > MAX_CHAT_SESSIONS && inactive.length > 0) {
      const oldest = inactive.shift()!;
      this.chatSessions.delete(oldest[0]);
    }
  }
}
