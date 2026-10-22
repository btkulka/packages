// A small check of tool arguments against a tool's JSON Schema. The low-level
// SDK Server does not validate arguments; Benhäus wrote this so a bad call gets a
// sentence back instead of a crash deep inside the tool. It covers what tool
// schemas here use (required, type, enum, array items, additionalProperties:
// false) and nothing more; it is not a JSON Schema validator.

type Prop = { type?: string | string[]; enum?: unknown[]; items?: Prop };

const kindOf = (value: unknown) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

function matches(type: string, value: unknown): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return kindOf(value) === type;
}

const typeOk = (type: string | string[], value: unknown) => (Array.isArray(type) ? type.some((t) => matches(t, value)) : matches(type, value));
const typeName = (type: string | string[]) => (Array.isArray(type) ? type.join(" or ") : type);

/**
 * The first problem with `args` under `schema`, as a sentence, or undefined
 * when there is none. A required key that is missing or null is a problem.
 */
export function checkArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  const props = (schema.properties ?? {}) as Record<string, Prop>;
  for (const key of (schema.required ?? []) as string[]) if (args[key] === undefined || args[key] === null) return `${key} is required.`;
  for (const [key, value] of Object.entries(args)) {
    const p = props[key];
    if (!p) {
      if (schema.additionalProperties === false) return `Unknown argument ${key}. Expected: ${Object.keys(props).join(", ") || "none"}.`;
      continue;
    }
    if (p.type && !typeOk(p.type, value)) return `${key} should be a ${typeName(p.type)}, not a ${kindOf(value)}.`;
    if (p.enum && !p.enum.includes(value)) return `${key} must be one of: ${p.enum.join(", ")}.`;
    if (Array.isArray(value) && p.items) {
      for (const v of value) {
        if (p.items.type && !typeOk(p.items.type, v)) return `${key} should hold ${typeName(p.items.type)}s.`;
        if (p.items.enum && !p.items.enum.includes(v)) return `${key} items must be one of: ${p.items.enum.join(", ")}.`;
      }
    }
  }
  return undefined;
}
