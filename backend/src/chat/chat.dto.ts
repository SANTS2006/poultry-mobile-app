import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { AVATAR_MAX_CHARS, AVATAR_PATTERN } from '../auth/dto/auth.dto';
import { PageQuery } from '../common/pagination';
import { MAX_ATTACHMENT_BYTES, MAX_GROUP_MEMBERS, MAX_MESSAGE_CHARS } from './chat.constants';

const trim = () => Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
const imageUrl = () => [IsString(), MaxLength(AVATAR_MAX_CHARS), Matches(AVATAR_PATTERN, { message: 'avatar must be a JPEG, PNG or WebP image' })];
const applyAll = (...d: PropertyDecorator[]) => (t: object, k: string | symbol) => d.forEach((x) => x(t, k));

export class UsersQuery extends PageQuery { @IsOptional() @IsString() @MaxLength(80) search?: string }
export class ConversationsQuery extends PageQuery { @IsOptional() @IsString() @MaxLength(80) search?: string }
export class MessagesQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) before?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) limit?: number;
}
export class OpenDirectDto { @IsUUID() userId!: string }
export class CreateGroupDto {
  @trim() @IsString() @MinLength(1) @MaxLength(80) title!: string;
  @IsOptional() @trim() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @applyAll(...imageUrl()) avatar?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_GROUP_MEMBERS) @IsUUID('all', { each: true }) memberIds!: string[];
}
export class UpdateGroupDto {
  @IsOptional() @trim() @IsString() @MinLength(1) @MaxLength(80) title?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @trim() @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @applyAll(...imageUrl()) avatar?: string | null;
}
export class AddMembersDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_GROUP_MEMBERS) @IsUUID('all', { each: true }) userIds!: string[] }
export class SetRoleDto { @IsIn(['ADMIN', 'MEMBER']) role!: 'ADMIN' | 'MEMBER' }
export class MuteDto {
  @IsBoolean() muted!: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(24 * 365) hours?: number;
}
export class SendMessageDto {
  @IsUUID() clientId!: string;
  @IsIn(['TEXT', 'IMAGE', 'FILE']) kind!: 'TEXT' | 'IMAGE' | 'FILE';
  @IsOptional() @IsString() @MaxLength(MAX_MESSAGE_CHARS + 200) body?: string;
  @IsOptional() @IsUUID() replyToId?: string;
  @IsOptional() @IsUUID() attachmentId?: string;
}
export class EditMessageDto { @IsString() @MinLength(1) @MaxLength(MAX_MESSAGE_CHARS + 200) body!: string }
export class ReadDto { @IsInt() @Min(0) upToSeq!: number }
export class ReportDto { @trim() @IsString() @MinLength(3) @MaxLength(500) reason!: string }
export class CreateUploadDto {
  @IsUUID() conversationId!: string;
  @trim() @IsString() @MinLength(1) @MaxLength(200) fileName!: string;
  @IsString() @MaxLength(120) mimeType!: string;
  @IsInt() @Min(1) @Max(MAX_ATTACHMENT_BYTES) sizeBytes!: number;
}
export class BlockDto { @IsUUID() userId!: string }
export class ChatSettingsDto {
  @IsOptional() @IsBoolean() showPreviews?: boolean;
  @IsOptional() @IsBoolean() pushMessages?: boolean;
  @IsOptional() @IsBoolean() pushCalls?: boolean;
}
export class StartCallDto {
  @IsUUID() conversationId!: string;
  @IsEnum({ AUDIO: 'AUDIO', VIDEO: 'VIDEO' }) kind!: 'AUDIO' | 'VIDEO';
}
