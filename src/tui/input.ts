import { useStdin } from "ink";
import { useEffect, useRef } from "react";
import { isPrintableInput } from "./utils.js";

const ESC = "\u001B";
const BACKSLASH_ENTER_TIMEOUT_MS = 5;
const ESC_TIMEOUT_MS = 50;
const FAST_RETURN_TIMEOUT_MS = 30;

export interface TextBufferState {
  value: string;
  cursor: number;
}

export interface TerminalKey {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  super: boolean;
}

function clampCursor(value: string, cursor: number): number {
  return Math.max(0, Math.min(cursor, value.length));
}

export function createBufferState(value: string, cursor = value.length): TextBufferState {
  return {
    value,
    cursor: clampCursor(value, cursor),
  };
}

export function insertIntoBuffer(buffer: TextBufferState, text: string): TextBufferState {
  const nextValue =
    `${buffer.value.slice(0, buffer.cursor)}${text}${buffer.value.slice(buffer.cursor)}`;
  return createBufferState(nextValue, buffer.cursor + text.length);
}

export function deleteBackwardChar(buffer: TextBufferState): TextBufferState {
  if (buffer.cursor <= 0) {
    return buffer;
  }

  const nextValue =
    `${buffer.value.slice(0, buffer.cursor - 1)}${buffer.value.slice(buffer.cursor)}`;
  return createBufferState(nextValue, buffer.cursor - 1);
}

export function deleteForwardChar(buffer: TextBufferState): TextBufferState {
  if (buffer.cursor >= buffer.value.length) {
    return buffer;
  }

  const nextValue =
    `${buffer.value.slice(0, buffer.cursor)}${buffer.value.slice(buffer.cursor + 1)}`;
  return createBufferState(nextValue, buffer.cursor);
}

export function deletePreviousWord(buffer: TextBufferState): TextBufferState {
  if (buffer.cursor <= 0) {
    return buffer;
  }

  let nextCursor = buffer.cursor;
  while (nextCursor > 0 && /\s/.test(buffer.value[nextCursor - 1]!)) {
    nextCursor -= 1;
  }
  while (nextCursor > 0 && !/\s/.test(buffer.value[nextCursor - 1]!)) {
    nextCursor -= 1;
  }

  const nextValue =
    `${buffer.value.slice(0, nextCursor)}${buffer.value.slice(buffer.cursor)}`;
  return createBufferState(nextValue, nextCursor);
}

export function deleteToLineStart(buffer: TextBufferState): TextBufferState {
  if (buffer.cursor <= 0) {
    return buffer;
  }

  const lineStart = buffer.value.lastIndexOf("\n", buffer.cursor - 1) + 1;
  const nextValue =
    `${buffer.value.slice(0, lineStart)}${buffer.value.slice(buffer.cursor)}`;
  return createBufferState(nextValue, lineStart);
}

export function deleteToLineEnd(buffer: TextBufferState): TextBufferState {
  const nextBreak = buffer.value.indexOf("\n", buffer.cursor);
  const lineEnd = nextBreak >= 0 ? nextBreak : buffer.value.length;
  const nextValue =
    `${buffer.value.slice(0, buffer.cursor)}${buffer.value.slice(lineEnd)}`;
  return createBufferState(nextValue, buffer.cursor);
}

export function moveCursorLeft(buffer: TextBufferState): TextBufferState {
  return createBufferState(buffer.value, buffer.cursor - 1);
}

export function moveCursorRight(buffer: TextBufferState): TextBufferState {
  return createBufferState(buffer.value, buffer.cursor + 1);
}

export function moveCursorToStart(buffer: TextBufferState): TextBufferState {
  return createBufferState(buffer.value, 0);
}

export function moveCursorToEnd(buffer: TextBufferState): TextBufferState {
  return createBufferState(buffer.value, buffer.value.length);
}

function createKey(
  name: string,
  sequence: string,
  modifiers?: Partial<Omit<TerminalKey, "name" | "sequence">>,
): TerminalKey {
  return {
    name,
    sequence,
    ctrl: modifiers?.ctrl ?? false,
    meta: modifiers?.meta ?? false,
    shift: modifiers?.shift ?? false,
    super: modifiers?.super ?? false,
  };
}

