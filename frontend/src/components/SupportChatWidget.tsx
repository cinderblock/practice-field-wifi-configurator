import { useState, useEffect, useRef, useCallback, createContext, useContext, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Badge from '@mui/material/Badge';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import SendIcon from '@mui/icons-material/Send';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import BugReportIcon from '@mui/icons-material/BugReport';
import ChatIcon from '@mui/icons-material/Chat';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import MinimizeIcon from '@mui/icons-material/Minimize';
import CloseIcon from '@mui/icons-material/Close';
import html2canvas from 'html2canvas';

import type { SupportChatMessage, SupportIssue, AppLogMessage } from '../../../src/types';
import {
  useSupportState,
  useSupportChatMessages,
  useAppLogCallback,
  useSlackConfigState,
  sendSubmitSupportIssue,
  sendStartSupportChat,
  sendSupportChatMessage,
  sendEndSupportChat,
  sendCreateIssueFromChat,
} from '../hooks/useBackend';

// ── Widget Context ─────────────────────────────────────────────────

interface SupportWidgetContextValue {
  openWidget: (view?: 'chat' | 'report') => void;
  closeWidget: () => void;
  isOpen: boolean;
  unreadCount: number;
}

const SupportWidgetContext = createContext<SupportWidgetContextValue>({
  openWidget: () => {},
  closeWidget: () => {},
  isOpen: false,
  unreadCount: 0,
});

export function useSupportWidget() {
  return useContext(SupportWidgetContext);
}

// ── Screenshot Utility ─────────────────────────────────────────────

let widgetElement: HTMLElement | null = null;
/** Screenshot taken when the widget was opened (before it was visible). */
let preOpenScreenshot: string | undefined;

async function captureScreenshot(): Promise<string | undefined> {
  try {
    // Hide the widget so the screenshot captures the actual page
    if (widgetElement) widgetElement.style.display = 'none';
    const canvas = await html2canvas(document.body, {
      backgroundColor: '#121212',
      scale: 0.5,
      logging: false,
      useCORS: true,
      allowTaint: true,
    });
    if (widgetElement) widgetElement.style.display = '';
    return canvas.toDataURL('image/png');
  } catch (err) {
    if (widgetElement) widgetElement.style.display = '';
    console.error('Failed to capture screenshot:', err);
    return undefined;
  }
}

function buildMetadata() {
  return {
    userAgent: navigator.userAgent,
    pageUrl: window.location.href,
    screenSize: `${window.innerWidth}x${window.innerHeight}`,
    timestamp: Date.now(),
  };
}

// ── Render emoji markers ───────────────────────────────────────────

function renderMessageText(text: string): React.ReactNode[] {
  const parts = text.split(/(<emoji:https?:\/\/[^>]+>)/g);
  return parts.map((part, i) => {
    const match = part.match(/^<emoji:(https?:\/\/[^>]+)>$/);
    if (match) {
      return (
        <Box
          component="img"
          key={i}
          src={match[1]}
          alt="emoji"
          sx={{ height: '1.2em', verticalAlign: 'text-bottom', display: 'inline' }}
        />
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// ── Chat Bubble ────────────────────────────────────────────────────

function ChatBubble({ message }: { message: SupportChatMessage }) {
  const isUser = message.sender === 'user';
  const time = new Date(message.timestamp).toLocaleTimeString();

  return (
    <Box sx={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', mb: 0.75 }}>
      <Box
        sx={{
          maxWidth: '80%',
          p: 0.75,
          px: 1.25,
          borderRadius: 2,
          backgroundColor: isUser ? 'primary.dark' : 'grey.800',
          borderBottomRightRadius: isUser ? 0 : undefined,
          borderBottomLeftRadius: !isUser ? 0 : undefined,
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25, fontSize: '0.65rem' }}>
          {message.senderName} · {time}
        </Typography>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.8rem' }}>
          {renderMessageText(message.text)}
        </Typography>
        {message.screenshotDataUrl && (
          <Box
            component="img"
            src={message.screenshotDataUrl}
            sx={{ mt: 0.5, maxWidth: '100%', maxHeight: 150, borderRadius: 1, cursor: 'pointer' }}
            onClick={() => window.open(message.screenshotDataUrl, '_blank')}
          />
        )}
      </Box>
    </Box>
  );
}

// ── Chat View ──────────────────────────────────────────────────────

function WidgetChatView({
  sessionId,
  senderName,
  onEnd,
  onCreateIssue,
}: {
  sessionId: string;
  senderName: string;
  onEnd: () => void;
  onCreateIssue: () => void;
}) {
  const messages = useSupportChatMessages(sessionId);
  const [text, setText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const slackConfig = useSlackConfigState();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = (screenshotDataUrl?: string) => {
    const msgText = text.trim();
    if (!msgText && !screenshotDataUrl) return;
    sendSupportChatMessage(sessionId, msgText || '📷 Screenshot', screenshotDataUrl, senderName || undefined);
    setText('');
  };

  const handleScreenshot = async () => {
    const screenshot = await captureScreenshot();
    if (screenshot) handleSend(screenshot);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Chat header bar */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5, flexShrink: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {slackConfig?.connected ? (
            <Chip
              label="Connected"
              size="small"
              color="success"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.65rem' }}
            />
          ) : (
            <Chip
              label="Offline"
              size="small"
              color="warning"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.65rem' }}
            />
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Button
            size="small"
            onClick={onCreateIssue}
            sx={{ fontSize: '0.65rem', minWidth: 0, px: 0.75, textTransform: 'none' }}
          >
            Create Issue
          </Button>
          <Button
            size="small"
            color="error"
            onClick={onEnd}
            sx={{ fontSize: '0.65rem', minWidth: 0, px: 0.75, textTransform: 'none' }}
          >
            End
          </Button>
        </Box>
      </Box>

      {/* Messages */}
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          p: 0.75,
          mb: 0.5,
          backgroundColor: 'background.default',
          minHeight: 0,
        }}
      >
        {messages.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', mt: 2, fontSize: '0.8rem' }}>
            {slackConfig?.connected
              ? 'Chat started! An admin will respond via Slack.'
              : 'Slack not connected — messages stored locally.'}
          </Typography>
        )}
        {messages.map(msg => (
          <ChatBubble key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </Box>

      {/* Input */}
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-end', flexShrink: 0 }}>
        <Tooltip title="Send screenshot of this page" arrow>
          <IconButton onClick={handleScreenshot} color="primary" size="small" sx={{ p: 0.5 }}>
            <PhotoCameraIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <TextField
          fullWidth
          size="small"
          multiline
          maxRows={3}
          placeholder="Type a message..."
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          sx={{ '& .MuiInputBase-input': { fontSize: '0.8rem' } }}
        />
        <IconButton onClick={() => handleSend()} color="primary" disabled={!text.trim()} size="small" sx={{ p: 0.5 }}>
          <SendIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>
    </Box>
  );
}

// ── Issue Report (compact) ─────────────────────────────────────────

function WidgetIssueForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [tryingToDo, setTryingToDo] = useState('');
  const [stepsPerformed, setStepsPerformed] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [screenshot, setScreenshot] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const recentLogsRef = useRef<string[]>([]);

  useAppLogCallback(
    useCallback((log: AppLogMessage) => {
      recentLogsRef.current.push(`[${log.level}] ${log.message}`);
      if (recentLogsRef.current.length > 50) recentLogsRef.current = recentLogsRef.current.slice(-50);
    }, []),
  );

  // Use the pre-captured screenshot (taken before widget was shown)
  useEffect(() => {
    if (includeScreenshot && preOpenScreenshot) {
      setScreenshot(preOpenScreenshot);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async () => {
    if (!tryingToDo.trim() && !actual.trim()) return;
    setSubmitting(true);
    let screenshotDataUrl = screenshot;
    if (includeScreenshot && !screenshotDataUrl) screenshotDataUrl = await captureScreenshot();
    sendSubmitSupportIssue(tryingToDo, stepsPerformed, expected, actual, buildMetadata(), screenshotDataUrl, [
      ...recentLogsRef.current,
    ]);
    setSubmitting(false);
    setSubmitted(true);
    onSubmitted();
  };

  if (submitted) {
    return (
      <Alert severity="success" sx={{ mt: 1 }}>
        <Typography variant="body2">Issue submitted!</Typography>
        <Button
          size="small"
          variant="outlined"
          sx={{ mt: 1 }}
          onClick={() => {
            setSubmitted(false);
            setTryingToDo('');
            setStepsPerformed('');
            setExpected('');
            setActual('');
            setScreenshot(undefined);
          }}
        >
          Submit Another
        </Button>
      </Alert>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, overflowY: 'auto' }}>
      <TextField
        size="small"
        label="What were you trying to do?"
        multiline
        rows={2}
        value={tryingToDo}
        onChange={e => setTryingToDo(e.target.value)}
        fullWidth
        required
      />
      <TextField
        size="small"
        label="Steps you took"
        multiline
        rows={2}
        value={stepsPerformed}
        onChange={e => setStepsPerformed(e.target.value)}
        fullWidth
      />
      <TextField
        size="small"
        label="What did you expect?"
        multiline
        rows={2}
        value={expected}
        onChange={e => setExpected(e.target.value)}
        fullWidth
      />
      <TextField
        size="small"
        label="What actually happened?"
        multiline
        rows={2}
        value={actual}
        onChange={e => setActual(e.target.value)}
        fullWidth
        required
      />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          size="small"
          variant={includeScreenshot ? 'contained' : 'outlined'}
          startIcon={<PhotoCameraIcon />}
          onClick={() => setIncludeScreenshot(!includeScreenshot)}
          sx={{ fontSize: '0.7rem', textTransform: 'none' }}
        >
          {includeScreenshot ? 'Screenshot ✓' : 'Screenshot'}
        </Button>
        {includeScreenshot && screenshot && (
          <Box
            component="img"
            src={screenshot}
            sx={{ height: 40, borderRadius: 0.5, border: 1, borderColor: 'divider' }}
          />
        )}
      </Box>

      <Button
        variant="contained"
        onClick={handleSubmit}
        disabled={submitting || (!tryingToDo.trim() && !actual.trim())}
        startIcon={<BugReportIcon />}
        sx={{ textTransform: 'none' }}
      >
        {submitting ? 'Submitting...' : 'Submit Issue'}
      </Button>
    </Box>
  );
}

// ── Issues List (compact) ──────────────────────────────────────────

function WidgetIssuesList({ onStartChat }: { onStartChat: (issueId: string) => void }) {
  const supportState = useSupportState();

  if (!supportState || supportState.issues.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', mt: 2 }}>
        No issues reported yet.
      </Typography>
    );
  }

  return (
    <Box sx={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {supportState.issues.slice(0, 15).map(issue => {
        const statusColor = issue.status === 'open' ? 'warning' : issue.status === 'in-chat' ? 'info' : 'default';
        return (
          <Box key={issue.id} sx={{ p: 0.75, border: 1, borderColor: 'divider', borderRadius: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25 }}>
              <Chip
                label={issue.status}
                size="small"
                color={statusColor}
                variant="outlined"
                sx={{ height: 18, fontSize: '0.6rem' }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.6rem' }}>
                {new Date(issue.createdAt).toLocaleString()}
              </Typography>
            </Box>
            <Typography variant="body2" sx={{ fontSize: '0.75rem', fontWeight: 'bold' }}>
              {(issue.tryingToDo || 'No description').slice(0, 80)}
            </Typography>
            {issue.status === 'open' && (
              <Button
                size="small"
                startIcon={<ChatIcon />}
                onClick={() => onStartChat(issue.id)}
                sx={{ fontSize: '0.65rem', mt: 0.25, textTransform: 'none', p: 0 }}
              >
                Chat
              </Button>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

// ── Create Issue From Chat Dialog ───────────────────────────────────

function CreateIssueFromChatDialog({
  open,
  sessionId,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  onClose: () => void;
}) {
  const [tryingToDo, setTryingToDo] = useState('');
  const [actual, setActual] = useState('');

  const handleCreate = () => {
    if (!tryingToDo.trim() && !actual.trim()) return;
    sendCreateIssueFromChat(sessionId, tryingToDo, actual);
    onClose();
    setTryingToDo('');
    setActual('');
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Create Issue from Chat</DialogTitle>
      <DialogContent>
        <TextField
          label="What were you trying to do?"
          multiline
          rows={2}
          value={tryingToDo}
          onChange={e => setTryingToDo(e.target.value)}
          fullWidth
          sx={{ mb: 2, mt: 1 }}
          autoFocus
        />
        <TextField
          label="Summary of the problem"
          multiline
          rows={2}
          value={actual}
          onChange={e => setActual(e.target.value)}
          fullWidth
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleCreate} variant="contained" disabled={!tryingToDo.trim() && !actual.trim()}>
          Create Issue
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Main Widget Component ──────────────────────────────────────────

function SupportChatWidgetPanel() {
  const { isOpen, closeWidget } = useSupportWidget();
  const [view, setView] = useState<'chat' | 'report'>(() => {
    const saved = localStorage.getItem('support-widget-view');
    return saved === 'report' ? 'report' : 'chat';
  });
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(() => {
    return localStorage.getItem('support-widget-sessionId') || null;
  });
  const [chatName, setChatName] = useState(() => localStorage.getItem('support-sender-name') || '');
  const [createIssueDialogOpen, setCreateIssueDialogOpen] = useState(false);
  const slackConfig = useSlackConfigState();
  const panelRef = useRef<HTMLDivElement>(null);

  // Register widget element for screenshot hiding
  useEffect(() => {
    widgetElement = panelRef.current;
    return () => {
      widgetElement = null;
    };
  }, []);

  // Persist widget state
  useEffect(() => {
    localStorage.setItem('support-widget-view', view);
  }, [view]);
  useEffect(() => {
    if (activeChatSessionId) {
      localStorage.setItem('support-widget-sessionId', activeChatSessionId);
    } else {
      localStorage.removeItem('support-widget-sessionId');
    }
  }, [activeChatSessionId]);

  // Listen for chat started responses
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId) {
        setActiveChatSessionId(detail.sessionId);
        setView('chat');
      }
    };
    window.addEventListener('supportChatStarted', handler);
    return () => window.removeEventListener('supportChatStarted', handler);
  }, []);

  // Restore active session from server state
  const supportState = useSupportState();
  useEffect(() => {
    if (activeChatSessionId && supportState) {
      const session = supportState.activeSessions.find(s => s.id === activeChatSessionId);
      if (!session) {
        // Session no longer active on server
        setActiveChatSessionId(null);
      }
    }
  }, [activeChatSessionId, supportState]);

  const handleConfirmStartChat = () => {
    if (!chatName.trim()) return;
    localStorage.setItem('support-sender-name', chatName.trim());
    sendStartSupportChat(undefined, chatName.trim());
  };

  const handleEndChat = () => {
    if (activeChatSessionId) {
      sendEndSupportChat(activeChatSessionId);
      setActiveChatSessionId(null);
    }
  };

  if (!isOpen) return null;

  const tabIndex = view === 'chat' ? 0 : 1;
  const chatDisabled = slackConfig !== null && !slackConfig.configured && !activeChatSessionId;

  return (
    <Box
      ref={panelRef}
      sx={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: { xs: 'calc(100vw - 32px)', sm: 380 },
        height: { xs: '70vh', sm: 520 },
        zIndex: 9998,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 2,
        overflow: 'hidden',
        boxShadow: 8,
        backgroundColor: 'background.paper',
        border: 1,
        borderColor: 'divider',
      }}
    >
      {/* Title bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1.5,
          py: 0.5,
          backgroundColor: 'primary.dark',
          flexShrink: 0,
          cursor: 'default',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <SupportAgentIcon sx={{ fontSize: 16 }} />
          <Typography variant="subtitle2" sx={{ fontSize: '0.8rem', fontWeight: 'bold' }}>
            Support
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.25 }}>
          <IconButton size="small" onClick={closeWidget} sx={{ p: 0.25, color: 'inherit' }}>
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
      </Box>

      {/* Tabs */}
      <Tabs
        value={tabIndex}
        onChange={(_, v) => setView(v === 0 ? 'chat' : 'report')}
        sx={{ minHeight: 32, flexShrink: 0, '& .MuiTab-root': { minHeight: 32, py: 0.5, fontSize: '0.7rem' } }}
      >
        <Tab
          icon={<ChatIcon sx={{ fontSize: 14 }} />}
          label={activeChatSessionId ? 'Chat ●' : 'Chat'}
          iconPosition="start"
          disabled={chatDisabled}
          sx={{ minWidth: 0 }}
        />
        <Tab
          icon={<BugReportIcon sx={{ fontSize: 14 }} />}
          label="Report Issue"
          iconPosition="start"
          sx={{ minWidth: 0 }}
        />
      </Tabs>

      {/* Content */}
      <Box sx={{ flex: 1, p: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' }}>
        {view === 'chat' &&
          (activeChatSessionId ? (
            <WidgetChatView
              sessionId={activeChatSessionId}
              senderName={chatName}
              onEnd={handleEndChat}
              onCreateIssue={() => setCreateIssueDialogOpen(true)}
            />
          ) : (
            <Box
              sx={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                gap: 1.5,
                px: 2,
              }}
            >
              <ChatIcon sx={{ fontSize: 36, color: 'text.secondary' }} />
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.8rem', textAlign: 'center' }}>
                Chat with an admin in real-time via Slack.
              </Typography>
              <TextField
                size="small"
                label="Your Name"
                value={chatName}
                onChange={e => setChatName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && chatName.trim()) handleConfirmStartChat();
                }}
                fullWidth
                placeholder="e.g., Alex from Team 1234"
                autoFocus
              />
              <Button
                variant="contained"
                fullWidth
                startIcon={<ChatIcon />}
                onClick={handleConfirmStartChat}
                disabled={!chatName.trim()}
                sx={{ textTransform: 'none' }}
              >
                Start Chat
              </Button>
            </Box>
          ))}

        {view === 'report' && <WidgetIssueForm onSubmitted={() => {}} />}
      </Box>

      {/* Dialogs */}
      {activeChatSessionId && (
        <CreateIssueFromChatDialog
          open={createIssueDialogOpen}
          sessionId={activeChatSessionId}
          onClose={() => setCreateIssueDialogOpen(false)}
        />
      )}
    </Box>
  );
}

// ── Provider + Widget Export ────────────────────────────────────────

export function SupportWidgetProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(() => localStorage.getItem('support-widget-open') === 'true');
  const [unreadCount, setUnreadCount] = useState(0);
  const lastSeenRef = useRef(0);

  // Track unread messages when widget is closed
  useEffect(() => {
    if (isOpen) {
      setUnreadCount(0);
      lastSeenRef.current = Date.now();
    }
  }, [isOpen]);

  // Listen for incoming chat messages when widget is closed
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<SupportChatMessage>).detail;
      if (!isOpen && msg.sender === 'admin' && msg.timestamp > lastSeenRef.current) {
        setUnreadCount(c => c + 1);
      }
    };
    window.addEventListener('supportChatMessage', handler);
    return () => window.removeEventListener('supportChatMessage', handler);
  }, [isOpen]);

  // Persist open state
  useEffect(() => {
    localStorage.setItem('support-widget-open', isOpen ? 'true' : 'false');
  }, [isOpen]);

  const openWidget = useCallback((view?: 'chat' | 'report') => {
    if (view) localStorage.setItem('support-widget-view', view);
    // Capture screenshot before showing the widget so it captures the actual page
    captureScreenshot().then(s => {
      preOpenScreenshot = s;
    });
    setIsOpen(true);
    setUnreadCount(0);
  }, []);

  const closeWidget = useCallback(() => {
    setIsOpen(false);
  }, []);

  return (
    <SupportWidgetContext.Provider value={{ openWidget, closeWidget, isOpen, unreadCount }}>
      {children}
      <SupportChatWidgetPanel />
    </SupportWidgetContext.Provider>
  );
}
