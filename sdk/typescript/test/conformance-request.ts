export type ParsedConformanceRequest =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface JsonScanner {
  readonly text: string;
  index: number;
  duplicateKey: boolean;
}

export function parseConformanceRequest(request: unknown): ParsedConformanceRequest {
  if (typeof request !== "string") {
    return {
      ok: true,
      value: request,
    };
  }

  const scanner: JsonScanner = {
    duplicateKey: false,
    index: 0,
    text: request,
  };

  if (!scanJsonValue(scanner)) {
    return rejectRequest("raw JSON request is malformed");
  }
  skipWhitespace(scanner);
  if (scanner.index !== scanner.text.length) {
    return rejectRequest("raw JSON request contains trailing data");
  }
  if (scanner.duplicateKey) {
    return rejectRequest("raw JSON request contains a duplicate object key");
  }

  try {
    return {
      ok: true,
      value: JSON.parse(request) as unknown,
    };
  } catch {
    return rejectRequest("raw JSON request is malformed");
  }
}

function scanJsonValue(scanner: JsonScanner): boolean {
  skipWhitespace(scanner);
  const char = peek(scanner);

  if (char === "{") {
    return scanJsonObject(scanner);
  }
  if (char === "[") {
    return scanJsonArray(scanner);
  }
  if (char === "\"") {
    return consumeJsonString(scanner) !== undefined;
  }
  if (char === "t") {
    return consumeLiteral(scanner, "true");
  }
  if (char === "f") {
    return consumeLiteral(scanner, "false");
  }
  if (char === "n") {
    return consumeLiteral(scanner, "null");
  }

  return scanJsonNumber(scanner);
}

function scanJsonObject(scanner: JsonScanner): boolean {
  if (!consumeChar(scanner, "{")) {
    return false;
  }
  skipWhitespace(scanner);

  const seen = new Set<string>();
  if (consumeChar(scanner, "}")) {
    return true;
  }

  for (;;) {
    skipWhitespace(scanner);
    const key = consumeJsonString(scanner);

    if (key === undefined) {
      return false;
    }
    if (seen.has(key)) {
      scanner.duplicateKey = true;
    } else {
      seen.add(key);
    }

    skipWhitespace(scanner);
    if (!consumeChar(scanner, ":") || !scanJsonValue(scanner)) {
      return false;
    }
    skipWhitespace(scanner);

    if (consumeChar(scanner, "}")) {
      return true;
    }
    if (!consumeChar(scanner, ",")) {
      return false;
    }
  }
}

function scanJsonArray(scanner: JsonScanner): boolean {
  if (!consumeChar(scanner, "[")) {
    return false;
  }
  skipWhitespace(scanner);

  if (consumeChar(scanner, "]")) {
    return true;
  }

  for (;;) {
    if (!scanJsonValue(scanner)) {
      return false;
    }
    skipWhitespace(scanner);

    if (consumeChar(scanner, "]")) {
      return true;
    }
    if (!consumeChar(scanner, ",")) {
      return false;
    }
  }
}

function consumeJsonString(scanner: JsonScanner): string | undefined {
  if (!consumeChar(scanner, "\"")) {
    return undefined;
  }

  const start = scanner.index - 1;
  let escaped = false;

  while (scanner.index < scanner.text.length) {
    const char = scanner.text.charAt(scanner.index);
    scanner.index += 1;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      try {
        const parsed: unknown = JSON.parse(scanner.text.slice(start, scanner.index));

        return typeof parsed === "string" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

function scanJsonNumber(scanner: JsonScanner): boolean {
  const start = scanner.index;
  const numberChars = "-+0123456789.eE";

  while (scanner.index < scanner.text.length) {
    const char = scanner.text.charAt(scanner.index);

    if (!numberChars.includes(char)) {
      break;
    }
    scanner.index += 1;
  }

  if (scanner.index === start) {
    return false;
  }

  try {
    JSON.parse(scanner.text.slice(start, scanner.index));
    return true;
  } catch {
    return false;
  }
}

function consumeLiteral(scanner: JsonScanner, literal: string): boolean {
  if (!scanner.text.startsWith(literal, scanner.index)) {
    return false;
  }

  scanner.index += literal.length;
  return true;
}

function consumeChar(scanner: JsonScanner, char: string): boolean {
  if (peek(scanner) !== char) {
    return false;
  }

  scanner.index += 1;
  return true;
}

function skipWhitespace(scanner: JsonScanner): void {
  while (scanner.index < scanner.text.length) {
    const char = scanner.text.charAt(scanner.index);

    if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") {
      return;
    }
    scanner.index += 1;
  }
}

function peek(scanner: JsonScanner): string | undefined {
  return scanner.text.at(scanner.index);
}

function rejectRequest(reason: string): Extract<ParsedConformanceRequest, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  };
}
