import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ProblemDetailsDto } from './contracts';

export type ProblemStatus = 400 | 401 | 404 | 409 | 429 | 500 | 503;

const descriptions: Record<ProblemStatus, string> = {
  400: 'La solicitud no supera la validación.',
  401: 'La capacidad falta, no coincide o ha expirado.',
  404: 'El recurso solicitado no existe.',
  409: 'El estado actual impide completar la operación.',
  429: 'Se superó temporalmente el límite de solicitudes.',
  500: 'El servidor no pudo completar la operación.',
  503: 'La dependencia necesaria no está disponible.',
};

export function ApiProblemResponses(...statuses: ProblemStatus[]) {
  return applyDecorators(
    ApiExtraModels(ProblemDetailsDto),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: descriptions[status],
        content: {
          'application/problem+json': {
            schema: { $ref: getSchemaPath(ProblemDetailsDto) },
          },
        },
      }),
    ),
  );
}
