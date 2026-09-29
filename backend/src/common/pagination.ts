import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export interface Page<T> { items: T[]; page: number; limit: number; total: number }

export const paging = (q: PageQuery) => {
  const page = q.page ?? 1;
  const limit = q.limit ?? 25;
  return { page, limit, skip: (page - 1) * limit, take: limit };
};
