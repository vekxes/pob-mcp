export type BrowserSessionStatus = 'connected' | 'disconnected' | 'unavailable';

export interface BrowserTradeSession {
  fetch(url: string, options: RequestInit): Promise<Response>;
  openSocket(url: string): WebSocket;
  getStatus(): Promise<BrowserSessionStatus>;
  openLogin(): void;
  clear(): Promise<void>;
  onChange(callback: () => void): () => void;
}
