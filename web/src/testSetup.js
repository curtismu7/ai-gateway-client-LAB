// vitest setup: the jest-dom matchers (toBeInTheDocument, ...) and cleanup of every rendered tree, which the vendored
// gateway-trace test relies on (it does not use vitest globals, so Testing Library cannot register the cleanup itself).
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());
