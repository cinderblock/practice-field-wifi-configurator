import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import { Box, Button, Typography, Tooltip } from '@mui/material';
import { AllianceStatus } from './AllianceStatus';
import { SystemInfo } from './SystemInfo';
import { sendNewConfig } from '../hooks/useBackend';
import { useStagedChanges } from '../hooks/useStagedChanges';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import { StationName } from '../../../src/types';

export function MainPage() {
  const { applyStagedChange } = useStagedChanges();
  
  // Feature flag for staging functionality
  const enableStaging = process.env.REACT_APP_ENABLE_STAGING === 'true';
  
  const handleClearAllStations = async () => {
    console.log('Clearing all stations');
    const allStations: StationName[] = ['red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3'];
    
    // Clear all stations with a small delay between each to avoid overwhelming the backend
    for (let i = 0; i < allStations.length; i++) {
      const station = allStations[i];
      console.log('Clearing station:', station);
      
      // Clear the station configuration immediately
      sendNewConfig(station, '', '', false);
      
      // Clear any staged changes for this station
      if (enableStaging) {
        applyStagedChange(station);
      }
      
      // Small delay between requests to avoid overwhelming the backend
      if (i < allStations.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  };

  return (
    <Container>
      <Grid container spacing={2}>
        <AllianceStatus alliance="red" />
        <AllianceStatus alliance="blue" reverse />
        <Grid size={{ xs: 12 }}>
          <Box sx={{ 
            display: 'flex', 
            justifyContent: 'center', 
            alignItems: 'center', 
            marginY: 3,
            padding: 2,
            backgroundColor: 'background.paper',
            borderRadius: 1,
            border: 1,
            borderColor: 'divider'
          }}>
            <Typography variant="h6" sx={{ marginRight: 2 }}>
              Clear All Stations
            </Typography>
            <Tooltip title="Clear all station configurations">
              <Button
                variant="outlined"
                color="error"
                startIcon={<ClearAllIcon />}
                onClick={handleClearAllStations}
                sx={{
                  '&:hover': {
                    backgroundColor: 'error.light',
                    color: 'error.contrastText'
                  }
                }}
              >
                Clear All
              </Button>
            </Tooltip>
          </Box>
        </Grid>
        <Grid size={{ xs: 12 }}>
          <SystemInfo />
        </Grid>
      </Grid>
    </Container>
  );
}
