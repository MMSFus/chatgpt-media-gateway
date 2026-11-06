/**
 * Fixed test secrets for suites that import modules depending on src/config.js.
 *
 * config.js reads `.env` and throws when ADMIN_KEY, API_KEY or DATA_ENCRYPTION_KEY
 * is missing, so a test that imports src/upstream.js or src/tencent.js fails at
 * load time on a machine whose `.env` lacks one of them. Import this module before
 * any src/ module: ES modules evaluate in import order, and values already in
 * process.env take precedence over `.env`. The values are overwritten on purpose
 * so tests never run with real keys from a developer's `.env`.
 */
process.env.ADMIN_KEY = 'admin-test-key';
process.env.API_KEY = 'client-test-key';
process.env.DATA_ENCRYPTION_KEY = '07'.repeat(32);
