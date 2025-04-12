import React from 'react';
import { Container, Typography, Button } from '@mui/material';
import { useHistory } from '../hooks/useBackend';

export const MainPage: React.FC = () => {
  const history = useHistory();

  return (
    <Container>
      <Typography variant="h2" gutterBottom>
        Welcome to the Main Page
      </Typography>
      <Typography variant="body1" gutterBottom>
        Recent Updates:
      </Typography>
      {history.map((entry, index) => (
        <Typography key={index} variant="body2">
          {JSON.stringify(entry)}
        </Typography>
      ))}
      <Button variant="contained" color="primary">
        Get Started
      </Button>
    </Container>
  );
};