// Escape sequence lookup table (keys without ESC prefix)
const KEY_INFO_MAP: Record<string, { name: string; shift?: boolean; ctrl?: boolean }> = {
  "[200~": { name: "paste-start" },
  "[201~": { name: "paste-end" },
  "[[A": { name: "f1" },
  "[[B": { name: "f2" },
  "[[C": { name: "f3" },
  "[[D": { name: "f4" },
  "[[E": { name: "f5" },
  "[1~": { name: "home" },
  "[2~": { name: "insert" },
  "[3~": { name: "delete" },
  "[4~": { name: "end" },
  "[5~": { name: "pageup" },
  "[6~": { name: "pagedown" },
  "[7~": { name: "home" },
  "[8~": { name: "end" },
  "[11~": { name: "f1" },
  "[12~": { name: "f2" },
  "[13~": { name: "f3" },
  "[14~": { name: "f4" },
  "[15~": { name: "f5" },
  "[17~": { name: "f6" },
  "[18~": { name: "f7" },
  "[19~": { name: "f8" },
  "[20~": { name: "f9" },
  "[21~": { name: "f10" },
  "[23~": { name: "f11" },
  "[24~": { name: "f12" },
  "[A": { name: "up" },
  "[B": { name: "down" },
  "[C": { name: "right" },
  "[D": { name: "left" },
  "[E": { name: "clear" },
  "[F": { name: "end" },
  "[H": { name: "home" },
  "[P": { name: "f1" },
  "[Q": { name: "f2" },
  "[R": { name: "f3" },
  "[S": { name: "f4" },
  OA: { name: "up" },
  OB: { name: "down" },
  OC: { name: "right" },
  OD: { name: "left" },
  OE: { name: "clear" },
  OF: { name: "end" },
  OH: { name: "home" },
  OP: { name: "f1" },
  OQ: { name: "f2" },
  OR: { name: "f3" },
  OS: { name: "f4" },
  OZ: { name: "tab", shift: true },
  "[a": { name: "up", shift: true },
  "[b": { name: "down", shift: true },
  "[c": { name: "right", shift: true },
  "[d": { name: "left", shift: true },
  "[e": { name: "clear", shift: true },
  "[2$": { name: "insert", shift: true },
  "[3$": { name: "delete", shift: true },
  "[5$": { name: "pageup", shift: true },
  "[6$": { name: "pagedown", shift: true },
  "[7$": { name: "home", shift: true },
  "[8$": { name: "end", shift: true },
  "[Z": { name: "tab", shift: true },
  Oa: { name: "up", ctrl: true },
  Ob: { name: "down", ctrl: true },
  Oc: { name: "right", ctrl: true },
  Od: { name: "left", ctrl: true },
  Oe: { name: "clear", ctrl: true },
  "[2^": { name: "insert", ctrl: true },
  "[3^": { name: "delete", ctrl: true },
  "[5^": { name: "pageup", ctrl: true },
  "[6^": { name: "pagedown", ctrl: true },
  "[7^": { name: "home", ctrl: true },
  "[8^": { name: "end", ctrl: true },
};

// Kitty Keyboard Protocol (CSI u) code mappings
const KITTY_CODE_MAP: Record<number, { name: string; sequence?: string }> = {
  2: { name: "insert" },
  3: { name: "delete" },
  5: { name: "pageup" },
  6: { name: "pagedown" },
  9: { name: "tab" },
  13: { name: "return" },
  14: { name: "up" },
  15: { name: "down" },
  16: { name: "right" },
  17: { name: "left" },
  27: { name: "escape" },
  32: { name: "space", sequence: " " },
  127: { name: "backspace" },
  57358: { name: "capslock" },
  57359: { name: "scrolllock" },
  57360: { name: "numlock" },
  57361: { name: "printscreen" },
  57362: { name: "pausebreak" },
  57409: { name: "numpad_decimal", sequence: "." },
  57410: { name: "numpad_divide", sequence: "/" },
  57411: { name: "numpad_multiply", sequence: "*" },
  57412: { name: "numpad_subtract", sequence: "-" },
  57413: { name: "numpad_add", sequence: "+" },
  57414: { name: "return" },
  57416: { name: "numpad_separator", sequence: "," },
  ...Object.fromEntries(
    Array.from({ length: 23 }, (_, i) => [302 + i, { name: `f${13 + i}` }]),
  ),
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [
      57399 + i,
      { name: `numpad${i}`, sequence: String(i) },
    ]),
  ),
};

const NUMPAD_MAP: Record<string, string> = {
  Oj: "*", Ok: "+", Om: "-", Oo: "/",
  Op: "0", Oq: "1", Or: "2", Os: "3", Ot: "4",
  Ou: "5", Ov: "6", Ow: "7", Ox: "8", Oy: "9",
  On: ".",
};

