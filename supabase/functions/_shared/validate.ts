/**
 * Input validation utilities for edge functions.
 * Throw a 400 Response when input is invalid — callers must catch Response
 * objects and return them directly (same pattern as requireUserAuth).
 */

const MAX_BODY_BYTES = 32_768; // 32 KB — more than enough for any flight payload

/** Read and size-limit the request body. Throws a 400 Response if too large. */
export async function readBody(req: Request): Promise<unknown> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    throw new Response(
      JSON.stringify({ error: "Request body too large" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new Response(
        JSON.stringify({ error: "Request body too large" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    body = JSON.parse(text);
  } catch (err) {
    if (err instanceof Response) throw err;
    throw new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  return body;
}

type FieldRule = {
  required?: boolean;
  type?: "string" | "number" | "boolean";
  maxLength?: number;
  pattern?: RegExp;
  oneOf?: readonly string[];
};

/**
 * Validate a plain object against a set of field rules.
 * Throws a 400 Response listing all validation errors if any fail.
 */
export function validateFields(
  body: unknown,
  rules: Record<string, FieldRule>,
): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Response(
      JSON.stringify({ error: "Body must be a JSON object" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const obj = body as Record<string, unknown>;
  const errors: string[] = [];

  for (const [field, rule] of Object.entries(rules)) {
    const value = obj[field];

    if (rule.required && (value === undefined || value === null || value === "")) {
      errors.push(`${field}: required`);
      continue;
    }
    if (value === undefined || value === null || value === "") continue;

    if (rule.type && typeof value !== rule.type) {
      errors.push(`${field}: must be ${rule.type}`);
      continue;
    }

    if (rule.type === "string" && typeof value === "string") {
      if (rule.maxLength && value.length > rule.maxLength) {
        errors.push(`${field}: exceeds max length of ${rule.maxLength}`);
      }
      if (rule.pattern && !rule.pattern.test(value)) {
        errors.push(`${field}: invalid format`);
      }
      if (rule.oneOf && !rule.oneOf.includes(value)) {
        errors.push(`${field}: must be one of [${rule.oneOf.join(", ")}]`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Response(
      JSON.stringify({ error: "Validation failed", details: errors }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  return obj;
}

/** Strip any keys from an object that aren't in the allowed list. */
export function pick<T extends Record<string, unknown>>(
  obj: Record<string, unknown>,
  keys: (keyof T)[],
): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    if (k in obj) (out as Record<string, unknown>)[k as string] = obj[k as string];
  }
  return out;
}
