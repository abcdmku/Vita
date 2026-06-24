export type SriAlgorithm = "sha256" | "sha384" | "sha512";
export type SriIntegrity = `${SriAlgorithm}-${string}`;

export interface ParsedSriIntegrity {
  readonly algorithm: SriAlgorithm;
  readonly digest: string;
  readonly byteLength: number;
  readonly value: SriIntegrity;
}

export type SriIntegrityParseResult =
  | {
      readonly ok: true;
      readonly integrity: ParsedSriIntegrity;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export function parseSriIntegrity(value: unknown): SriIntegrityParseResult {
  if (typeof value !== "string" || value === "") {
    return reject("Expected non-empty SRI integrity string.");
  }

  const separator = value.indexOf("-");

  if (separator === -1 || value.indexOf("-", separator + 1) !== -1) {
    return reject("Expected SRI integrity in algorithm-digest form.");
  }

  const algorithm = parseSriAlgorithm(value.slice(0, separator));
  const digest = value.slice(separator + 1);

  if (algorithm === undefined) {
    return reject("Expected sha256, sha384, or sha512 SRI algorithm.");
  }

  const expectedLength = sriDigestLength(algorithm);

  if (!isSriDigestToken(digest)) {
    return reject("Expected standard base64 SRI digest.");
  }

  const decodedLength = digest.includes("=")
    ? decodedPaddedBase64Length(digest)
    : decodedRawBase64Length(digest);

  if (decodedLength !== expectedLength) {
    return reject("SRI digest length does not match its algorithm.");
  }

  return {
    integrity: {
      algorithm: algorithm,
      byteLength: expectedLength,
      digest,
      value: value as SriIntegrity,
    },
    ok: true,
  };
}

export function isSriIntegrity(value: unknown): value is SriIntegrity {
  return parseSriIntegrity(value).ok;
}

function parseSriAlgorithm(value: string): SriAlgorithm | undefined {
  if (value === "sha256" || value === "sha384" || value === "sha512") {
    return value;
  }

  return undefined;
}

function sriDigestLength(algorithm: SriAlgorithm): number {
  switch (algorithm) {
    case "sha256":
      return 32;
    case "sha384":
      return 48;
    case "sha512":
      return 64;
  }
}

function isSriDigestToken(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  let padding = 0;

  for (let index = value.length - 1; index >= 0 && value.charCodeAt(index) === 61; index -= 1) {
    padding += 1;
  }

  if (padding > 2) {
    return false;
  }

  for (let index = 0; index < value.length - padding; index += 1) {
    if (base64Digit(value.charCodeAt(index)) === undefined) {
      return false;
    }
  }

  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) {
      return false;
    }
  }

  return true;
}

function decodedPaddedBase64Length(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) {
    return undefined;
  }

  let padding = 0;

  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }

  const unpaddedLength = value.length - padding;

  for (let index = 0; index < unpaddedLength; index += 1) {
    if (base64Digit(value.charCodeAt(index)) === undefined) {
      return undefined;
    }
  }

  for (let index = unpaddedLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) {
      return undefined;
    }
  }

  if (padding > 0 && unpaddedLength < 2) {
    return undefined;
  }

  return (value.length / 4) * 3 - padding;
}

function decodedRawBase64Length(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 === 1) {
    return undefined;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (base64Digit(value.charCodeAt(index)) === undefined) {
      return undefined;
    }
  }

  const fullQuanta = Math.floor(value.length / 4);
  const remainder = value.length % 4;

  if (remainder === 0) {
    return fullQuanta * 3;
  }

  if (remainder === 2) {
    return fullQuanta * 3 + 1;
  }

  return fullQuanta * 3 + 2;
}

function base64Digit(code: number): number | undefined {
  if (code >= 65 && code <= 90) {
    return code - 65;
  }

  if (code >= 97 && code <= 122) {
    return code - 71;
  }

  if (code >= 48 && code <= 57) {
    return code + 4;
  }

  if (code === 43) {
    return 62;
  }

  if (code === 47) {
    return 63;
  }

  return undefined;
}

function reject(reason: string): Extract<SriIntegrityParseResult, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  };
}