const MAC_ALT_KEY_CHARACTER_MAP: Record<string, string> = {
  "\u222B": "b", // ∫ — back one word
  "\u0192": "f", // ƒ — forward one word
  "\u00B5": "m", // µ
  "\u03A9": "z", // Ω — Option+z
  "\u00B8": "Z", // ¸ — Option+Shift+z
  "\u2202": "d", // ∂ — delete word forward
};

const kUTF16SurrogateThreshold = 0x10000;
function charLengthAt(str: string, i: number): number {
  if (str.length <= i) return 1;
  const code = str.codePointAt(i);
  return code !== undefined && code >= kUTF16SurrogateThreshold ? 2 : 1;
}

type KeyHandler = (key: TerminalKey) => void;

/**
 * Generator that translates raw characters into TerminalKey events.
 * Feed characters one-by-one; send empty string "" to signal ESC timeout.
 */
function* emitKeys(keypressHandler: KeyHandler): Generator<void, void, string> {
  const lang = process.env["LANG"] || "";
  const lcAll = process.env["LC_ALL"] || "";
  const isGreek = lang.startsWith("el") || lcAll.startsWith("el");

  while (true) {
    let ch = yield;
    let sequence = ch;
    let escaped = false;

    let name: string | undefined = undefined;
    let shift = false;
    let meta = false;
    let ctrl = false;
    let sup = false;
    let code: string | undefined = undefined;

    if (ch === ESC) {
      escaped = true;
      ch = yield;
      sequence += ch;
      if (ch === ESC) {
        ch = yield;
        sequence += ch;
      }
    }

    if (escaped && (ch === "O" || ch === "[" || ch === "]")) {
      code = ch;
      let modifier = 0;

      if (ch === "]") {
        // OSC sequence — read and discard
        while (true) {
          const next = yield;
          if (next === "" || next === "\u0007") break;
          if (next === ESC) {
            const afterEsc = yield;
            if (afterEsc === "" || afterEsc === "\\") break;
            continue;
          }
        }
        continue;
      } else if (ch === "O") {
        ch = yield;
        sequence += ch;
        if (ch >= "0" && ch <= "9") {
          modifier = Number.parseInt(ch, 10) - 1;
          ch = yield;
          sequence += ch;
        }
        code += ch;
      } else if (ch === "[") {
        ch = yield;
        sequence += ch;
        if (ch === "[") {
          code += ch;
          ch = yield;
          sequence += ch;
        }

        const cmdStart = sequence.length - 1;

        while (ch >= "0" && ch <= "9") {
          ch = yield;
          sequence += ch;
        }

        if (ch === ";") {
          while (ch === ";") {
            ch = yield;
            sequence += ch;
            while (ch >= "0" && ch <= "9") {
              ch = yield;
              sequence += ch;
            }
          }
        } else if (ch === "<") {
          // SGR mouse — discard
          ch = yield;
          sequence += ch;
          while (ch === "" || ch === ";" || (ch >= "0" && ch <= "9")) {
            ch = yield;
            sequence += ch;
          }
          continue;
        } else if (ch === "M") {
          // X11 mouse — read 3 chars and discard
          yield; yield; yield;
          continue;
        }

        const cmd = sequence.slice(cmdStart);
        let match;

        if ((match = /^(\d+)(?:;(\d+))?(?:;(\d+))?([~^$u])$/.exec(cmd))) {
          if (match[1] === "27" && match[3] && match[4] === "~") {
            code += match[3] + "u";
            modifier = Number.parseInt(match[2] ?? "1", 10) - 1;
          } else {
            code += match[1]! + match[4]!;
            modifier = Number.parseInt(match[2] ?? "1", 10) - 1;
          }
        } else if ((match = /^(\d+)?(?:;(\d+))?([A-Za-z])$/.exec(cmd))) {
          code += match[3];
          modifier = Number.parseInt(match[2] ?? match[1] ?? "1", 10) - 1;
        } else {
          code += cmd;
        }
      }

      shift = !!(modifier & 1);
      meta = !!(modifier & 2);
      ctrl = !!(modifier & 4);
      sup = !!(modifier & 8);

      const keyInfo = KEY_INFO_MAP[code!];
      if (keyInfo) {
        name = keyInfo.name;
        if (keyInfo.shift) shift = true;
        if (keyInfo.ctrl) ctrl = true;
        if (name === "space" && !ctrl && !sup && !meta) {
          sequence = " ";
        }
      } else {
        const numpadChar = NUMPAD_MAP[code!];
        if (numpadChar) {
          name = numpadChar;
          if (!ctrl && !sup && !meta) sequence = numpadChar;
        } else {
          name = "undefined";
          if (code!.endsWith("u") || code!.endsWith("~")) {
            const codeNumber = Number.parseInt(code!.slice(1, -1), 10);
            const mapped = KITTY_CODE_MAP[codeNumber];
            if (mapped) {
              name = mapped.name;
              if (mapped.sequence && !ctrl && !sup && !meta) {
                sequence = mapped.sequence;
              }
            } else if (
              codeNumber >= 33 &&
              codeNumber <= 0x10ffff &&
              (codeNumber < 0xd800 || codeNumber > 0xdfff)
            ) {
              const char = String.fromCodePoint(codeNumber);
              name = char.toLowerCase();
              if (char !== name) shift = true;
              if (!ctrl && !sup && !meta) sequence = char;
            }
          }
        }
      }
    } else if (ch === "\r") {
      name = "return";
      meta = escaped;
    } else if (escaped && ch === "\n") {
      name = "return";
      meta = escaped;
    } else if (ch === "\t") {
      name = "tab";
      meta = escaped;
    } else if (ch === "\b" || ch === "\x7f") {
      name = "backspace";
      meta = escaped;
    } else if (ch === ESC) {
      name = "escape";
      meta = escaped;
    } else if (ch === " ") {
      name = "space";
      meta = escaped;
      sequence = " ";
    } else if (!escaped && ch <= "\x1a") {
      name = String.fromCharCode(ch.charCodeAt(0) + "a".charCodeAt(0) - 1);
      ctrl = true;
    } else if (/^[0-9A-Za-z]$/.exec(ch) !== null) {
      name = ch.toLowerCase();
      shift = /^[A-Z]$/.exec(ch) !== null;
      meta = escaped;
    } else if (MAC_ALT_KEY_CHARACTER_MAP[ch]) {
      if (isGreek && ch === "\u03A9") {
        // don't remap Omega for Greek users
      } else {
        const mapped = MAC_ALT_KEY_CHARACTER_MAP[ch]!;
        name = mapped.toLowerCase();
        shift = mapped !== name;
        meta = true;
      }
    } else if (sequence === `${ESC}${ESC}`) {
      name = "escape";
      meta = false;
      keypressHandler(createKey("escape", ESC));
    } else if (escaped) {
      name = ch.length ? undefined : "escape";
      meta = ch.length > 0;
    } else {
      name = ch.toLowerCase();
      if (ch !== name) shift = true;
    }

    if (
      (sequence.length !== 0 && (name !== undefined || escaped)) ||
      charLengthAt(sequence, 0) === sequence.length
    ) {
      keypressHandler({
        name: name || "",
        sequence,
        ctrl,
        meta,
        shift,
        super: sup,
      });
    }
  }
}

