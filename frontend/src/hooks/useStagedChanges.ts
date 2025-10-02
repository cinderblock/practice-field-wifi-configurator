import { useCallback, useEffect, useState } from 'react';
import { StationName } from '../../../src/types';

const STORAGE_KEY = 'staged-wifi-changes';

interface StagedChange {
  ssid: string;
  wpaKey: string;
  stagedAt: number;
}

// Global state to ensure sharing across all components
let globalStagedChanges: Record<StationName, StagedChange | null> = {
  red1: null,
  red2: null,
  red3: null,
  blue1: null,
  blue2: null,
  blue3: null,
};

let globalListeners: Set<(changes: Record<StationName, StagedChange | null>) => void> = new Set();

// Load from localStorage on module load
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object') {
      globalStagedChanges = { ...globalStagedChanges, ...parsed };
    }
  }
} catch (error) {
  console.error('Error loading staged changes:', error);
}

function notifyListeners() {
  globalListeners.forEach(listener => listener(globalStagedChanges));
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(globalStagedChanges));
  } catch (error) {
    console.error('Error saving staged changes:', error);
  }
}

export function useStagedChanges() {
  const [stagedChanges, setStagedChanges] = useState<Record<StationName, StagedChange | null>>(globalStagedChanges);

  // Subscribe to global state changes
  useEffect(() => {
    const listener = (changes: Record<StationName, StagedChange | null>) => {
      setStagedChanges(changes);
    };

    globalListeners.add(listener);

    // Set initial state
    setStagedChanges(globalStagedChanges);

    return () => {
      globalListeners.delete(listener);
    };
  }, []);

  const stageChange = useCallback((station: StationName, ssid: string, wpaKey: string) => {
    const change: StagedChange = {
      ssid: ssid.trim(),
      wpaKey: wpaKey.trim(),
      stagedAt: Date.now(),
    };

    globalStagedChanges[station] = change;
    saveToStorage();
    notifyListeners();
  }, []);

  const applyStagedChange = useCallback((station: StationName) => {
    const change = globalStagedChanges[station];
    if (change) {
      // Clear the staged change
      globalStagedChanges[station] = null;
      saveToStorage();
      notifyListeners();

      // Return the change so it can be applied
      return change;
    }
    return null;
  }, []);

  const clearStagedChange = useCallback((station: StationName) => {
    globalStagedChanges[station] = null;
    saveToStorage();
    notifyListeners();
  }, []);

  const hasStagedChange = useCallback((station: StationName) => {
    return globalStagedChanges[station] !== null;
  }, []);

  return {
    stagedChanges,
    stageChange,
    applyStagedChange,
    clearStagedChange,
    hasStagedChange,
  };
}
