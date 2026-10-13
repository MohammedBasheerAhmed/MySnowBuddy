import { useEffect, useState } from 'react';
import { getSettings, saveSettings, onSettingsChanged } from '../content/storage.js';

/** Current theme ('system' | 'light' | 'dark') and a function that saves a new one. */
export function useTheme() {
  const [theme, setTheme] = useState('system');

  useEffect(() => {
    getSettings().then((s) => setTheme(s.theme));
    return onSettingsChanged((s) => setTheme(s.theme));
  }, []);

  return [theme, (value) => saveSettings({ theme: value })];
}
