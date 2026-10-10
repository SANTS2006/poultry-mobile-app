// Deterministic, non-secret environment for tests.
process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DATABASE_URL ??= 'postgresql://postgres@localhost:5433/makarifor_test';
process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;
process.env.BACKUP_ENABLED = '1';
process.env.BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.RECOVERY_ADMIN_DATABASE_URL ??= 'postgresql://postgres@localhost:5433/postgres';
