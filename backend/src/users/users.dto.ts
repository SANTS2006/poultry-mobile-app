import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEmail, IsEnum, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { UserStatus } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class InviteUserDto {
  @Transform(trimLower) @IsEmail() @MaxLength(254) email!: string;
  @Transform(trim) @IsString() @Length(2, 100) fullName!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) phone?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @ArrayUnique() @IsString({ each: true }) @MaxLength(40, { each: true }) roleCodes!: string[];
}

export class SetRolesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @ArrayUnique() @IsString({ each: true }) @MaxLength(40, { each: true }) roleCodes!: string[];
  @Transform(trim) @IsString() @Length(5, 300) reason!: string;
}

export class ReasonDto {
  @Transform(trim) @IsString() @Length(5, 300) reason!: string;
}

export class ListUsersQuery {
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class SetRolePermissionsDto {
  @IsArray() @ArrayMaxSize(200) @ArrayUnique() @IsString({ each: true }) @MaxLength(60, { each: true }) permissionCodes!: string[];
  @Transform(trim) @IsString() @Length(5, 300) reason!: string;
}
