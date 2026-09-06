export * from './types.js';
export * from './tokens.js';

import ssgSchema from '../schema/ssg-v1.json' with { type: 'json' };
import actionPlanSchema from '../schema/action-plan-v1.json' with { type: 'json' };
import redactionManifestSchema from '../schema/redaction-manifest-v1.json' with { type: 'json' };

export { ssgSchema, actionPlanSchema, redactionManifestSchema };

/** Bump on any breaking contract change. The server refuses unknown majors (409). */
export const SSG_VERSION = '1.0' as const;
