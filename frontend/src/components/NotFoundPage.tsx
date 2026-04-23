import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import HomeIcon from '@mui/icons-material/Home';

export function NotFoundPage() {
  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
          textAlign: 'center',
          gap: 2,
        }}
      >
        <Typography variant="h1" sx={{ fontSize: '6rem', fontWeight: 700, opacity: 0.3 }}>
          404
        </Typography>
        <Typography variant="h5">Page not found</Typography>
        <Typography variant="body1" color="text.secondary">
          The page at <code>{window.location.pathname}</code> doesn't exist.
        </Typography>
        <Button variant="contained" size="large" startIcon={<HomeIcon />} href="/" sx={{ mt: 2 }}>
          Go Home
        </Button>
      </Box>
    </Container>
  );
}
