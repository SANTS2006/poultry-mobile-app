import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

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

export class ResetPasswordDto extends TokenDto {
  @IsString() @MaxLength(128) newPassword!: string;
}

export class AcceptInviteDto extends TokenDto {
  @IsString() @MaxLength(128) password!: string;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 100) fullName?: string;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(128) currentPassword!: string;
  @IsString() @MaxLength(128) newPassword!: string;
}
