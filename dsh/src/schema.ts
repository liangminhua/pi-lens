/**
 * Projection from MCP `inputSchema` (arbitrary JSON Schema, generated from
 * TypeBox) onto the enforced JSON Schema subset DSH tool registration accepts.
 *
 * Pi-lens schemas carry annotations such as `format`, numeric bounds, and
 * `anyOf`. DSH intentionally rejects unsupported keywords instead of silently
 * ignoring them, so this module keeps every enforceable keyword and replaces
 * the rest with an open annotation-only node. Argument validation remains the
 * MCP server's responsibility; the projection exists so the model sees a
 * truthful, supported schema.
 */

type SchemaRecord = Record<string, unknown>;

const SUPPORTED_SCALAR_TYPES = new Set([
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);

const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples",
] as const;

const MAX_SCHEMA_DEPTH = 24;

export function asSchemaRecord(value: unknown): SchemaRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as SchemaRecord;
}

/**
 * Build the model-facing parameter schema for a DSH tool.
 *
 * Always returns an object-rooted schema. Unknown roots degrade to an open
 * object rather than failing plugin activation.
 */
export function toParameterSchema(raw: unknown): SchemaRecord {
	const root = asSchemaRecord(raw);
	if (!root)
		return { type: "object", properties: {}, additionalProperties: true };

	const node = sanitizeNode(root, 0) ?? {};
	if (node.type === "object") {
		return {
			type: "object",
			properties: asSchemaRecord(node.properties) ?? {},
			...(Array.isArray(node.required) ? { required: node.required } : {}),
			additionalProperties: true,
			...copyAnnotations(node),
		};
	}
	if (node.properties || node.type === undefined) {
		return {
			type: "object",
			properties: asSchemaRecord(node.properties) ?? {},
			...(Array.isArray(node.required) ? { required: node.required } : {}),
			additionalProperties: true,
			...copyAnnotations(node),
		};
	}
	// A non-object MCP argument root cannot be represented by DSH's object-root
	// parameter map; expose an open object and let the MCP server validate.
	return { type: "object", properties: {}, additionalProperties: true };
}

function sanitizeNode(
	node: SchemaRecord,
	depth: number,
): SchemaRecord | undefined {
	if (depth > MAX_SCHEMA_DEPTH) return {};
	const result: SchemaRecord = {};
	for (const key of ANNOTATION_KEYS) {
		if (node[key] !== undefined) result[key] = node[key];
	}

	const type = node.type;
	if (typeof type === "string" && SUPPORTED_SCALAR_TYPES.has(type)) {
		result.type = type;
		copyScalarConstraints(node, result);
		return result;
	}

	if (type === "array") {
		result.type = "array";
		const items = asSchemaRecord(node.items);
		if (items) result.items = sanitizeNode(items, depth + 1) ?? {};
		return result;
	}

	if (type === "object" || node.properties !== undefined) {
		result.type = "object";
		const properties = asSchemaRecord(node.properties);
		if (properties) {
			const mapped: SchemaRecord = {};
			for (const [name, property] of Object.entries(properties)) {
				const propertyRecord = asSchemaRecord(property);
				if (propertyRecord)
					mapped[name] = sanitizeNode(propertyRecord, depth + 1) ?? {};
			}
			result.properties = mapped;
		} else {
			result.properties = {};
		}
		const required = readRequired(
			node.required,
			result.properties as SchemaRecord,
		);
		if (required.length > 0) result.required = required;
		if (typeof node.additionalProperties === "boolean") {
			result.additionalProperties = node.additionalProperties;
		}
		return result;
	}

	if (Array.isArray(node.oneOf)) {
		const branches: SchemaRecord[] = [];
		for (const branch of node.oneOf) {
			const record = asSchemaRecord(branch);
			if (!record) continue;
			const sanitized = sanitizeNode(record, depth + 1);
			if (sanitized) branches.push(sanitized);
		}
		if (branches.length >= 2) result.oneOf = branches;
		return result;
	}

	// `enum`/`const` remain enforceable without an explicit `type`.
	copyScalarConstraints(node, result);
	if (result.enum !== undefined || result.const !== undefined) return result;

	// Unsupported/absent type: annotation-only node accepts any JSON value.
	return result;
}

function copyScalarConstraints(
	source: SchemaRecord,
	target: SchemaRecord,
): void {
	if (Array.isArray(source.enum) && source.enum.every(isJsonScalar)) {
		target.enum = [...source.enum];
	}
	if (isJsonScalar(source.const)) target.const = source.const;
}

function readRequired(value: unknown, properties: SchemaRecord): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(name): name is string =>
			typeof name === "string" && Object.hasOwn(properties, name),
	);
}

function copyAnnotations(node: SchemaRecord): SchemaRecord {
	const annotations: SchemaRecord = {};
	for (const key of ANNOTATION_KEYS) {
		if (node[key] !== undefined) annotations[key] = node[key];
	}
	return annotations;
}

function isJsonScalar(
	value: unknown,
): value is string | number | boolean | null {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

/** Render an MCP call result as compact, decidable text for the model. */
export function renderMcpResult(
	result: { content?: unknown; structuredContent?: unknown },
	maxChars = 120_000,
): string {
	const parts: string[] = [];
	if (Array.isArray(result.content)) {
		for (const blockValue of result.content) {
			const block = asSchemaRecord(blockValue);
			if (!block) continue;
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			} else if (block.type === "image") {
				parts.push(
					`[image${typeof block.mimeType === "string" ? ` ${block.mimeType}` : ""}]`,
				);
			} else if (block.type === "resource") {
				parts.push(
					`[resource ${typeof block.uri === "string" ? block.uri : ""}]`.trim(),
				);
			}
		}
	}
	if (result.structuredContent !== undefined) {
		parts.push(JSON.stringify(result.structuredContent));
	}
	const text = parts.join("\n").trim();
	const fallback = text.length > 0 ? text : JSON.stringify(result);
	return truncate(fallback, maxChars);
}

function truncate(text: string, maxChars: number): string {
	if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars)
		return text;
	return `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]`;
}
