// context/ThemeContext.jsx — app-wide theme, written to `data-theme` on
// the document root. The picker only sets data-theme; the shared stylesheet
// does the rest ("auto" follows the system setting).
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

const ThemeContext = createContext(null);

export const THEME_STORAGE_KEY = 'ai_gateway_client.theme';
const THEMES = ['auto', 'light', 'dark'];

function readStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return THEMES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(readStoredTheme);

  useEffect(() => {
    const root = document.documentElement;
    try {
      if (theme === 'auto') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Private mode / storage disabled — the attribute below still applies
      // for this session, the choice just doesn't survive a reload.
    }
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const INERT_THEME = Object.freeze({ theme: 'auto', setTheme: () => {} });

export function useThemeOptional() {
  return useContext(ThemeContext) || INERT_THEME;
}
