import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { API_CACHE_CONTROL, NoStoreInterceptor } from './no-store.interceptor';

describe('NoStoreInterceptor', () => {
  it('marks every controller response private and non-cacheable', () => {
    const header = vi.fn();
    const context = {
      switchToHttp: () => ({ getResponse: () => ({ header }) }),
    } as unknown as ExecutionContext;
    const next = {
      handle: vi.fn(() => of({ ok: true })),
    } as unknown as CallHandler;

    const response = new NoStoreInterceptor().intercept(context, next);

    expect(header).toHaveBeenCalledWith('Cache-Control', API_CACHE_CONTROL);
    expect(response).toBeDefined();
  });
});
