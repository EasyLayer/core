import { Injectable } from '@nestjs/common';

@Injectable()
export class ArithmeticService {
  constructor() {}

  add(firstAmount: string | bigint | number, secondAmount: string | bigint | number): bigint {
    const result = BigInt(firstAmount) + BigInt(secondAmount);
    return result;
  }

  subtract(firstAmount: string | bigint | number, secondAmount: string | bigint | number): bigint {
    const result = BigInt(firstAmount) - BigInt(secondAmount);
    return result;
  }

  multiply(firstAmount: string | bigint | number, secondAmount: string | bigint | number): bigint {
    const result = BigInt(firstAmount) * BigInt(secondAmount);
    return result;
  }

  divide(firstAmount: string | bigint | number, secondAmount: string | bigint | number): bigint {
    if (BigInt(secondAmount) === BigInt(0)) {
      throw new Error('Division by zero is not allowed.');
    }
    const result = BigInt(firstAmount) / BigInt(secondAmount);
    return result;
  }
}
