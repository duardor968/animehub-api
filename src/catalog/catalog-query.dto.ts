import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const catalogOrderValues = [
  'score',
  'popular',
  'title',
  'latest_added',
  'latest_released',
] as const;

export const catalogStatusValues = [
  'emision',
  'finalizado',
  'proximamente',
] as const;

const toStringArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]).map(String);
};

export class CatalogQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  page = 1;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsString()
  @IsIn(catalogOrderValues)
  order?: string;

  @IsOptional()
  @IsString()
  @Length(1, 1)
  letter?: string;

  @IsOptional()
  @IsString()
  @IsIn(catalogStatusValues)
  status?: string;

  @IsOptional()
  @Transform(toStringArray)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  genre?: string[];

  @IsOptional()
  @Transform(toStringArray)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  category?: string[];

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1900)
  @Max(2200)
  minYear?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1900)
  @Max(2200)
  maxYear?: number;
}

export class SuggestionQueryDto {
  @IsString()
  @Length(2, 100)
  q!: string;
}
