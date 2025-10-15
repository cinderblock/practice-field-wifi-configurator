import { useState, ReactNode } from 'react';
import { Tooltip } from '@mui/material';

interface CopyToClipboardProps {
  text: string;
  children: ReactNode;
  tooltipText?: string;
  copiedText?: string;
  copiedDuration?: number;
}

export function CopyToClipboard({
  text,
  children,
  tooltipText = 'Click to copy',
  copiedText = 'Copied!',
  copiedDuration = 2000,
}: CopyToClipboardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), copiedDuration);
    });
  };

  return (
    <Tooltip title={copied ? copiedText : tooltipText} arrow>
      <span onClick={handleCopy}>{children}</span>
    </Tooltip>
  );
}
