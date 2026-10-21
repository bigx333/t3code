export const REDACTED = "[REDACTED]";
export const MIN_REDACTED_SECRET_LENGTH = 4;

export interface SecretRedactor {
  readonly isEmpty: boolean;
  redactText(text: string): string;
  redactValue<T>(value: T, options?: { readonly holdback: boolean }): T;
}

export interface SecretStreamRedactor {
  readonly hasPending: boolean;
  push(chunk: string): string;
  flush(redactor?: SecretRedactor): string;
}

const structuralKeys =
  /^(?:type|kind|status|role|driver|id|cwd|path|hookEventName)$|(?:Id|Ids|Ref|Path)$/;

const needlesByRedactor = new WeakMap<
  SecretRedactor,
  { needles: ReadonlyArray<string>; pattern: RegExp }
>();

export const emptySecretRedactor: SecretRedactor = {
  isEmpty: true,
  redactText: (text) => text,
  redactValue: (value) => value,
};

export function makeSecretRedactor(values: Iterable<string>): SecretRedactor {
  const needles = new Set<string>();
  for (const value of values) {
    if (value.length < MIN_REDACTED_SECRET_LENGTH) continue;
    needles.add(value);
    needles.add(JSON.stringify(value).slice(1, -1));
    // A saved value may contain an unpaired UTF-16 surrogate.
    try {
      needles.add(encodeURIComponent(value));
    } catch {
      continue;
    }
  }
  if (needles.size === 0) return emptySecretRedactor;
  const sorted = [...needles].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    sorted.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  const redactText = (text: string) => text.replace(pattern, () => REDACTED);
  const walk = (value: unknown, holdback: boolean): unknown => {
    if (typeof value === "string") {
      const held = holdback ? heldPrefixLength(value, sorted, pattern) : 0;
      return redactText(held === 0 ? value : value.slice(0, -held));
    }
    if (Array.isArray(value)) {
      let copy: Array<unknown> | undefined;
      for (let index = 0; index < value.length; index++) {
        const next = walk(value[index], holdback);
        if (!Object.is(next, value[index])) {
          copy ??= value.slice();
          copy[index] = next;
        }
      }
      return copy ?? value;
    }
    if (typeof value !== "object" || value === null) return value;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    let copy: Record<string, unknown> | undefined;
    for (const [key, leaf] of Object.entries(value)) {
      if (structuralKeys.test(key)) continue;
      let nextKey = redactText(key);
      const next = walk(leaf, holdback);
      if (nextKey !== key || !Object.is(next, leaf)) {
        copy ??= { ...value };
        if (nextKey !== key) {
          const base = nextKey;
          let suffix = 0;
          while (Object.hasOwn(value, nextKey) || Object.hasOwn(copy, nextKey)) {
            nextKey = `${base}_${++suffix}`;
          }
          delete copy[key];
        }
        Object.defineProperty(copy, nextKey, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return copy ?? value;
  };
  const redactor: SecretRedactor = {
    isEmpty: false,
    redactText,
    redactValue: <T>(value: T, options?: { readonly holdback: boolean }): T =>
      walk(value, options?.holdback === true) as T,
  };
  needlesByRedactor.set(redactor, { needles: sorted, pattern });
  return redactor;
}

function heldPrefixLength(text: string, needles: ReadonlyArray<string>, pattern?: RegExp): number {
  let held = 0;
  // Only positions matching a needle's first character can start a held
  // tail, so output floods stay cheap even with multi-kilobyte secrets.
  for (const needle of needles) {
    const first = needle.charCodeAt(0);
    for (let start = Math.max(0, text.length - needle.length + 1); start < text.length; start++) {
      if (text.length - start <= held) break;
      if (text.charCodeAt(start) === first && needle.startsWith(text.slice(start))) {
        held = text.length - start;
        break;
      }
    }
  }
  if (held > 0 && pattern !== undefined) {
    const boundary = text.length - held;
    pattern.lastIndex = 0;
    // Keep a complete match intact if the candidate prefix starts inside it.
    for (let match; (match = pattern.exec(text)) !== null;) {
      if (match.index >= boundary) break;
      if (match.index + match[0].length > boundary) {
        held = text.length - match.index;
        break;
      }
    }
    pattern.lastIndex = 0;
  }
  return held;
}

const emptyStreamRedactor: SecretStreamRedactor = {
  hasPending: false,
  push: (chunk) => chunk,
  flush: () => "",
};

export function makeSecretStreamRedactor(redactor: SecretRedactor): SecretStreamRedactor {
  if (redactor.isEmpty) return emptyStreamRedactor;
  const config = needlesByRedactor.get(redactor);
  const needles = config?.needles ?? [];
  let pending = "";
  return {
    get hasPending() {
      return pending.length > 0;
    },
    push(chunk) {
      const text = pending + chunk;
      const held = heldPrefixLength(text, needles, config?.pattern);
      pending = held === 0 ? "" : text.slice(-held);
      return redactor.redactText(held === 0 ? text : text.slice(0, -held));
    },
    flush(currentRedactor = redactor) {
      const text = currentRedactor.redactText(pending);
      pending = "";
      return text;
    },
  };
}