function createDataListener(keypressHandler: KeyHandler) {
  const parser = emitKeys(keypressHandler);
  parser.next();

  let timeoutId: NodeJS.Timeout;
  return (data: string) => {
    clearTimeout(timeoutId);
    for (const char of data) {
      parser.next(char);
    }
    if (data.length !== 0) {
      timeoutId = setTimeout(() => parser.next(""), ESC_TIMEOUT_MS);
    }
  };
}

function bufferBackslashEnter(keypressHandler: KeyHandler): KeyHandler {
  const bufferer = (function* (): Generator<void, void, TerminalKey | null> {
    while (true) {
      const key = yield;
      if (key == null) continue;
      if (key.sequence !== "\\") {
        keypressHandler(key);
        continue;
      }
      const tid = setTimeout(() => bufferer.next(null), BACKSLASH_ENTER_TIMEOUT_MS);
      const nextKey = yield;
      clearTimeout(tid);
      if (nextKey === null) {
        keypressHandler(key);
      } else if (nextKey.name === "return") {
        keypressHandler({ ...nextKey, shift: true });
      } else {
        keypressHandler(key);
        keypressHandler(nextKey);
      }
    }
  })();
  bufferer.next();
  return (key: TerminalKey) => { bufferer.next(key); };
}

function bufferFastReturn(keypressHandler: KeyHandler): KeyHandler {
  let lastInsertableTime = 0;
  return (key: TerminalKey) => {
    const now = Date.now();
    if (key.name === "return" && now - lastInsertableTime <= FAST_RETURN_TIMEOUT_MS) {
      keypressHandler({ ...key, shift: true });
    } else {
      keypressHandler(key);
    }
    lastInsertableTime = isPrintableInput(key.sequence, key) ? now : 0;
  };
}

