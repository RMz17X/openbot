/**
 * Zero-overhead no-op stub for @openpanel/web in standalone WebUI.
 * Completely eliminates 357KB analytics bundle, DOM SessionReplay hooks,
 * MutationObserver trees, and remote background beacons.
 */
export class OpenPanelBase {
  track(_name: string, _properties?: unknown): void {}
  identify(_properties?: unknown): void {}
  clear(): void {}
  setGlobalProperties(_properties?: unknown): void {}
  increment(_name: string, _value?: number): void {}
  decrement(_name: string, _value?: number): void {}
}

export interface OpenPanelOptions {
  apiUrl?: string;
  clientId?: string;
  trackOutgoingLinks?: boolean;
  trackScreenViews?: boolean;
}

export default OpenPanelBase;
