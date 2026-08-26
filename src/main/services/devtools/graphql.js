'use strict';
/**
 * GraphQL explorer (spec §3).
 *
 * Built on the existing REST client rather than beside it, so a GraphQL
 * request inherits the profile's cookies, the timing breakdown and the saved
 * collections that the HTTP panel already has. A GraphQL query is an HTTP
 * POST; treating it as a separate transport would duplicate all of that.
 *
 * The schema browser uses GraphQL's own introspection query, which is part of
 * the spec and needs no server cooperation beyond having introspection
 * enabled. When a server has it disabled — normal in production — that is
 * reported as the deliberate configuration it is, not as an error.
 */
const EventEmitter = require('node:events');

const { JsonStore } = require('../../util/json-store');
const paths = require('../../util/paths');

/**
 * The introspection query, trimmed to what a schema browser renders.
 *
 * The full query in the GraphQL spec pulls deprecation metadata and directive
 * locations that this panel does not show; asking for less keeps the response
 * to a size that renders instantly on large schemas.
 */
const INTROSPECTION = `
query AetherIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        args { name description type { ...TypeRef } defaultValue }
        type { ...TypeRef }
      }
      inputFields { name description type { ...TypeRef } }
      enumValues(includeDeprecated: true) { name description isDeprecated }
      interfaces { ...TypeRef }
      possibleTypes { ...TypeRef }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name } } }
}`;

class GraphQLService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./http-client').HttpClientService} deps.http
   * @param {import('../feature-store').FeatureStore} deps.features
   */
  constructor({ http, features }) {
    super();
    this.http = http;
    this.features = features;

    this.store = new JsonStore(paths.userData('graphql.json'), {
      endpoints: [],    // { url, name, headers }
      history: [],      // { url, query, variables, at, ms, ok }
    });

    /** url -> parsed schema, so switching tabs does not re-introspect. */
    this._schemas = new Map();
  }

  endpoints() {
    return this.store.data.endpoints;
  }

  addEndpoint({ url, name, headers = {} }) {
    if (!/^https?:\/\//.test(url)) throw new Error('an endpoint must be an http(s) URL');
    const endpoints = this.store.data.endpoints.filter((e) => e.url !== url);
    endpoints.push({ url, name: name || new URL(url).host, headers });
    this.store.data.endpoints = endpoints;
    this.store.save();
    this.emit('changed', this.state());
    return this.state();
  }

  removeEndpoint(url) {
    this.store.data.endpoints = this.store.data.endpoints.filter((e) => e.url !== url);
    this._schemas.delete(url);
    this.store.save();
    this.emit('changed', this.state());
    return this.state();
  }

  /** Fetch and flatten the schema for browsing. */
  async introspect(url, { headers = {}, refresh = false, profileId } = {}) {
    if (!this.features.enabled('graphql')) throw new Error('the GraphQL explorer is off');
    if (this._schemas.has(url) && !refresh) return this._schemas.get(url);

    const result = await this.execute({ url, query: INTROSPECTION, headers, profileId });

    if (result.body?.errors?.length) {
      const message = result.body.errors[0]?.message || 'introspection failed';
      if (/introspection/i.test(message) && /disabl|not allowed|forbidden/i.test(message)) {
        throw new Error(
          'This server has introspection disabled, which is normal in production. '
          + 'The query editor still works; the schema browser needs a development endpoint.',
        );
      }
      throw new Error(message);
    }

    const schema = summariseSchema(result.body?.data?.__schema);
    this._schemas.set(url, schema);
    this.emit('schema', { url, schema });
    return schema;
  }

  /**
   * Run a query.
   *
   * GraphQL returns HTTP 200 with an `errors` array for a failed query, so
   * "did it work" cannot be read off the status code — the panel reports both
   * the transport status and the GraphQL-level errors separately.
   */
  async execute({ url, query, variables, operationName, headers = {}, profileId } = {}) {
    if (!this.features.enabled('graphql')) throw new Error('the GraphQL explorer is off');
    if (!url) throw new Error('a GraphQL request needs an endpoint');

    const saved = this.store.data.endpoints.find((e) => e.url === url);
    const body = JSON.stringify({
      query,
      variables: parseVariables(variables),
      operationName: operationName || undefined,
    });

    const started = Date.now();
    const response = await this.http.send({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(saved?.headers || {}),
        ...headers,
      },
      body,
      profileId,
    });

    let parsed = null;
    try {
      parsed = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
    } catch {
      parsed = null;
    }

    const record = {
      url,
      query,
      variables,
      at: started,
      ms: Date.now() - started,
      status: response.status,
      ok: response.status < 400 && !(parsed?.errors?.length),
      errorCount: parsed?.errors?.length || 0,
    };
    // Query text can be long; the history keeps the last 100 and the panel
    // shows the operation name.
    this.store.data.history = [record, ...this.store.data.history].slice(0, 100);
    this.store.save();
    this.emit('changed', this.state());

    return {
      ...record,
      body: parsed,
      raw: parsed ? undefined : response.body,
      timing: response.timing,
      headers: response.headers,
    };
  }

  history(url) {
    const all = this.store.data.history;
    return url ? all.filter((h) => h.url === url) : all;
  }

  clearHistory() {
    this.store.data.history = [];
    this.store.save();
    this.emit('changed', this.state());
    return this.state();
  }

  state() {
    return {
      endpoints: this.endpoints(),
      history: this.history().slice(0, 30),
      schemas: [...this._schemas.keys()],
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Flatten an introspection response into what the browser panel renders:
 * the root operation types, and every user-defined type with its fields.
 */
function summariseSchema(schema) {
  if (!schema) throw new Error('the server returned no schema');

  const types = (schema.types || [])
    // Introspection meta-types are noise in a schema browser.
    .filter((t) => t.name && !t.name.startsWith('__'))
    .map((t) => ({
      name: t.name,
      kind: t.kind,
      description: t.description || '',
      fields: (t.fields || []).map((f) => ({
        name: f.name,
        description: f.description || '',
        deprecated: f.isDeprecated || false,
        type: renderTypeRef(f.type),
        args: (f.args || []).map((a) => ({
          name: a.name, type: renderTypeRef(a.type), defaultValue: a.defaultValue,
        })),
      })),
      inputFields: (t.inputFields || []).map((f) => ({
        name: f.name, type: renderTypeRef(f.type),
      })),
      enumValues: (t.enumValues || []).map((e) => ({ name: e.name, description: e.description })),
      interfaces: (t.interfaces || []).map((i) => i.name).filter(Boolean),
    }));

  return {
    query: schema.queryType?.name || null,
    mutation: schema.mutationType?.name || null,
    subscription: schema.subscriptionType?.name || null,
    types,
    // Sorted for a stable sidebar; objects first, since that is what people
    // are usually looking for.
    index: types
      .slice()
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, kind: t.kind, fieldCount: t.fields.length })),
  };
}

/** `{kind: NON_NULL, ofType: {kind: LIST, ofType: {name: User}}}` -> `[User]!` */
function renderTypeRef(ref) {
  if (!ref) return 'Unknown';
  if (ref.kind === 'NON_NULL') return `${renderTypeRef(ref.ofType)}!`;
  if (ref.kind === 'LIST') return `[${renderTypeRef(ref.ofType)}]`;
  return ref.name || 'Unknown';
}

function parseVariables(variables) {
  if (!variables) return undefined;
  if (typeof variables === 'object') return variables;
  const text = String(variables).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`variables are not valid JSON: ${err.message}`);
  }
}

module.exports = { GraphQLService, summariseSchema, renderTypeRef, INTROSPECTION };
