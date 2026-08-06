import { isUnknownRecord } from "../type-guards.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const SCHEMA_KEYS = new Set([
  "additionalProperties",
  "const",
  "enum",
  "items",
  "maximum",
  "maxItems",
  "maxLength",
  "minimum",
  "minItems",
  "minLength",
  "pattern",
  "properties",
  "required",
  "type",
]);
const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

/** Returns true only for finite, recursively JSON-compatible values. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isUnknownRecord(value) && Object.values(value).every(isJsonValue);
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isUnknownRecord(left) && isUnknownRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => key in right && jsonEqual(left[key], right[key]));
  }
  return false;
}

/** Validates the fail-closed JSON Schema subset accepted by Action manifests. */
export function validateJsonSchemaDefinition(schema: unknown, path = "$schema"): void {
  if (typeof schema === "boolean") return;
  if (!isUnknownRecord(schema)) throw new Error(`${path} must be an object or boolean`);
  const unknown = Object.keys(schema).filter((key) => !SCHEMA_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unsupported keyword: ${unknown[0]}`);

  if (schema.type !== undefined) {
    const types = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (
      !Array.isArray(types)
      || types.length === 0
      || types.some((type) => typeof type !== "string" || !JSON_TYPES.has(type))
      || new Set(types).size !== types.length
    ) {
      throw new Error(`${path}.type is invalid`);
    }
  }
  if ("const" in schema && !isJsonValue(schema.const)) {
    throw new Error(`${path}.const is not JSON-compatible`);
  }
  if (
    schema.enum !== undefined
    && (!Array.isArray(schema.enum) || schema.enum.some((value) => !isJsonValue(value)))
  ) {
    throw new Error(`${path}.enum is invalid`);
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    const value = schema[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw new Error(`${path}.${key} must be a non-negative safe integer`);
    }
  }
  for (const key of ["minimum", "maximum"] as const) {
    const value = schema[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`${path}.${key} must be a finite number`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new Error(`${path}.pattern must be a string`);
    try {
      new RegExp(schema.pattern, "u");
    } catch (error) {
      throw new Error(`${path}.pattern is invalid`, { cause: error });
    }
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required)
      || schema.required.some((key) => typeof key !== "string")
      || new Set(schema.required).size !== schema.required.length
    ) {
      throw new Error(`${path}.required is invalid`);
    }
  }
  if (schema.properties !== undefined) {
    if (!isUnknownRecord(schema.properties)) throw new Error(`${path}.properties must be an object`);
    for (const [key, child] of Object.entries(schema.properties)) {
      validateJsonSchemaDefinition(child, `${path}.properties.${key}`);
    }
  }
  if (schema.items !== undefined) validateJsonSchemaDefinition(schema.items, `${path}.items`);
  if (schema.additionalProperties !== undefined) {
    validateJsonSchemaDefinition(schema.additionalProperties, `${path}.additionalProperties`);
  }
}

/** Applies the supported schema subset to a runtime value and throws on mismatch. */
export function validateJsonSchema(schema: unknown, value: unknown, path = "$"): asserts value is JsonValue {
  if (schema === true) {
    if (!isJsonValue(value)) throw new Error(`${path} is not JSON-compatible`);
    return;
  }
  if (schema === false) throw new Error(`${path} is rejected by schema`);
  if (!isUnknownRecord(schema)) throw new Error(`${path} schema must be an object or boolean`);

  if ("const" in schema && !jsonEqual(value, schema.const)) {
    throw new Error(`${path} must equal schema const`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    throw new Error(`${path} is not an allowed enum value`);
  }

  const actualType = valueType(value);
  if (typeof schema.type === "string") {
    const typeMatches = schema.type === actualType
      || (schema.type === "number" && actualType === "integer");
    if (!typeMatches) throw new Error(`${path} must be ${schema.type}, received ${actualType}`);
  } else if (Array.isArray(schema.type)) {
    const accepted = schema.type.filter((type): type is string => typeof type === "string");
    if (!accepted.includes(actualType) && !(actualType === "integer" && accepted.includes("number"))) {
      throw new Error(`${path} must match one of: ${accepted.join(", ")}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      throw new Error(`${path} is shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      throw new Error(`${path} is longer than ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      throw new Error(`${path} does not match required pattern`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      throw new Error(`${path} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      throw new Error(`${path} is above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      throw new Error(`${path} has fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      throw new Error(`${path} has more than ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        validateJsonSchema(schema.items, item, `${path}[${index}]`);
      }
    }
  }

  if (isUnknownRecord(value)) {
    const properties = isUnknownRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required === "string" && !(required in value)) {
          throw new Error(`${path}.${required} is required`);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        validateJsonSchema(properties[key], child, `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        throw new Error(`${path}.${key} is not allowed`);
      } else if (
        isUnknownRecord(schema.additionalProperties)
        || typeof schema.additionalProperties === "boolean"
      ) {
        validateJsonSchema(schema.additionalProperties, child, `${path}.${key}`);
      } else if (!isJsonValue(child)) {
        throw new Error(`${path}.${key} is not JSON-compatible`);
      }
    }
  } else if (!isJsonValue(value)) {
    throw new Error(`${path} is not JSON-compatible`);
  }
}
