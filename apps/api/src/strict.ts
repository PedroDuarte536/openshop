import AjvModule from "ajv";

// Fastify's default validator drops unknown properties silently (removeAdditional) and coerces types. For discount
// routes that would turn a typo like "endAt" into an offer that never ends, so these routes use a strict instance:
// unknown properties are rejected, nothing is coerced and no defaults are injected.
const Ajv = (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;
const ajv = new (Ajv as unknown as new (o: object) => { compile: (s: object) => (d: unknown) => boolean })({ allErrors: true, removeAdditional: false, coerceTypes: false, useDefaults: false, strict: true, allowUnionTypes: true });

export const strictValidator = ({ schema }: { schema: object }) => ajv.compile(schema);
