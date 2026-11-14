import * as p from "@clack/prompts";

export function ensure<T>(value: T): Exclude<T, symbol> {
  if (typeof value === "symbol") {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

/**
 * Prompts need a real terminal on both ends. When staryu runs from a script,
 * CI job or piped output, callers should fall back to saved defaults instead
 * of waiting for input that will never arrive.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export interface Progress {
  update: (message: string) => void;
  stop: (message?: string) => void;
  fail: (message: string) => void;
}

/**
 * Animated spinner on interactive terminals. When output is piped (CI, logs),
 * fall back to plain lines so the log does not fill with spinner frames.
 */
export function createProgress(initial: string): Progress {
  const interactive = Boolean(process.stdout.isTTY);

  if (!interactive) {
    let last = initial;
    console.log(initial);
    return {
      update: (message: string) => {
        if (message !== last) {
          last = message;
          console.log(message);
        }
      },
      stop: (message?: string) => {
        if (message) {
          console.log(message);
        }
      },
      fail: (message: string) => {
        console.error(message);
      },
    };
  }

  const spinner = p.spinner();
  spinner.start(initial);
  return {
    update: (message: string) => spinner.message(message),
    stop: (message?: string) => spinner.stop(message ?? "Done."),
    fail: (message: string) => spinner.stop(message),
  };
}

export { p };
