// context/ThemeContext.jsx — app-wide dark mode, written to `data-theme` on
// the document root. Adapted from the banking demo's version (same shape),
// just its own localStorage key.
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

const ThemeContext = createContext(null);

export const THEME_STORAGE_KEY = 'ai_gateway_client_dark_mode';

// null = no choice yet, so follow the system setting (prefers-color-scheme).
function readStoredDarkMode() {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === null ? null : v === 'true';
  } catch {
    return null;
  }
}

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

export function ThemeProvider({ children }) {
  const [choice, setChoice] = useState(readStoredDarkMode);
  const darkMode = choice ?? systemPrefersDark();

  useEffect(() => {
    const root = document.documentElement;
    if (choice === null) {
      // No explicit choice: let standalone-ui.css follow the system setting.
      root.removeAttribute('data-theme');
      return;
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, String(choice));
    } catch {
      // Private mode / storage disabled — the attribute below still applies
      // for this session, the choice just doesn't survive a reload.
    }
    root.setAttribute('data-theme', choice ? 'dark' : 'light');
  }, [choice]);

  const setDarkMode = useCallback((v) => setChoice(v), []);
  const toggleDarkMode = useCallback(() => setChoice(!darkMode), [darkMode]);

  const value = useMemo(() => ({ darkMode, setDarkMode, toggleDarkMode }), [darkMode, toggleDarkMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const INERT_THEME = Object.freeze({ darkMode: false, setDarkMode: () => {}, toggleDarkMode: () => {} });

export function useThemeOptional() {
  return useContext(ThemeContext) || INERT_THEME;
}
