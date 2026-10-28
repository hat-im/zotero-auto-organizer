const STREAM_GLOBALS = [
  "TransformStream",
  "ReadableStream",
  "WritableStream",
  "TextDecoderStream",
  "TextEncoderStream",
];

/**
 * Copy web stream globals and console that Zotero's plugin sandbox lacks from the main window.
 * Must run after the main window exists and before libraries that use them load.
 * @param win - The Zotero main window
 */
export function exposeWebGlobals(win: Window): void {
  const target = globalThis as Record<string, any>;
  for (const name of STREAM_GLOBALS) {
    if (typeof target[name] === "undefined") {
      target[name] = (win as any)[name];
    }
  }
  // The AI SDK reports warnings through console, which the sandbox lacks
  if (typeof target.console === "undefined") {
    target.console = (win as any).console;
  }
}
