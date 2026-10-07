export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  familyId: string;
  roles: string[];
  permissions: string[];
  mfaEnabled: boolean;
}

export interface RequestMeta {
  ip?: string;
  deviceName?: string;
  platform?: string;
  userAgent?: string;
  requestId?: string;
}

export type AuthenticatedRequest = import('express').Request & { user: AuthUser; id?: string };
