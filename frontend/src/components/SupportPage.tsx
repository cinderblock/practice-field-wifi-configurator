import { useState, useEffect, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
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
import DescriptionIcon from '@mui/icons-material/Description';
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

// ── Screenshot Utility ─────────────────────────────────────────────

async function captureScreenshot(): Promise<string | undefined> {
  try {
    const canvas = await html2canvas(document.body, {
      backgroundColor: '#121212',
      scale: 0.5, // Half resolution to keep size manageable
      logging: false,
      useCORS: true,
      allowTaint: true,
    });
    return canvas.toDataURL('image/png');
  } catch (err) {
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

// ── Issue Report Form ──────────────────────────────────────────────

function IssueReportForm({ onSubmitted }: { onSubmitted: (issueId: string) => void }) {
  const [tryingToDo, setTryingToDo] = useState('');
  const [stepsPerformed, setStepsPerformed] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [screenshot, setScreenshot] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const recentLogsRef = useRef<string[]>([]);

  // Collect recent logs in the background
  useAppLogCallback(
    useCallback((log: AppLogMessage) => {
      recentLogsRef.current.push(`[${log.level}] ${log.message}`);
      // Keep last 50 log entries
      if (recentLogsRef.current.length > 50) {
        recentLogsRef.current = recentLogsRef.current.slice(-50);
      }
    }, []),
  );

  // Auto-capture screenshot on mount
  useEffect(() => {
    if (includeScreenshot) {
      captureScreenshot().then(setScreenshot);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRetakeScreenshot = async () => {
    const s = await captureScreenshot();
    setScreenshot(s);
  };

  const handleSubmit = async () => {
    if (!tryingToDo.trim() && !actual.trim()) return;
    setSubmitting(true);

    // Capture a fresh screenshot if enabled
    let screenshotDataUrl = screenshot;
    if (includeScreenshot && !screenshotDataUrl) {
      screenshotDataUrl = await captureScreenshot();
    }

    sendSubmitSupportIssue(tryingToDo, stepsPerformed, expected, actual, buildMetadata(), screenshotDataUrl, [
      ...recentLogsRef.current,
    ]);

    setSubmitting(false);
    setSubmitted(true);

    // Listen for the created issue ID
    const checkForResult = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.issueId) {
        onSubmitted(detail.issueId);
        window.removeEventListener('supportIssueCreated', checkForResult);
      }
    };
    window.addEventListener('supportIssueCreated', checkForResult);
  };

  if (submitted) {
    return (
      <Alert severity="success" sx={{ mt: 2 }}>
        <Typography variant="subtitle2">Issue report submitted!</Typography>
        <Typography variant="body2">Your report has been received and forwarded to the support team.</Typography>
        <Box sx={{ mt: 2, display: 'flex', gap: 1 }}>
          <Button
            size="small"
            variant="outlined"
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
        </Box>
      </Alert>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
      <TextField
        label="What were you trying to do?"
        multiline
        rows={2}
        value={tryingToDo}
        onChange={e => setTryingToDo(e.target.value)}
        placeholder="e.g., Configure team 1234's WiFi on station 3"
        fullWidth
        required
      />

      <TextField
        label="What buttons did you click / what steps did you take?"
        multiline
        rows={2}
        value={stepsPerformed}
        onChange={e => setStepsPerformed(e.target.value)}
        placeholder='e.g., Entered team number, clicked "Configure", waited 30 seconds'
        fullWidth
      />

      <TextField
        label="What did you expect to happen?"
        multiline
        rows={2}
        value={expected}
        onChange={e => setExpected(e.target.value)}
        placeholder='e.g., Status should show "ACTIVE" with the team connected'
        fullWidth
      />

      <TextField
        label="What actually happened?"
        multiline
        rows={2}
        value={actual}
        onChange={e => setActual(e.target.value)}
        placeholder="e.g., Status stayed on CONFIGURING for over a minute, then showed ERROR"
        fullWidth
        required
      />

      {/* Screenshot section */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          size="small"
          variant={includeScreenshot ? 'contained' : 'outlined'}
          startIcon={<PhotoCameraIcon />}
          onClick={() => setIncludeScreenshot(!includeScreenshot)}
        >
          {includeScreenshot ? 'Screenshot Included' : 'Include Screenshot'}
        </Button>
        {includeScreenshot && screenshot && (
          <>
            <Tooltip title="Click to retake screenshot" arrow>
              <Box
                component="img"
                src={screenshot}
                sx={{
                  height: 60,
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'divider',
                  cursor: 'pointer',
                  '&:hover': { opacity: 0.8 },
                }}
                onClick={handleRetakeScreenshot}
              />
            </Tooltip>
            <Button size="small" variant="text" onClick={() => setScreenshot(undefined)}>
              Remove
            </Button>
          </>
        )}
        {includeScreenshot && !screenshot && (
          <Button size="small" variant="text" onClick={handleRetakeScreenshot}>
            Capture Now
          </Button>
        )}
      </Box>

      <Typography variant="caption" color="text.secondary">
        Recent system logs and browser metadata will be included automatically.
      </Typography>

      <Button
        variant="contained"
        size="large"
        onClick={handleSubmit}
        disabled={submitting || (!tryingToDo.trim() && !actual.trim())}
        startIcon={<BugReportIcon />}
      >
        {submitting ? 'Submitting...' : 'Submit Issue Report'}
      </Button>
    </Box>
  );
}

// ── Chat Component ─────────────────────────────────────────────────

function SupportChatView({
  sessionId,
  onEnd,
  onCreateIssue,
}: {
  sessionId: string;
  onEnd: () => void;
  onCreateIssue: () => void;
}) {
  const messages = useSupportChatMessages(sessionId);
  const [text, setText] = useState('');
  const [senderName, setSenderName] = useState(() => localStorage.getItem('support-sender-name') || '');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const slackConfig = useSlackConfigState();

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = (screenshotDataUrl?: string) => {
    const msgText = text.trim();
    if (!msgText && !screenshotDataUrl) return;

    if (senderName) {
      localStorage.setItem('support-sender-name', senderName);
    }

    sendSupportChatMessage(sessionId, msgText || '📷 Screenshot', screenshotDataUrl, senderName || undefined);
    setText('');
  };

  const handleScreenshot = async () => {
    const screenshot = await captureScreenshot();
    if (screenshot) {
      handleSend(screenshot);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 200px)', minHeight: 400 }}>
      {/* Chat header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="subtitle1" fontWeight="bold">
            Support Chat
          </Typography>
          {slackConfig?.connected ? (
            <Chip label="Slack Connected" size="small" color="success" variant="outlined" />
          ) : (
            <Chip label="Slack Offline" size="small" color="warning" variant="outlined" />
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Create an issue from this conversation" arrow>
            <Button size="small" variant="outlined" startIcon={<DescriptionIcon />} onClick={onCreateIssue}>
              Create Issue
            </Button>
          </Tooltip>
          <Button size="small" variant="outlined" color="error" onClick={onEnd}>
            End Chat
          </Button>
        </Box>
      </Box>

      {/* Name input */}
      <TextField
        size="small"
        label="Your Name (optional)"
        value={senderName}
        onChange={e => setSenderName(e.target.value)}
        sx={{ mb: 1 }}
        placeholder="e.g., Team 1234 Mentor"
      />

      {/* Messages */}
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          p: 1,
          mb: 1,
          backgroundColor: 'background.default',
        }}
      >
        {messages.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', mt: 4 }}>
            {slackConfig?.connected
              ? 'Chat started! An admin will respond shortly via Slack.'
              : 'Chat started! Note: Slack is not connected — messages are stored locally.'}
          </Typography>
        )}
        {messages.map(msg => (
          <ChatBubble key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </Box>

      {/* Input area */}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
        <Tooltip title="Send a screenshot" arrow>
          <IconButton onClick={handleScreenshot} color="primary" size="small">
            <PhotoCameraIcon />
          </IconButton>
        </Tooltip>
        <TextField
          fullWidth
          size="small"
          multiline
          maxRows={4}
          placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <IconButton onClick={() => handleSend()} color="primary" disabled={!text.trim()}>
          <SendIcon />
        </IconButton>
      </Box>
    </Box>
  );
}

function ChatBubble({ message }: { message: SupportChatMessage }) {
  const isUser = message.sender === 'user';
  const time = new Date(message.timestamp).toLocaleTimeString();

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        mb: 1,
      }}
    >
      <Box
        sx={{
          maxWidth: '75%',
          p: 1,
          px: 1.5,
          borderRadius: 2,
          backgroundColor: isUser ? 'primary.dark' : 'grey.800',
          borderBottomRightRadius: isUser ? 0 : undefined,
          borderBottomLeftRadius: !isUser ? 0 : undefined,
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
          {message.senderName} · {time}
        </Typography>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message.text}
        </Typography>
        {message.screenshotDataUrl && (
          <Box
            component="img"
            src={message.screenshotDataUrl}
            sx={{
              mt: 0.5,
              maxWidth: '100%',
              maxHeight: 200,
              borderRadius: 1,
              cursor: 'pointer',
            }}
            onClick={() => window.open(message.screenshotDataUrl, '_blank')}
          />
        )}
      </Box>
    </Box>
  );
}

// ── Issues List ────────────────────────────────────────────────────

function IssuesList({ onStartChat }: { onStartChat: (issueId: string) => void }) {
  const supportState = useSupportState();

  if (!supportState || supportState.issues.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2, textAlign: 'center' }}>
        No issues reported yet.
      </Typography>
    );
  }

  return (
    <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {supportState.issues.slice(0, 20).map(issue => (
        <IssueCard key={issue.id} issue={issue} onStartChat={() => onStartChat(issue.id)} />
      ))}
    </Box>
  );
}

function IssueCard({ issue, onStartChat }: { issue: SupportIssue; onStartChat: () => void }) {
  const statusColor = issue.status === 'open' ? 'warning' : issue.status === 'in-chat' ? 'info' : 'default';
  const time = new Date(issue.createdAt).toLocaleString();

  return (
    <Card variant="outlined">
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, mr: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <Chip label={issue.status} size="small" color={statusColor} variant="outlined" />
              <Typography variant="caption" color="text.secondary">
                {time}
              </Typography>
            </Box>
            <Typography variant="body2" fontWeight="bold" sx={{ mb: 0.5 }}>
              {issue.tryingToDo || 'No description'}
            </Typography>
            {issue.actual && (
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.8rem' }}>
                {issue.actual.slice(0, 150)}
                {issue.actual.length > 150 ? '...' : ''}
              </Typography>
            )}
          </Box>
          {issue.status === 'open' && (
            <Tooltip title="Start a chat about this issue" arrow>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ChatIcon />}
                onClick={onStartChat}
                sx={{ flexShrink: 0 }}
              >
                Chat
              </Button>
            </Tooltip>
          )}
        </Box>
      </CardContent>
    </Card>
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
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Create Issue from Chat</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Create a tracked issue from this chat conversation. The chat history will be included automatically.
        </Typography>
        <TextField
          label="What were you trying to do?"
          multiline
          rows={2}
          value={tryingToDo}
          onChange={e => setTryingToDo(e.target.value)}
          fullWidth
          sx={{ mb: 2 }}
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

// ── Main Support Page ──────────────────────────────────────────────

export function SupportPage() {
  const [tab, setTab] = useState(0);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [createIssueDialogOpen, setCreateIssueDialogOpen] = useState(false);
  const slackConfig = useSlackConfigState();

  const handleIssueSubmitted = (issueId: string) => {
    // Dispatch a custom event so the form can pick it up
    window.dispatchEvent(new CustomEvent('supportIssueCreated', { detail: { issueId } }));
  };

  // Listen for chat started responses
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId) {
        setActiveChatSessionId(detail.sessionId);
        setTab(1); // Switch to chat tab
      }
    };
    window.addEventListener('supportChatStarted', handler);
    return () => window.removeEventListener('supportChatStarted', handler);
  }, []);

  const handleStartChat = (issueId?: string) => {
    sendStartSupportChat(issueId);
  };

  const handleEndChat = () => {
    if (activeChatSessionId) {
      sendEndSupportChat(activeChatSessionId);
      setActiveChatSessionId(null);
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Support
      </Typography>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab icon={<BugReportIcon />} label="Report Issue" iconPosition="start" />
        <Tooltip
          title={
            !slackConfig?.configured ? (
              <>
                Slack not configured.{' '}
                <a href="/admin" style={{ color: 'inherit' }}>
                  Set up Slack on the admin page
                </a>{' '}
                to enable chat.
              </>
            ) : (
              ''
            )
          }
          arrow
        >
          <span>
            <Tab
              icon={<ChatIcon />}
              label={activeChatSessionId ? 'Chat (Active)' : 'Chat'}
              iconPosition="start"
              disabled={!slackConfig?.configured && !activeChatSessionId}
            />
          </span>
        </Tooltip>
        <Tab icon={<DescriptionIcon />} label="Issues" iconPosition="start" />
      </Tabs>

      {/* Report Issue Tab */}
      {tab === 0 && (
        <Card>
          <CardContent>
            <Typography variant="h5" gutterBottom>
              Report an Issue
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Describe the problem you encountered. A screenshot and recent system logs will be included automatically.
            </Typography>
            <IssueReportForm onSubmitted={handleIssueSubmitted} />
          </CardContent>
        </Card>
      )}

      {/* Chat Tab */}
      {tab === 1 && (
        <Card>
          <CardContent>
            {activeChatSessionId ? (
              <>
                <SupportChatView
                  sessionId={activeChatSessionId}
                  onEnd={handleEndChat}
                  onCreateIssue={() => setCreateIssueDialogOpen(true)}
                />
                <CreateIssueFromChatDialog
                  open={createIssueDialogOpen}
                  sessionId={activeChatSessionId}
                  onClose={() => setCreateIssueDialogOpen(false)}
                />
              </>
            ) : (
              <Box sx={{ textAlign: 'center', py: 4 }}>
                <ChatIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
                <Typography variant="h6" gutterBottom>
                  Start a Chat Session
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  Chat with an admin in real-time. Your conversation will be bridged to Slack.
                </Typography>
                <Button variant="contained" size="large" startIcon={<ChatIcon />} onClick={() => handleStartChat()}>
                  Start New Chat
                </Button>
              </Box>
            )}
          </CardContent>
        </Card>
      )}

      {/* Issues List Tab */}
      {tab === 2 && (
        <Card>
          <CardContent>
            <Typography variant="h5" gutterBottom>
              Recent Issues
            </Typography>
            <IssuesList onStartChat={issueId => handleStartChat(issueId)} />
          </CardContent>
        </Card>
      )}
    </Container>
  );
}
