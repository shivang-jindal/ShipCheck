import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('shipcheck-theme', theme);
  }, [theme]);

  return (
    <button
      type="button"
      className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong px-3 text-xs font-semibold text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☼' : '◐'}</span>
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
