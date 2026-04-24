import Avatar from '@mui/material/Avatar';
import { useState } from 'react';
import type { SxProps, Theme } from '@mui/material/styles';

interface TeamAvatarProps {
  teamNumber: number | null | undefined;
  size?: number;
  sx?: SxProps<Theme>;
}

export function TeamAvatar({ teamNumber, size = 24, sx }: TeamAvatarProps) {
  const [hasError, setHasError] = useState(false);

  if (!teamNumber) return null;

  return (
    <Avatar
      src={hasError ? '/first-logo.png' : `/api/team-avatar/${teamNumber}`}
      alt={`FRC ${teamNumber}`}
      sx={{ width: size, height: size, borderRadius: 1, ...(sx as object) }}
      slotProps={{
        img: {
          onError: hasError ? undefined : () => setHasError(true),
          loading: 'lazy',
        },
      }}
    />
  );
}
