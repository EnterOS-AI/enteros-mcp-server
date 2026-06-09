/**
 * Jest config for the INTEGRATION test layer (SOP rule internal#765).
 *
 * Distinct from the default jest.config.cjs (unit, fetch-mocked) so the
 * integration suite:
 *   - runs as its own job (npm run test:integration), and
 *   - can map the REAL (non-mocked) MCP SDK client + InMemory transport to
 *     their CJS builds, which the unit config did not need.
 *
 * The integration suite uses NEITHER an SDK mock NOR a fetch mock — it boots
 * the real server over a real transport against a real node:http platform.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // Only the *.integration.test.ts files live in this layer.
  testMatch: ["**/__tests__/**/*.integration.test.ts"],
  moduleNameMapper: {
    // Strip .js extensions from relative imports so ts-jest resolves .ts.
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // Map ESM-only MCP SDK imports to their CJS equivalents so the real
    // (non-mocked) SDK loads under ts-jest's CommonJS transform.
    "^@modelcontextprotocol/sdk/server/mcp\\.js$":
      "<rootDir>/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js",
    "^@modelcontextprotocol/sdk/server/stdio\\.js$":
      "<rootDir>/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js",
    "^@modelcontextprotocol/sdk/client/index\\.js$":
      "<rootDir>/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js",
    "^@modelcontextprotocol/sdk/inMemory\\.js$":
      "<rootDir>/node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.js",
    "^@modelcontextprotocol/sdk/types\\.js$":
      "<rootDir>/node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "CommonJS",
          moduleResolution: "node",
          esModuleInterop: true,
          strict: true,
          target: "ES2022",
          isolatedModules: true,
        },
        diagnostics: false,
      },
    ],
  },
  // Real HTTP + transport teardown can take a beat; keep a generous timeout.
  testTimeout: 30000,
};
