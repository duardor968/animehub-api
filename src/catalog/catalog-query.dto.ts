import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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
  @MaxLength(40)
  order?: string;

  @IsOptional()
  @IsString()
  @Length(1, 1)
  letter?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string;

  @IsOptional()
  @Transform(toStringArray)
  @IsString({ each: true })
  genre?: string[];

  @IsOptional()
  @Transform(toStringArray)
  @IsString({ each: true })
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
