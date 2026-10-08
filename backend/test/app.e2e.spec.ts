import { Controller, Get, INestApplication, BadRequestException, Post, Body } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Min } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Public } from '../src/auth/decorators/public.decorator';
import { configureApp } from '../src/app.setup';
import { GENERIC_ERROR_MESSAGE } from '../src/common/messages';
import { PrismaService } from '../src/prisma/prisma.service';

class DummyDto {
  @IsString() name!: string;
  @IsInt() @Min(0) qty!: number;
}

@Public() // these probes exercise the error filter / validation, not authentication
@Controller('_test')
class TestController {
  constructor(private readonly prisma: PrismaService) {}
  @Get('boom') boom(): never {
    throw new Error('SELECT * FROM "User" password=hunter2 at /srv/app/secret.ts');
  }
  @Get('bad') bad(): never {
    throw new BadRequestException('Invalid thing');
  }
  @Get('dup') async dup() {
    await this.prisma.$executeRawUnsafe(`INSERT INTO "Role"(id, code, name) VALUES (gen_random_uuid(), 'X_DUP', 'x'), (gen_random_uuid(), 'X_DUP', 'x')`);
  }
  @Post('dto') dto(@Body() body: DummyDto) {
    return { ok: true, keys: Object.keys(body) };
  }
}

describe('Backend foundation (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule], controllers: [TestController] }).compile();
    app = mod.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('liveness and readiness (real DB round-trip)', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
    const ready = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(ready.body).toEqual({ status: 'ok', dbRoundTripMs: expect.any(Number) });
  });

  it('sets security headers and hides framework info', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns a generic message for unexpected errors and leaks nothing', async () => {
    const res = await request(app.getHttpServer()).get('/v1/_test/boom').expect(500);
    expect(res.body.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|hunter2|secret\.ts|stack/i);
    expect(res.body.requestId).toBeDefined();
  });

  it('maps database unique violations to a safe 409 without schema details', async () => {
    const res = await request(app.getHttpServer()).get('/v1/_test/dup').expect(409);
    expect(JSON.stringify(res.body)).not.toMatch(/"Role"|X_DUP|constraint|23505|INSERT/i);
  });

  it('passes through client (4xx) errors', async () => {
    const res = await request(app.getHttpServer()).get('/v1/_test/bad').expect(400);
    expect(res.body.message).toBe('Invalid thing');
  });

  it('rejects unknown properties and bad types (mass-assignment / validation)', async () => {
    await request(app.getHttpServer()).post('/v1/_test/dto').send({ name: 'a', qty: 1, isAdmin: true }).expect(400);
    await request(app.getHttpServer()).post('/v1/_test/dto').send({ name: 'a', qty: -1 }).expect(400);
    await request(app.getHttpServer()).post('/v1/_test/dto').send({ name: 'a', qty: '5' }).expect(400);
    const ok = await request(app.getHttpServer()).post('/v1/_test/dto').send({ name: 'a', qty: 5 }).expect(201);
    expect(ok.body.ok).toBe(true);
  });

  it('rejects oversized bodies', async () => {
    await request(app.getHttpServer()).post('/v1/_test/dto').send({ name: 'x'.repeat(300_000), qty: 1 }).expect(413);
  });

  it('does not allow cross-origin browser access by default', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate limits excessive requests (429)', async () => {
    let limited = 0;
    for (let i = 0; i < 130; i++) {
      const r = await request(app.getHttpServer()).get('/v1/_test/bad');
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('never leaks a stack trace or path for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/v1/nope').expect((r) => expect([404, 429]).toContain(r.status));
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|\.ts:/);
  });
});
