import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
/** Route needs no access token (login, password reset, health…). Use sparingly. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
