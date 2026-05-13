import { sanitizeLogValue } from '../sanitize';

describe('sanitizeLogValue', () => {
  it('redacts secret-like keys recursively', () => {
    const out = sanitizeLogValue({
      password: 'secret',
      nested: { accessToken: 'abc', visible: 'ok' },
      headers: { Authorization: 'Bearer token' },
    }) as any;

    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.accessToken).toBe('[REDACTED]');
    expect(out.nested.visible).toBe('ok');
    expect(out.headers.Authorization).toBe('[REDACTED]');
  });

  it('handles circular values and limits long strings', () => {
    const input: any = { value: 'x'.repeat(9000) };
    input.self = input;

    const out = sanitizeLogValue(input) as any;

    expect(out.self).toBe('[Circular]');
    expect(out.value.length).toBeLessThan(9000);
    expect(out.value).toContain('[truncated');
  });
});
