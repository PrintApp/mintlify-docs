// Build mintlify-docs/openapi.json from the live filecheck-api request schemas.
//
// Reads the canonical JSON Schemas from the filecheck-api repo and embeds them
// verbatim (rewriting their internal #/$defs refs so they resolve under
// components/schemas), then assembles the full OpenAPI 3.1 document.
//
// Usage (from the repo root):
//   node scripts/build-openapi.mjs
//
// By default it expects filecheck-api to be a sibling of this repo:
//   <parent>/filecheck-api
//   <parent>/mintlify-docs   <- this repo
// Override the schema location with FILECHECK_API_SCHEMAS=/abs/path if needed.
//
// Re-run this whenever the API request schemas or endpoints change. Do not
// hand-edit openapi.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const SCHEMA_DIR = process.env.FILECHECK_API_SCHEMAS
  || path.resolve(REPO_ROOT, '..', 'filecheck-api', '_layers', 'mixins', 'nodejs', 'schemas');
const OUT = path.resolve(REPO_ROOT, 'openapi.json');

if (!fs.existsSync(SCHEMA_DIR)) {
  console.error(`Schema directory not found: ${SCHEMA_DIR}`);
  console.error('Set FILECHECK_API_SCHEMAS to the filecheck-api schemas folder and retry.');
  process.exit(1);
}

// Load a request schema verbatim, strip $schema/$id, and rewrite in-document
// refs (#/...) so they resolve under this component's location.
function loadSchema(file, name) {
  const raw = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));
  delete raw.$schema;
  delete raw.$id;
  const base = `#/components/schemas/${name}/`;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string' && v.startsWith('#/')) {
          node[k] = base + v.slice(2);
        } else {
          walk(v);
        }
      }
    }
  };
  walk(raw);
  return raw;
}

const JobsPost          = loadSchema('jobs-post.json', 'JobsPost');
const JobsPreflightPost = loadSchema('jobs-preflight-post.json', 'JobsPreflightPost');
const JobsOptimizePost  = loadSchema('jobs-optimize-post.json', 'JobsOptimizePost');
const JobsValidatePost  = loadSchema('jobs-validate-post.json', 'JobsValidatePost');

const json = (ref) => ({ 'application/json': { schema: { $ref: ref } } });
const errorResponses = {
  '400': { description: 'Validation error', content: json('#/components/schemas/Error') },
  '401': { description: 'Missing or invalid key', content: json('#/components/schemas/Error') },
};

const jobSubmissionResponses = {
  '200': { description: 'Sync completion (sync: true)', content: json('#/components/schemas/JobResponse') },
  '201': { description: 'Accepted, processing asynchronously', content: json('#/components/schemas/JobResponse') },
  '202': { description: 'Sync timed out; still pending', content: json('#/components/schemas/JobPendingResponse') },
  ...errorResponses,
  '403': { description: 'A referenced fileRef is not owned by the caller', content: json('#/components/schemas/Error') },
};

function resourcePaths(collection, itemName, listKey, itemKey) {
  return {
    [`/${collection}`]: {
      get: {
        tags: [itemName + 's'],
        summary: `List ${collection}`,
        description: `Lists ${collection} (domain-scoped entries merged with the built-in store catalog). Each item is tagged with a \`source\` of \`domain\` or \`store\`.`,
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { [listKey]: { type: 'array', items: { $ref: `#/components/schemas/${itemName}` } } } } } } },
          ...errorResponses,
        },
      },
    },
    [`/${collection}/{id}`]: {
      get: {
        tags: [itemName + 's'],
        summary: `Get a ${itemName.toLowerCase()}`,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { [itemKey]: { $ref: `#/components/schemas/${itemName}` } } } } } },
          '404': { description: 'Not found', content: json('#/components/schemas/Error') },
          ...errorResponses,
        },
      },
    },
  };
}

const sugarBody = (name) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } });

