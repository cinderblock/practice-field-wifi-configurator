import { useCallback, useEffect, useState } from 'react';
import { SavedWiFiSetting, isSavedWiFiSetting } from '../../../src/types';

const STORAGE_KEY = 'recent-wifi-settings';
const MAX_RECENT_SETTINGS = 10;

// Custom event for same-tab communication
const CUSTOM_EVENT_NAME = 'wifi-settings-updated';

export function useSavedWiFiSettings() {
  const [recentSettings, setRecentSettings] = useState<SavedWiFiSetting[]>([]);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          const validSettings = parsed.filter(isSavedWiFiSetting);
          setRecentSettings(validSettings);
        }
      }
    } catch (error) {
      console.error('Error loading recent WiFi settings:', error);
    }
  }, []);

  // Listen for storage changes from other tabs/components
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        if (e.newValue) {
          try {
            const parsed = JSON.parse(e.newValue);
            if (Array.isArray(parsed)) {
              const validSettings = parsed.filter(isSavedWiFiSetting);
              setRecentSettings(validSettings);
            }
          } catch (error) {
            console.error('Error parsing storage change:', error);
          }
        } else {
          setRecentSettings([]);
        }
      }
    };

    // Listen for custom events from same-tab changes
    const handleCustomEvent = () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            const validSettings = parsed.filter(isSavedWiFiSetting);
            setRecentSettings(validSettings);
          }
        } else {
          setRecentSettings([]);
        }
      } catch (error) {
        console.error('Error handling custom event:', error);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener(CUSTOM_EVENT_NAME, handleCustomEvent);
    
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(CUSTOM_EVENT_NAME, handleCustomEvent);
    };
  }, []);

  const saveSetting = useCallback((ssid: string, wpaKey: string) => {
    if (!ssid.trim()) return;

    const now = Date.now();
    const trimmedSsid = ssid.trim();
    const trimmedWpaKey = wpaKey.trim();

    setRecentSettings(prev => {
      // Check if this exact setting already exists
      const existingIndex = prev.findIndex(s => s.ssid === trimmedSsid && s.wpaKey === trimmedWpaKey);
      
      let updatedSettings;
      if (existingIndex >= 0) {
        // Update existing setting with new lastUsedAt
        updatedSettings = [...prev];
        updatedSettings[existingIndex] = {
          ...updatedSettings[existingIndex],
          lastUsedAt: now
        };
      } else {
        // Add new setting
        const newSetting: SavedWiFiSetting = {
          ssid: trimmedSsid,
          wpaKey: trimmedWpaKey,
          createdAt: now,
          lastUsedAt: now,
        };
        updatedSettings = [newSetting, ...prev];
      }

      // Sort by lastUsedAt (most recent first) and limit to MAX_RECENT_SETTINGS
      const sortedSettings = updatedSettings
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, MAX_RECENT_SETTINGS);

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(sortedSettings));
        // Dispatch custom event to notify other components in the same tab
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENT_NAME));
      } catch (error) {
        console.error('Error saving WiFi settings:', error);
      }

      return sortedSettings;
    });
  }, []);

  const removeSetting = useCallback((ssid: string, wpaKey: string) => {
    setRecentSettings(prev => {
      const updatedSettings = prev.filter(s => !(s.ssid === ssid && s.wpaKey === wpaKey));
      
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedSettings));
        // Dispatch custom event to notify other components in the same tab
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENT_NAME));
      } catch (error) {
        console.error('Error removing WiFi setting:', error);
      }

      return updatedSettings;
    });
  }, []);

  const clearSettings = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      setRecentSettings([]);
      // Dispatch custom event to notify other components in the same tab
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENT_NAME));
    } catch (error) {
      console.error('Error clearing WiFi settings:', error);
    }
  }, []);

  return {
    recentSettings,
    saveSetting,
    removeSetting,
    clearSettings,
  };
}
