import { useState, useMemo } from 'react';
import { Typography } from '@mui/material';

interface TimeDisplayProps {
  timestamp: number;
  className?: string;
}

export function TimeDisplay({ timestamp, className }: TimeDisplayProps) {
  const [isAbsolute, setIsAbsolute] = useState(() => {
    const now = Date.now();
    const twoWeeksAgo = now - (14 * 24 * 60 * 60 * 1000);
    return timestamp < twoWeeksAgo;
  });

  const timeString = useMemo(() => {
    const date = new Date(timestamp);
    
    if (isAbsolute) {
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    } else {
      const now = Date.now();
      const diffMs = now - timestamp;
      const diffSeconds = Math.floor(diffMs / 1000);
      const diffMinutes = Math.floor(diffSeconds / 60);
      const diffHours = Math.floor(diffMinutes / 60);
      const diffDays = Math.floor(diffHours / 24);
      const diffWeeks = Math.floor(diffDays / 7);
      const diffMonths = Math.floor(diffDays / 30);
      const diffYears = Math.floor(diffDays / 365);

      if (diffSeconds < 60) {
        return diffSeconds <= 1 ? 'just now' : `${diffSeconds} seconds ago`;
      } else if (diffMinutes < 60) {
        return diffMinutes === 1 ? '1 minute ago' : `${diffMinutes} minutes ago`;
      } else if (diffHours < 24) {
        return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
      } else if (diffDays < 7) {
        return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
      } else if (diffWeeks < 4) {
        return diffWeeks === 1 ? '1 week ago' : `${diffWeeks} weeks ago`;
      } else if (diffMonths < 12) {
        return diffMonths === 1 ? '1 month ago' : `${diffMonths} months ago`;
      } else {
        return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`;
      }
    }
  }, [timestamp, isAbsolute]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent parent row click
    setIsAbsolute(!isAbsolute);
  };

  return (
    <Typography
      variant="body2"
      onClick={handleClick}
      sx={{
        cursor: 'pointer',
        fontFamily: 'monospace',
        fontSize: '0.75rem',
        color: 'text.secondary',
        whiteSpace: 'nowrap',
        '&:hover': {
          color: 'text.primary',
          textDecoration: 'underline'
        }
      }}
      className={className}
    >
      {timeString}
    </Typography>
  );
}
