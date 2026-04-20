import { useState, ReactNode } from 'react';
import { Tooltip } from '@mui/material';

interface CopyToClipboardProps {
  text: string;
  children: ReactNode;
  tooltipText?: string;
  copiedText?: string;
  errorText?: string;
  copiedDuration?: number;
}

/**
 * Fallback copy implementation for non-secure contexts (plain HTTP).
 *
 * `navigator.clipboard` is only available in secure contexts (HTTPS or
 * `http://localhost`). Since this app is typically served over plain HTTP
 * on a local field network (e.g. `http://pfms.local:3000`), we need a
 * legacy fallback using `document.execCommand('copy')`.
 */
function fallbackCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep it off-screen and non-disruptive.
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  document.body.appendChild(textarea);

  // Preserve the caller's selection and focus.
  const prevActive = document.activeElement as HTMLElement | null;
  const prevSelection = document.getSelection()?.rangeCount ? document.getSelection()?.getRangeAt(0) : null;

  let ok = false;
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
    if (prevSelection) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(prevSelection);
    }
    prevActive?.focus?.();
  }
  return ok;
}

export function CopyToClipboard({
  text,
  children,
  tooltipText = 'Click to copy',
  copiedText = 'Copied!',
  errorText = 'Copy failed',
  copiedDuration = 2000,
}: CopyToClipboardProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const handleCopy = async () => {
    let success = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        success = true;
      } else {
        success = fallbackCopy(text);
      }
    } catch {
      // Clipboard API threw or rejected (e.g. permission denied, not focused,
      // or non-secure context). Try the legacy path before giving up.
      success = fallbackCopy(text);
    }

    setStatus(success ? 'copied' : 'error');
    setTimeout(() => setStatus('idle'), copiedDuration);
  };

  const title = status === 'copied' ? copiedText : status === 'error' ? errorText : tooltipText;

  return (
    <Tooltip title={title} arrow>
      <span onClick={handleCopy}>{children}</span>
    </Tooltip>
  );
}
