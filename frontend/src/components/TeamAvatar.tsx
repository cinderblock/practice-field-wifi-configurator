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

  if (!teamNumber || hasError) return null;

  return (
    <Avatar
      src={`/api/team-avatar/${teamNumber}`}
      alt={`FRC ${teamNumber}`}
      sx={{ width: size, height: size, ...(sx as object) }}
      slotProps={{
        img: {
          onError: () => setHasError(true),
          loading: 'lazy',
        },
      }}
    />
  );
}
