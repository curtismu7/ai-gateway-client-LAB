// vitest setup: the jest-dom matchers (toBeInTheDocument, ...) and cleanup of every rendered tree, which the vendored
// gateway-trace test relies on (it does not use vitest globals, so Testing Library cannot register the cleanup itself).
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// React Flow measures the DOM; jsdom has no layout, so give it the few browser APIs it reads.
class RO { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver || RO;
globalThis.DOMMatrixReadOnly = globalThis.DOMMatrixReadOnly || class { constructor() { this.m22 = 1; } };
Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get() { return 200; } },
  offsetHeight: { configurable: true, get() { return 80; } },
});
