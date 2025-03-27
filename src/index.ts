import RadioManager from './radioManager';
import { setupWebSocket } from './websocketServer';

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://10.0.100.2';

// Initialize radio manager
const radioManager = new RadioManager(API_BASE_URL);

// Initialize WebSocket server
setupWebSocket(radioManager);
