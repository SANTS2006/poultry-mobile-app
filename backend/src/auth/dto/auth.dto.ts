import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class LoginDto {
  @Transform(trimLower) @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

export class RefreshDto {
  @IsString() @Length(20, 200) refreshToken!: string;
}

export class MfaLoginDto {
  @IsString() @Length(20, 2000) mfaToken!: string;
  @IsOptional() @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code?: string;
  @IsOptional() @IsString() @Length(8, 32) recoveryCode?: string;
}

export class MfaConfirmDto {
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code!: string;
}

export class StepUpDto {
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code!: string;
}

export class EmailOnlyDto {
  @Transform(trimLower) @IsEmail() @MaxLength(254) email!: string;
}

export class TokenDto {
  @IsString() @Length(20, 200) token!: string;
}

export class ResetPasswordDto {
  @Transform(trimLower) @IsEmail() @MaxLength(254) email!: string;
  /** 8 digits; spaces are ignored (the e-mail shows them in two groups of four) */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/\s+/g, '') : value)) @Matches(/^\d{8}$/, { message: 'code must be 8 digits' }) code!: string;
  @IsString() @MaxLength(128) newPassword!: string;
}

export class FirstPasswordDto {
  @IsString() @Length(20, 2000) passwordToken!: string;
  @IsString() @MaxLength(128) newPassword!: string;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(128) currentPassword!: string;
  @IsString() @MaxLength(128) newPassword!: string;
}

/** Image data URL, at most ~150 KB of text. The client resizes to a small square first; the server only enforces type and size. */
export const AVATAR_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const AVATAR_MAX_CHARS = 200_000;

export class UpdateProfileDto {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 100) fullName?: string;
  /** null removes the picture */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(AVATAR_MAX_CHARS) @Matches(AVATAR_PATTERN, { message: 'avatar must be a JPEG, PNG or WebP image' }) avatar?: string | null;
}

export class ChangeEmailDto {
  @Transform(trimLower) @IsEmail() @MaxLength(254) newEmail!: string;
  @IsString() @MinLength(1) @MaxLength(128) currentPassword!: string;
}
