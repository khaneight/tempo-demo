/** Tests never touch the dev database: they truncate tables. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://acme:acme@localhost:5434/acmeusd_test";
