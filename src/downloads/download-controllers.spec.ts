import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { DownloadJobsController } from './download-jobs.controller';
import { DownloadController } from './download.controller';

// The OpenAPI contract documents 200 for these POST actions; Nest would
// otherwise answer 201 and the published contract would not match the wire.
describe('download POST endpoints status code', () => {
  it.each([
    [DownloadJobsController, 'create'],
    [DownloadJobsController, 'retry'],
    [DownloadJobsController, 'cancel'],
    [DownloadController, 'resolve'],
  ] as const)('%o.%s answers 200 as documented', (controller, method) => {
    const handler: unknown = Object.getOwnPropertyDescriptor(
      controller.prototype,
      method,
    )?.value;

    expect(handler).toBeTypeOf('function');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler as object)).toBe(
      HttpStatus.OK,
    );
  });
});