function bufferPaste(keypressHandler: KeyHandler): KeyHandler {
  const PASTE_TIMEOUT = 30_000;
  const bufferer = (function* (): Generator<void, void, TerminalKey | null> {
    while (true) {
      let key = yield;
      if (key === null) continue;
      if (key.name !== "paste-start") {
        keypressHandler(key);
        continue;
      }
      let buf = "";
      while (true) {
        const tid = setTimeout(() => bufferer.next(null), PASTE_TIMEOUT);
        key = yield;
        clearTimeout(tid);
        if (key === null || key.name === "paste-end") break;
        buf += key.sequence;
      }
      if (buf.length > 0) {
        keypressHandler({ name: "paste", sequence: buf, ctrl: false, meta: false, shift: false, super: false });
      }
    }
  })();
  bufferer.next();
  return (key: TerminalKey) => { bufferer.next(key); };
}

export function isEnterKey(key: TerminalKey): boolean {
  return key.name === "return";
}

export function isEscapeKey(key: TerminalKey): boolean {
  return key.name === "escape";
}

export function isTabKey(key: TerminalKey): boolean {
  return key.name === "tab";
}

export function isShiftTabKey(key: TerminalKey): boolean {
  return key.name === "tab" && key.shift;
}

export function getEditedBuffer(buffer: TextBufferState, key: TerminalKey): TextBufferState | null {
  if (key.name === "paste") {
    return insertIntoBuffer(buffer, key.sequence);
  }

  if (key.name === "backspace") {
    if (key.meta || (key.ctrl && key.sequence === "\b")) {
      return deletePreviousWord(buffer);
    }
    if (key.super) {
      return deleteToLineStart(buffer);
    }
    return deleteBackwardChar(buffer);
  }

  if (key.name === "delete") {
    if (key.meta) {
      return deletePreviousWord(buffer);
    }
    if (key.super) {
      return deleteToLineStart(buffer);
    }
    return deleteForwardChar(buffer);
  }

  if (key.ctrl && key.name === "w") {
    return deletePreviousWord(buffer);
  }

  if (key.ctrl && key.name === "u") {
    return deleteToLineStart(buffer);
  }

  if (key.ctrl && key.name === "d") {
    return deleteForwardChar(buffer);
  }

  if (key.ctrl && key.name === "k") {
    return deleteToLineEnd(buffer);
  }

  if (key.ctrl && key.name === "a") {
    return moveCursorToStart(buffer);
  }

  if (key.ctrl && key.name === "e") {
    return moveCursorToEnd(buffer);
  }

  if (key.name === "left") {
    return moveCursorLeft(buffer);
  }

  if (key.name === "right") {
    return moveCursorRight(buffer);
  }

  if (key.name === "home") {
    return moveCursorToStart(buffer);
  }

  if (key.name === "end") {
    return moveCursorToEnd(buffer);
  }

  if (isPrintableInput(key.sequence, key)) {
    return insertIntoBuffer(buffer, key.sequence);
  }

  return null;
}

export function useTerminalKeypress(
  onKeypress: (key: TerminalKey) => void,
  options?: { enabled?: boolean },
) {
  const { stdin } = useStdin();
  const handlerRef = useRef(onKeypress);

  useEffect(() => {
    handlerRef.current = onKeypress;
  }, [onKeypress]);

  useEffect(() => {
    if (options?.enabled === false) {
      return;
    }

    // Manage raw mode directly on process.stdin to avoid Ink's setRawMode
    // wrapper, which adds a competing 'readable' listener that conflicts
    // with our 'data' listener.
    const wasRaw = process.stdin.isRaw;
    process.stdin.setEncoding("utf8");
    if (!wasRaw && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    const emit = (key: TerminalKey) => {
      handlerRef.current(key);
    };

    const pipeline = bufferPaste(bufferBackslashEnter(bufferFastReturn(emit)));
    const dataListener = createDataListener(pipeline);

    stdin.on("data", dataListener);

    return () => {
      stdin.removeListener("data", dataListener);
      if (!wasRaw && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    };
  }, [options?.enabled, stdin]);
}
