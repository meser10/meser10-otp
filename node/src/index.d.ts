/** Store shared by all instances. incr must be atomic and set the expiry when it creates the key. */
export interface OtpStore {
  get(key: string): Promise<any | null>;
  set(key: string, value: any, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
}
export interface Meser10OtpOptions {
  apiKey: string;
  sender: string;
  /** Random string, at least 16 characters, the same on every instance. */
  secret: string;
  message?: string;
  codeLength?: number;
  ttlSeconds?: number;
  maxAttempts?: number;
  resendSeconds?: number;
  timeoutMs?: number;
  store?: OtpStore;
  normalizePhone?: (raw: string) => string;
  fetch?: typeof fetch;
}
export type Meser10ErrorCode = 'config' | 'invalid_phone' | 'network' | 'bad_response' | 'api_error' | 'too_soon' | 'no_code' | 'expired' | 'wrong_code' | 'locked';
export class Meser10Error extends Error {
  code: Meser10ErrorCode;
}
export class MemoryStore implements OtpStore {
  get(key: string): Promise<any | null>;
  set(key: string, value: any, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
}
export class Meser10Otp {
  constructor(options: Meser10OtpOptions);
  sendSms(phone: string, text: string): Promise<{ messageId: number }>;
  sendCode(phone: string, context?: string): Promise<{ to: string; expiresIn: number }>;
  verifyCode(phone: string, code: string, context?: string): Promise<true>;
}
export function normalizeIsraeliMobile(raw: string): string;
