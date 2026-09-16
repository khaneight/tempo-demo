import "dotenv/config";
import { TEST_DATABASE_URL } from "./db-url";

// Must run before `@/db` is imported anywhere: the pool reads DATABASE_URL lazily on first use.
process.env.DATABASE_URL = TEST_DATABASE_URL;

// Tests inject a mock Chain; these only need to parse.
process.env.ACME_USD_ADDRESS ??= "0x20c0000000000000000000000000000000000abc";
process.env.ISSUER_PRIVATE_KEY ??= `0x${"11".repeat(32)}`;
process.env.ADMIN_PASSWORD ??= "test-password";
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-0123";
