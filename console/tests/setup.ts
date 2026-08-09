// Runs before any test module imports the app code. Each Vitest file runs in
// its own worker, so every test file gets a fresh in-memory database with the
// real migrations applied by db/client.ts.
process.env.DB_PATH = ":memory:";
process.env.PROTECT_HOST = "protect.test.invalid";
process.env.PROTECT_API_KEY = "test-key";
process.env.PROTECT_USERNAME = "test";
process.env.PROTECT_PASSWORD = "test";
process.env.SCHOOL_TZ = "America/Chicago";
