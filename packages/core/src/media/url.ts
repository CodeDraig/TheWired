// WHATWG URL without the DOM lib. Core compiles against plain ES2021, but every
// runtime it ships on provides URL: browsers and the Tauri webview, Node, and
// Hermes once react-native-url-polyfill has run. Resolved at call time — not at
// module load — so the mobile polyfill is in place whatever the import order.

export interface UrlSearchParamsLike {
  has(name: string): boolean;
  set(name: string, value: string): void;
  delete(name: string): void;
}

export interface UrlLike {
  readonly origin: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly searchParams: UrlSearchParamsLike;
  toString(): string;
}

type UrlCtor = new (input: string) => UrlLike;

/** `new URL(input)`; throws like the real constructor on an invalid URL. */
export function parseUrl(input: string): UrlLike {
  const Ctor = (globalThis as unknown as { URL: UrlCtor }).URL;
  return new Ctor(input);
}