const spec = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'Filecheck API',
    version: '1.0.0',
    description: 'The Filecheck REST API. Submit files as jobs, fetch results, and read your workflows, rules, connectors, profiles, and optimize presets. All requests are authenticated server-side with your secret key (`sk_live_…`).',
  },
  servers: [{ url: 'https://api.filecheck.io', description: 'Production' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Jobs', description: 'Submit files for preflight, fixing, optimization, validation, and previews.' },
    { name: 'Uploads', description: 'Mint presigned credentials to upload large files directly.' },
    { name: 'Orders', description: 'Attach jobs to commerce orders.' },
    { name: 'Workflows' }, { name: 'Connectors' }, { name: 'Rules' }, { name: 'Profiles' }, { name: 'OptimizePresets' },
  ],
  paths: {
    '/jobs': {
      post: {
        tags: ['Jobs'],
        summary: 'Submit a job',
        description: 'Canonical job submission. Each entry in `sources[]` is one source file plus the ordered `steps[]` to run on it. Async (201) by default; set `sync: true` to wait up to ~27s.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/JobsPost' } } } },
        responses: jobSubmissionResponses,
      },
      get: {
        tags: ['Jobs'],
        summary: 'List jobs',
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { jobs: { type: 'array', items: { $ref: '#/components/schemas/Job' } } } } } } },
          ...errorResponses,
        },
      },
    },
    '/jobs/{id}': {
      get: {
        tags: ['Jobs'],
        summary: 'Get a job',
        description: 'Returns the full Job with child Tasks and steps. Use `?expand=runs` for a flattened per-file summary with proof and download URLs.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'expand', in: 'query', required: false, schema: { type: 'string', enum: ['runs'] }, description: 'Set to `runs` to return a flattened per-file summary instead of the full job.' },
        ],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/JobResponse' }, { $ref: '#/components/schemas/RunsResponse' }] } } } },
          '404': { description: 'Job not found', content: json('#/components/schemas/Error') },
          ...errorResponses,
        },
      },
      delete: {
        tags: ['Jobs'],
        summary: 'Delete a job',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Deleted' }, '404': { description: 'Job not found', content: json('#/components/schemas/Error') }, ...errorResponses },
      },
    },
    '/jobs/preflight': { post: { tags: ['Jobs'], summary: 'Preflight a file', description: 'Sugar wrapper. Runs a preflight-only job. Async (201) by default; `sync: true` waits for the result.', requestBody: sugarBody('JobsPreflightPost'), responses: jobSubmissionResponses } },
    '/jobs/fix':       { post: { tags: ['Jobs'], summary: 'Fix a file', description: 'Sugar wrapper for preflight + autofix, plus an optional re-preflight when `repreflight: true`. Async (201) by default.', requestBody: sugarBody('FixPost'), responses: jobSubmissionResponses } },
    '/jobs/optimize':  { post: { tags: ['Jobs'], summary: 'Optimize a file', description: 'Sugar wrapper. Runs an optimize-only job. Async (201) by default; `sync: true` waits for the result.', requestBody: sugarBody('JobsOptimizePost'), responses: jobSubmissionResponses } },
    '/jobs/validate':  { post: { tags: ['Jobs'], summary: 'Validate a file', description: 'Sugar wrapper. Validates a file against one or more PDF/A or PDF/UA conformance levels. Sync by default; set `async: true` to return 201 immediately.', requestBody: sugarBody('JobsValidatePost'), responses: jobSubmissionResponses } },
    '/jobs/previews':  { post: { tags: ['Jobs'], summary: 'Generate previews', description: 'Sugar wrapper. Renders preview images for a file. Async (201) by default; `sync: true` waits for the result.', requestBody: sugarBody('PreviewsPost'), responses: jobSubmissionResponses } },
    '/uploads': {
      post: {
        tags: ['Uploads'],
        summary: 'Create an upload',
        description: 'Mints presigned S3 POST credentials so a client can upload a large file directly (up to 500 MB). Returns a `fileRef` usable as a job source. Credentials expire in 300 seconds.',
        requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadRequest' } } } },
        responses: { '200': { description: 'OK', content: json('#/components/schemas/UploadResponse') }, ...errorResponses, '500': { description: 'Failed to create upload credentials', content: json('#/components/schemas/Error') } },
      },
    },
    '/orders/{id}': {
      post: {
        tags: ['Orders'],
        summary: 'Capture an order',
        description: 'Records a commerce order and links its line items (and their Filecheck `jobId`s) to the caller. Currently shaped for WooCommerce (`source: "wp"`).',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderRequest' } } } },
        responses: { '200': { description: 'Order captured' }, ...errorResponses },
      },
    },
    ...resourcePaths('workflows', 'Workflow', 'workflows', 'workflow'),
    ...resourcePaths('connectors', 'Connector', 'connectors', 'connector'),
    ...resourcePaths('rules', 'Rule', 'rules', 'rule'),
    ...resourcePaths('profiles', 'Profile', 'profiles', 'profile'),
    ...resourcePaths('optimize-presets', 'OptimizePreset', 'presets', 'preset'),
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Your secret key as a bearer token, e.g. `Authorization: Bearer sk_live_…`. Secret keys are server-side only.' },
    },
    schemas: {
      JobsPost, JobsPreflightPost, JobsOptimizePost, JobsValidatePost,
      PreviewsPost: {
        type: 'object', required: ['sources'], additionalProperties: false,
        properties: {
          sources: { type: 'array', minItems: 1, items: { type: 'object', properties: { url: { type: 'string' }, file: { type: 'string', description: 'Base64 file payload' }, fileRef: { type: 'string' }, params: { type: 'object' } } } },
          sync: { type: 'boolean', default: false }, webhook: { type: 'string' }, metaData: { type: 'object' },
        },
      },
      FixPost: {
        type: 'object', required: ['sources'], additionalProperties: false,
        properties: {
          sources: { type: 'array', minItems: 1, items: { type: 'object', properties: { url: { type: 'string' }, file: { type: 'string', description: 'Base64 file payload' }, fileRef: { type: 'string' }, profileId: { type: 'string' }, items: { type: 'array', items: { type: 'string' }, description: 'Specific autofix items to apply; omit to let Filecheck choose defaults.' } } } },
          repreflight: { type: 'boolean', default: false, description: 'Re-run preflight after autofix to confirm the result.' },
          sync: { type: 'boolean', default: false }, webhook: { type: 'string' }, metaData: { type: 'object' },
        },
      },
      UploadRequest: {
        type: 'object', additionalProperties: false,
        properties: { mimeType: { type: 'string', description: 'Content type of the file you intend to upload.' }, sizeBytes: { type: 'integer', description: 'Expected size in bytes. Capped at 500 MB.' } },
      },
      UploadResponse: {
        type: 'object',
        properties: {
          fileRef: { type: 'string', description: 'Pass this as a job source.' },
          upload: { type: 'object', properties: { url: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } }, method: { type: 'string', enum: ['POST'] } } },
          maxBytes: { type: 'integer' }, expiresIn: { type: 'integer', description: 'Seconds until the credentials expire.' },
        },
      },
      OrderRequest: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['wp'], default: 'wp' },
          orderId: { type: 'string' }, status: { type: 'string' }, currency: { type: 'string' }, total: {},
          customer: { type: 'object', properties: { id: {}, email: { type: 'string' } } },
          items: { type: 'array', items: { type: 'object', properties: { jobId: { type: 'string' }, itemId: {}, productId: {}, name: { type: 'string' }, quantity: {}, sku: { type: 'string' }, total: {} } } },
        },
      },
      Step: {
        type: 'object',
        properties: {
          id: { type: 'string' }, type: { type: 'string', description: 'preflight, repreflight, autofix, optimize, validate, previews, proof' },
          status: { type: 'string' }, outcome: { type: ['string', 'null'], enum: ['pass', 'warn', 'fail', null] },
          reason: { type: ['string', 'null'] }, params: { type: ['object', 'null'] }, runtimeParams: { type: ['object', 'null'] },
          started: { type: ['string', 'null'] }, ended: { type: ['string', 'null'] }, duration: { type: ['number', 'null'] },
          outputs: { type: 'array', items: { type: 'object' } },
        },
      },
      OutputArtifact: {
        type: 'object',
        properties: { kind: { type: 'string' }, role: { type: 'string' }, bucket: { type: 'string' }, key: { type: 'string' }, downloadUrl: { type: ['string', 'null'] }, expiresIn: { type: ['integer', 'null'] } },
      },
      Task: {
        type: 'object',
        properties: {
          id: { type: 'string' }, createdAt: { type: ['string', 'null'] }, updatedAt: { type: ['string', 'null'] },
          status: { type: 'string' }, outcome: { type: ['string', 'null'] }, fileType: { type: ['string', 'null'] }, mimeType: { type: ['string', 'null'] },
          source: { type: ['string', 'null'] }, fileRef: { type: ['string', 'null'] }, clientRef: { type: ['string', 'null'] }, jobId: { type: ['string', 'null'] },
          originalArtifact: { type: ['object', 'null'] }, outputArtifacts: { type: 'array', items: { $ref: '#/components/schemas/OutputArtifact' } },
          steps: { type: 'array', items: { $ref: '#/components/schemas/Step' } },
        },
      },
      Job: {
        type: 'object',
        properties: {
          id: { type: 'string' }, createdAt: { type: ['string', 'null'] }, modifiedAt: { type: ['string', 'null'] },
          status: { type: 'string', description: 'idle, incomplete, uploading, processing, ready, partial, rejected' },
          outcome: { type: ['string', 'null'] }, channel: { type: ['string', 'null'], enum: ['api', 'store', 'admin', null] },
          ruleId: { type: ['string', 'null'] }, workflowId: { type: ['string', 'null'] }, metaData: { type: ['object', 'null'] },
          tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
          orderId: { type: ['string', 'null'] }, customerId: { type: ['string', 'null'] }, customerEmail: { type: ['string', 'null'] },
          summary: { type: 'object', description: 'Present on non-lean responses.' },
          results: { type: 'object', description: 'Aggregated validate / preflight / optimize results on non-lean responses.' },
        },
      },
      Run: {
        type: 'object',
        description: 'A flattened per-file view returned by ?expand=runs.',
        properties: {
          id: { type: 'string' }, name: { type: 'string' },
          outcome: { type: ['string', 'null'], enum: ['pass', 'warn', 'fail', null] }, status: { type: ['string', 'null'] },
          hasOutput: { type: 'boolean' }, proofs: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } },
          downloadUrl: { type: ['string', 'null'] },
        },
      },
      JobResponse: { type: 'object', properties: { job: { $ref: '#/components/schemas/Job' } } },
      JobPendingResponse: { type: 'object', properties: { pending: { type: 'boolean' }, job: { $ref: '#/components/schemas/Job' } } },
      RunsResponse: { type: 'object', properties: { runs: { type: 'array', items: { $ref: '#/components/schemas/Run' } } } },
      Resource: {
        type: 'object',
        description: 'Library resources share a common envelope. Each carries an id, a human label, an enabled flag, and a `source` of `domain` or `store`.',
        properties: { id: { type: 'string' }, name: { type: 'string' }, enabled: { type: 'boolean' }, source: { type: 'string', enum: ['domain', 'store'] } },
        additionalProperties: true,
      },
      Workflow: { allOf: [{ $ref: '#/components/schemas/Resource' }] },
      Connector: { allOf: [{ $ref: '#/components/schemas/Resource' }] },
      Rule: { allOf: [{ $ref: '#/components/schemas/Resource' }] },
      Profile: { allOf: [{ $ref: '#/components/schemas/Resource' }] },
      OptimizePreset: { allOf: [{ $ref: '#/components/schemas/Resource' }] },
      Error: { type: 'object', properties: { error: { type: 'boolean' }, message: { type: 'string' } } },
    },
  },
};

fs.writeFileSync(OUT, JSON.stringify(spec, null, 2));
console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes, ${Object.keys(spec.paths).length} paths)`);
