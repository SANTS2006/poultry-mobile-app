import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

// OWASP-recommended Argon2id minimum profile: m=19 MiB, t=2, p=1.
const OPTIONS: argon2.HashOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

@Injectable()
export class PasswordService {
  // Verified against this hash when the account doesn't exist, so login timing doesn't reveal valid emails.
  private dummyHash: Promise<string> = argon2.hash('dummy-password-for-timing-equalisation', OPTIONS);

  hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash ?? (await this.dummyHash), password).then((ok) => (hash ? ok : false));
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, OPTIONS);
  }
}
