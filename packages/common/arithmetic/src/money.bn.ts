import BN from 'bn.js';

export interface Currency {
  code: string;
  minorUnit: number;
}

export interface FormatOptions {
  minFractionDigits?: number;
  maxFractionDigits?: number;
  removeTrailingFractionalZeros?: boolean;
  decimalSeparator?: string;
  groupSeparator?: string;
  groupSize?: number;
  secondaryGroupSize?: number;
  fractionGroupSeparator?: string;
  fractionGroupSize?: number;
}

interface MoneyJSON {
  amount: string;
  currency: Currency;
}

const assertSameCurrency = (a: Money, b: Money): void => {
  if (a.currency.code !== b.currency.code) {
    throw new Error('Different currencies');
  }
};

export const defaultFormatOptions: Required<FormatOptions> = {
  minFractionDigits: 2,
  maxFractionDigits: 20,
  removeTrailingFractionalZeros: true,
  decimalSeparator: '.',
  groupSeparator: ',',
  groupSize: 3,
  secondaryGroupSize: 0,
  fractionGroupSeparator: ' ',
  fractionGroupSize: 0,
};

export class Money {
  amount: BN;
  currency: Currency;

  constructor(amount: BN, currency: Currency) {
    this.amount = amount;
    this.currency = currency;
  }

  static fromCents(cents: string, currency: Currency): Money {
    return new Money(new BN(cents).div(new BN(`1e${currency.minorUnit}`)), currency);
  }

  static fromDecimal(amount: string, currency: Currency): Money {
    return new Money(new BN(amount), currency);
  }

  toString(): string {
    return this.amount.toString();
  }

  toJSON(): MoneyJSON {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toCents(): string {
    return this.amount.mul(new BN(`1e${this.currency.minorUnit}`)).toString();
  }

  convert(rate: string, toCurrency: Currency): Money {
    return new Money(this.amount.mul(new BN(rate)), toCurrency);
  }

  add(money: Money): Money {
    assertSameCurrency(this, money);
    return new Money(this.amount.add(money.amount), this.currency);
  }

  subtract(money: Money): Money {
    assertSameCurrency(this, money);
    return new Money(this.amount.sub(money.amount), this.currency);
  }

  multiply(multiplier: string): Money {
    return new Money(this.amount.mul(new BN(multiplier)), this.currency);
  }

  divide(divisor: string): Money {
    return new Money(this.amount.div(new BN(divisor)), this.currency);
  }

  compare(money: Money): number {
    assertSameCurrency(this, money);
    return this.amount.cmp(money.amount);
  }

  equals(money: Money): boolean {
    return this.compare(money) === 0;
  }

  greaterThan(money: Money): boolean {
    return this.compare(money) > 0;
  }

  greaterThanOrEqual(money: Money): boolean {
    return this.compare(money) >= 0;
  }

  lessThan(money: Money): boolean {
    return this.compare(money) < 0;
  }

  lessThanOrEqual(money: Money): boolean {
    return this.compare(money) <= 0;
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.isNeg() === false;
  }

  isNegative(): boolean {
    return this.amount.isNeg();
  }
}
