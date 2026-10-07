import { SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '../../common/permissions';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const ANY_AUTHENTICATED = 'anyAuthenticated';

/** The caller must hold ALL listed permissions (checked server-side on every request). */
export const RequirePermissions = (...permissions: PermissionCode[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Explicit opt-in for endpoints that need only a valid session (e.g. "my profile"). Routes with neither this nor
 * @RequirePermissions nor @Public are DENIED — authorization is deny-by-default.
 */
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED, true);
