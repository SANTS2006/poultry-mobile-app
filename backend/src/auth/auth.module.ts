import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PasswordHistoryService } from './password-history.service';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from '../common/crypto/password.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import type { Env } from '../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailTokenService } from './email-token.service';
import { AuthenticationService, JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    PasswordService, EncryptionService, TokenService, SessionService, MfaService, EmailTokenService, PasswordResetService, PasswordHistoryService,
    AuthService, AuthenticationService, JwtAuthGuard, PermissionsGuard,
  ],
  exports: [PasswordService, EncryptionService, TokenService, SessionService, MfaService, EmailTokenService, PasswordResetService, PasswordHistoryService, AuthService, AuthenticationService, JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}
