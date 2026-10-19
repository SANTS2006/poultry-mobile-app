import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import type { Env } from '../config/env';

export interface GoogleIdentity { email: string; emailVerified: boolean }

/** Checks a Google ID token (signature, expiry, issuer and that it was issued for OUR app) and says whose it is. Nothing else is trusted from the phone. */
@Injectable()
export class GoogleIdentityService {
  private readonly client = new OAuth2Client();
  constructor(@Inject(ConfigService) private readonly config: ConfigService<Env, true>) {}

  private get audiences(): string[] { return (this.config.get('GOOGLE_CLIENT_IDS', { infer: true }) ?? '').split(',').map((s: string) => s.trim()).filter(Boolean); }
  get enabled(): boolean { return this.audiences.length > 0; }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!this.enabled) throw new ServiceUnavailableException('Google sign-in is not set up on the server.');
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.audiences });
      const p = ticket.getPayload();
      if (!p?.email) throw new Error('no email');
      return { email: p.email.trim().toLowerCase(), emailVerified: p.email_verified === true };
    } catch {
      throw new UnauthorizedException('Google sign-in could not be verified. Please try again.');
    }
  }
}
