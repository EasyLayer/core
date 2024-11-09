import { executeWithRetry, executeWithSkip, ofType, ExecuteParams } from '../operators';
import { of } from 'rxjs';
import { IEvent } from '@nestjs/cqrs';

class MockEvent implements IEvent {
  constructor(public readonly id: string) {}
}

describe('Saga RxJS Operators', () => {
  describe('executeWithRetry', () => {
    it('should retry the command on error and eventually succeed', (done) => {
      const command = jest
        .fn()
        .mockRejectedValueOnce(new Error('first error'))
        .mockRejectedValueOnce(new Error('second error'))
        .mockResolvedValue('success');

      const params: ExecuteParams<MockEvent> = {
        event: MockEvent,
        command,
      };

      const source = of(new MockEvent('1'));
      const result = source.pipe(executeWithRetry(params, 1));

      result.subscribe({
        next: (value) => {
          expect(value).toEqual(new MockEvent('1'));
        },
        error: () => {
          // This block should not be called in this test case
          fail('Expected successful completion, but got an error');
        },
        complete: () => {
          // Check that the command was called three times
          expect(command).toHaveBeenCalledTimes(3);
          done();
        },
      });
    });
  });

  describe('executeWithSkip', () => {
    it('should skip the error and continue', (done) => {
      const command = jest.fn().mockRejectedValue(new Error('error'));

      const params: ExecuteParams<MockEvent> = {
        event: MockEvent,
        command,
      };

      const source = of(new MockEvent('1'));
      const result = source.pipe(executeWithSkip(params));

      let nextCalled = false;

      result.subscribe({
        next: (value) => {
          expect(value).toEqual(new MockEvent('1'));
          nextCalled = true;
        },
        error: () => {
          fail('Expected successful completion, but got an error');
        },
        complete: () => {
          expect(nextCalled).toBe(true);
          expect(command).toHaveBeenCalledTimes(1);
          done();
        },
      });
    });
  });

  // describe('executeWithRollback', () => {
  //     it('should call rollback on error and retry a specified number of times', (done) => {
  //       const command = jest.fn().mockRejectedValue(new Error('error'));
  //       const rollback = jest.fn().mockResolvedValue(undefined);

  //       const params: ExecuteWithRollbackParams<MockEvent> = {
  //         event: MockEvent,
  //         command,
  //         rollback,
  //         retryOpt: { count: 2, delay: 1 },
  //       };

  //       const source = of(new MockEvent('1'));
  //       const result = source.pipe(executeWithRollback(params));

  //       result.subscribe({
  //         next: () => {
  //             fail('Expected error, but got success');
  //         },
  //         error: () => {
  //             expect(command).toHaveBeenCalledTimes(1);
  //             expect(rollback).toHaveBeenCalledTimes(1);
  //         },
  //         complete: () => {
  //           expect(rollback).toHaveBeenCalledTimes(3);
  //           done();
  //         },
  //       });
  //     });
  //   });

  describe('ofType', () => {
    it('should filter events of specified type', (done) => {
      const events = [new MockEvent('1'), { id: '2', type: 'not-mock-event' }];

      const source = of(...events);
      const result = source.pipe(ofType(MockEvent));

      const expected = [new MockEvent('1')];
      const actual: MockEvent[] = [];

      result.subscribe({
        next: (event) => {
          actual.push(event);
        },
        complete: () => {
          expect(actual).toEqual(expected);
          done();
        },
      });
    });
  });
});
