import { createRoot } from 'react-dom/client';
import { MatchControlPage } from '../components/MatchControlPage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll showReconfigOverlay={false}>
    <MatchControlPage />
  </WrapAll>,
);
